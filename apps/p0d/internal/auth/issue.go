package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AdministrativeScopes is AuthAdministrativeClientScopes in packages/contracts/src/auth.ts,
// what the Node server grants a desktop-bootstrap credential.
var AdministrativeScopes = []string{
	"orchestration:read", "orchestration:operate", "settings:write", "providers:manage",
	"environment:maintain", "preview:operate", "diagnostics:read", "terminal:read",
	"terminal:operate", "source-control:write", "filesystem:read", "filesystem:write",
	"relay:read", "access:read", "access:write", "relay:write", "relay:configure",
}

// DesktopSubject is the subject of sessions issued for the desktop bootstrap secret.
const DesktopSubject = "desktop-bootstrap"

const defaultSessionTTL = 30 * 24 * time.Hour

// ErrStateUninitialized means the legacy server has not created statev2.sqlite and its
// auth_sessions table yet; its migrations own the schema.
var ErrStateUninitialized = errors.New("state database is not initialized")

// ClientMetadata is AuthClientMetadata; empty strings are stored as NULL.
type ClientMetadata struct {
	Label, IPAddress, UserAgent, DeviceType, OS, Browser string
}

// Issued is a minted session, as SessionStore.issue returns it.
type Issued struct {
	SessionID string
	Token     string
	Scopes    []string
	ExpiresAt time.Time
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// IssueDesktopSession mirrors exchanging a desktop-bootstrap grant without DPoP: a 30 day
// bearer session that revokes the subject's earlier live bearer sessions in the same
// transaction (replaceActiveForSubjectAndMethod).
func (a *Authenticator) IssueDesktopSession(client ClientMetadata) (*Issued, error) {
	db, err := a.writer()
	if err != nil {
		return nil, err
	}
	key, err := a.issuingKey()
	if err != nil {
		return nil, err
	}
	const method = "bearer-access-token"
	now := a.Now()
	expiresAt := now.Add(defaultSessionTTL)
	sessionID := uuid.NewString()
	if client.DeviceType == "" {
		client.DeviceType = "unknown"
	}
	claims, _ := json.Marshal(map[string]any{
		"v": 1, "kind": "session", "sid": sessionID, "sub": DesktopSubject, "scopes": AdministrativeScopes,
		"method": method, "iat": now.UnixMilli(), "exp": expiresAt.UnixMilli(),
	})
	payload := b64url(claims)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	token := payload + "." + b64url(mac.Sum(nil))
	scopes, _ := json.Marshal(AdministrativeScopes)

	tx, err := db.Begin()
	if err != nil {
		return nil, stateError(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE auth_sessions SET revoked_at = ?
		WHERE subject = ? AND method = ? AND revoked_at IS NULL AND expires_at > ?`,
		iso(now), DesktopSubject, method, iso(now)); err != nil {
		return nil, stateError(err)
	}
	if _, err := tx.Exec(`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label,
		client_ip_address, client_user_agent, client_device_type, client_os, client_browser,
		issued_at, expires_at, revoked_at, proof_key_thumbprint)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		sessionID, DesktopSubject, string(scopes), method, nullable(client.Label), nullable(client.IPAddress),
		nullable(client.UserAgent), client.DeviceType, nullable(client.OS), nullable(client.Browser),
		iso(now), iso(expiresAt)); err != nil {
		return nil, stateError(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, stateError(err)
	}
	return &Issued{SessionID: sessionID, Token: token, Scopes: AdministrativeScopes, ExpiresAt: expiresAt}, nil
}

func stateError(err error) error {
	if strings.Contains(err.Error(), "no such table") {
		return ErrStateUninitialized
	}
	return err
}

// writer opens statev2.sqlite read-write on first use. It never creates the file.
func (a *Authenticator) writer() (*sql.DB, error) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	if a.rw != nil {
		return a.rw, nil
	}
	dbPath := filepath.Join(a.Home, "statev2.sqlite")
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		return nil, ErrStateUninitialized
	}
	// BEGIN IMMEDIATE takes the write lock up front, so busy_timeout covers the whole
	// transaction while the legacy server writes too.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=rw&_txlock=immediate&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	a.rw = db
	return db, nil
}

// issuingKey is signingKey, creating the key like ServerSecretStore.getOrCreateRandom
// when the file backend has none yet. A keychain-backed home must already hold one.
func (a *Authenticator) issuingKey() ([]byte, error) {
	key, err := a.signingKey()
	if !errors.Is(err, errSecretMissing) {
		return key, err
	}
	if _, statErr := os.Stat(filepath.Join(a.secretsDir, keychainMarkerFile)); statErr == nil {
		return nil, fmt.Errorf("%s is missing from the OS keychain", signingSecretName)
	}
	fresh := make([]byte, 32)
	rand.Read(fresh)
	if err := createSecretFile(a.secretsDir, signingSecretName, fresh); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	return a.signingKey()
}

// createSecretFile mirrors ServerSecretStore.create: write a temp file, then hard-link
// it into place, so a concurrent reader never sees a partial key and a racing creator
// gets os.ErrExist.
func createSecretFile(secretsDir, name string, value []byte) error {
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		return err
	}
	tmp := filepath.Join(secretsDir, name+".bin."+uuid.NewString()+".tmp")
	defer os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(value)
	if serr := f.Sync(); err == nil {
		err = serr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Link(tmp, filepath.Join(secretsDir, name+".bin"))
}
