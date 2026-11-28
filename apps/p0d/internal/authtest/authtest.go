// Package authtest builds throwaway homes with the legacy server's auth state, for tests.
package authtest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// AllScopes is what a fully privileged client holds.
var AllScopes = []string{"orchestration:read", "orchestration:operate", "terminal:operate", "access:read", "access:write"}

// Home is a temp <base>/userdata folder with a signing key and an auth_sessions table.
type Home struct {
	Dir string
	Key []byte
	db  *sql.DB
}

// New creates the home. The schema matches apps/server's auth_sessions.
func New(t testing.TB) *Home {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "userdata")
	if err := os.MkdirAll(filepath.Join(dir, "secrets"), 0o700); err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	rand.Read(key)
	if err := os.WriteFile(filepath.Join(dir, "secrets", "server-signing-key.bin"), key, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "statev2.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(SessionsSchema); err != nil {
		t.Fatal(err)
	}
	return &Home{Dir: dir, Key: key, db: db}
}

// SessionsSchema matches apps/server's auth_sessions.
const SessionsSchema = `CREATE TABLE auth_sessions (
	session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL, method TEXT NOT NULL,
	client_label TEXT, client_ip_address TEXT, client_user_agent TEXT,
	client_device_type TEXT NOT NULL DEFAULT 'unknown', client_os TEXT, client_browser TEXT,
	issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT, revoked_at TEXT,
	client_surface TEXT, client_app_version TEXT, proof_key_thumbprint TEXT)`

// Row is a stored session, for assertions.
type Row struct {
	Subject, Method, Scopes, DeviceType  string
	Label, IPAddress, UserAgent, OS      sql.NullString
	Browser, RevokedAt, ProofKeyThumbprt sql.NullString
}

// Session reads a session row.
func (h *Home) Session(t testing.TB, sessionID string) Row {
	t.Helper()
	var r Row
	err := h.db.QueryRow(`SELECT subject, method, scopes, client_device_type, client_label, client_ip_address,
		client_user_agent, client_os, client_browser, revoked_at, proof_key_thumbprint
		FROM auth_sessions WHERE session_id = ?`, sessionID).
		Scan(&r.Subject, &r.Method, &r.Scopes, &r.DeviceType, &r.Label, &r.IPAddress, &r.UserAgent, &r.OS, &r.Browser, &r.RevokedAt, &r.ProofKeyThumbprt)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// LiveSessions counts unrevoked sessions for subject.
func (h *Home) LiveSessions(t testing.TB, subject string) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM auth_sessions WHERE subject = ? AND revoked_at IS NULL`, subject).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// WriteDesktopSecret writes a fresh mode-0600 desktop secret file and returns its path
// and contents.
func (h *Home) WriteDesktopSecret(t testing.TB) (path, secret string) {
	t.Helper()
	raw := make([]byte, 32)
	rand.Read(raw)
	secret = base64.RawURLEncoding.EncodeToString(raw)
	path = filepath.Join(filepath.Dir(h.Dir), "desktop-secret")
	if err := os.WriteFile(path, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path, secret
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// AddSession inserts a live session row.
func (h *Home) AddSession(t testing.TB, sessionID, subject string, scopes []string, jkt string) {
	t.Helper()
	scopesJSON, _ := json.Marshal(scopes)
	var thumb any
	if jkt != "" {
		thumb = jkt
	}
	now := time.Now()
	_, err := h.db.Exec(`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, proof_key_thumbprint)
		VALUES (?, ?, ?, 'bearer-access-token', ?, ?, ?)`,
		sessionID, subject, string(scopesJSON), iso(now), iso(now.Add(30*24*time.Hour)), thumb)
	if err != nil {
		t.Fatal(err)
	}
}

// Revoke marks a session revoked.
func (h *Home) Revoke(t testing.TB, sessionID string) {
	t.Helper()
	if _, err := h.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?`, iso(time.Now()), sessionID); err != nil {
		t.Fatal(err)
	}
}

// Sign produces "<base64url claims>.<base64url HMAC-SHA256>", the legacy token format.
func (h *Home) Sign(claims map[string]any) string {
	payload, _ := json.Marshal(claims)
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, h.Key)
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// SessionToken mints a bearer token for sessionID that expires in ttl.
func (h *Home) SessionToken(sessionID, subject string, ttl time.Duration, jkt string) string {
	now := time.Now()
	claims := map[string]any{
		"v": 2, "kind": "session", "sid": sessionID, "sub": subject, "scopes": AllScopes,
		"method": "bearer-access-token", "iat": now.UnixMilli(), "exp": now.Add(ttl).UnixMilli(),
	}
	if jkt != "" {
		claims["jkt"] = jkt
		claims["method"] = "dpop-access-token"
	}
	return h.Sign(claims)
}

// Ticket mints a WebSocket ticket for sessionID.
func (h *Home) Ticket(sessionID, audience, jkt string) string {
	now := time.Now()
	claims := map[string]any{"v": 1, "kind": "websocket", "sid": sessionID, "iat": now.UnixMilli(), "exp": now.Add(5 * time.Minute).UnixMilli()}
	if audience != "" {
		claims["aud"] = audience
	}
	if jkt != "" {
		claims["jkt"] = jkt
	}
	return h.Sign(claims)
}

// DpopKey is a client's P-256 proof key.
type DpopKey struct {
	priv       *ecdsa.PrivateKey
	jwk        map[string]string
	Thumbprint string
}

// NewDpopKey generates a key and its RFC 7638 thumbprint.
func NewDpopKey() *DpopKey {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub, _ := priv.PublicKey.Bytes() // 0x04 || X || Y
	x := base64.RawURLEncoding.EncodeToString(pub[1:33])
	y := base64.RawURLEncoding.EncodeToString(pub[33:])
	sum := sha256.Sum256([]byte(`{"crv":"P-256","kty":"EC","x":"` + x + `","y":"` + y + `"}`))
	return &DpopKey{
		priv:       priv,
		jwk:        map[string]string{"kty": "EC", "crv": "P-256", "x": x, "y": y},
		Thumbprint: base64.RawURLEncoding.EncodeToString(sum[:]),
	}
}

// Proof signs a DPoP proof for method and htu, bound to accessToken when set.
func (k *DpopKey) Proof(method, htu, accessToken string) string {
	header, _ := json.Marshal(map[string]any{"typ": "dpop+jwt", "alg": "ES256", "jwk": k.jwk})
	jti := make([]byte, 12)
	rand.Read(jti)
	claims := map[string]any{"htm": method, "htu": htu, "jti": base64.RawURLEncoding.EncodeToString(jti), "iat": time.Now().Unix()}
	if accessToken != "" {
		sum := sha256.Sum256([]byte(accessToken))
		claims["ath"] = base64.RawURLEncoding.EncodeToString(sum[:])
	}
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	r, s, _ := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}
