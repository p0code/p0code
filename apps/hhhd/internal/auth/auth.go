// Package auth validates the session credentials the legacy server issues, reading
// the same signing key and auth_sessions table. Issuing, pairing and renewal still
// happen in the legacy server.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	signingSecretName = "server-signing-key"
	mcpClientSubject  = "mcp-client"
	devSessionPrefix  = "dev-auth-"
	sessionCookieBase = "t3_session"
)

// desktopRendererOrigins mirrors DESKTOP_RENDERER_ORIGINS in apps/server/src/httpCors.ts.
var desktopRendererOrigins = []string{"hhhcode://app", "hhhcode-dev://app", "t3code://app", "t3code-dev://app"}

// Session is an authenticated client session.
type Session struct {
	SessionID          string
	Subject            string
	Method             string
	Scopes             []string
	ProofKeyThumbprint string
}

// Error is a rejected credential (HTTP 401) unless Internal is set (HTTP 500).
type Error struct {
	Reason            string // missing_credential | invalid_credential
	DpopFailureReason string
	Diagnostic        string
	Internal          bool
}

func (e *Error) Error() string {
	if e.Diagnostic != "" {
		return e.Diagnostic
	}
	return e.Reason
}

func invalid(diagnostic string) *Error {
	return &Error{Reason: "invalid_credential", Diagnostic: diagnostic}
}

func internal(err error) *Error {
	return &Error{Reason: "internal_error", Diagnostic: err.Error(), Internal: true}
}

// Authenticator checks credentials against the legacy server's state in Home.
type Authenticator struct {
	Home       string
	CookieName string
	// LegacyCookieName is only set for remote-reachable listeners.
	LegacyCookieName string
	TrustedOrigins   map[string]bool
	Now              func() time.Time

	db         *sql.DB
	secretsDir string
	keyMu      sync.Mutex
	key        []byte
}

// New opens the state database read-only. It need not exist yet.
func New(home string) (*Authenticator, error) {
	dbPath := filepath.Join(home, "statev2.sqlite")
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	origins := map[string]bool{}
	for _, o := range desktopRendererOrigins {
		origins[o] = true
	}
	return &Authenticator{
		Home:           home,
		TrustedOrigins: origins,
		Now:            time.Now,
		db:             db,
		secretsDir:     filepath.Join(home, "secrets"),
	}, nil
}

func (a *Authenticator) Close() error { return a.db.Close() }

// CookieName mirrors resolveSessionCookieName for "web" mode.
func CookieName(port int, host, instanceKey, environmentID string) (name, legacy string) {
	if isRemoteReachable(host) {
		sum := sha256.Sum256([]byte(environmentID))
		return sessionCookieBase + "_" + hex.EncodeToString(sum[:])[:12], sessionCookieBase
	}
	sum := sha256.Sum256([]byte(instanceKey))
	return fmt.Sprintf("%s_%d_%s", sessionCookieBase, port, hex.EncodeToString(sum[:])[:12]), ""
}

func isRemoteReachable(host string) bool {
	// Only a loopback literal or localhost stays local; an empty host listens everywhere.
	h := strings.ToLower(strings.Trim(host, "[]"))
	if h == "localhost" || h == "::1" {
		return false
	}
	ip := net.ParseIP(h)
	return ip == nil || strings.Contains(h, ":") || !strings.HasPrefix(h, "127.")
}

func (a *Authenticator) signingKey() ([]byte, error) {
	a.keyMu.Lock()
	defer a.keyMu.Unlock()
	if a.key != nil {
		return a.key, nil
	}
	key, err := readSecret(a.secretsDir, signingSecretName)
	if err != nil {
		return nil, err
	}
	a.key = key
	return key, nil
}

// verifySigned checks "<base64url payload>.<base64url HMAC-SHA256>" and decodes the payload.
func (a *Authenticator) verifySigned(token string, claims any) *Error {
	payload, signature, ok := strings.Cut(token, ".")
	if !ok || payload == "" || signature == "" || strings.Contains(signature, ".") {
		return invalid("Malformed token.")
	}
	key, err := a.signingKey()
	if errors.Is(err, errSecretMissing) {
		return invalid("No sessions have been issued on this server.")
	}
	if err != nil {
		return internal(err)
	}
	sig, err := decodeB64url(signature)
	if err != nil {
		return invalid("Invalid token signature.")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return invalid("Invalid token signature.")
	}
	raw, err := decodeB64url(payload)
	if err != nil || json.Unmarshal(raw, claims) != nil {
		return invalid("Invalid token payload.")
	}
	return nil
}

type sessionRow struct {
	subject   string
	method    string
	scopes    []string
	expiresAt time.Time
	revoked   bool
	jkt       string
}

func (a *Authenticator) loadRow(sessionID string) (*sessionRow, *Error) {
	var (
		row                          sessionRow
		scopes, expires              string
		revokedAt, proofKeyThumbprnt sql.NullString
	)
	err := a.db.QueryRow(`SELECT subject, method, scopes, expires_at, revoked_at, proof_key_thumbprint
		FROM auth_sessions WHERE session_id = ?`, sessionID).
		Scan(&row.subject, &row.method, &scopes, &expires, &revokedAt, &proofKeyThumbprnt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, invalid("Unknown session.")
	}
	if err != nil {
		return nil, internal(err)
	}
	if err := json.Unmarshal([]byte(scopes), &row.scopes); err != nil {
		return nil, internal(fmt.Errorf("session %s scopes: %w", sessionID, err))
	}
	if row.expiresAt, err = time.Parse(time.RFC3339Nano, expires); err != nil {
		return nil, internal(fmt.Errorf("session %s expiry: %w", sessionID, err))
	}
	row.revoked = revokedAt.Valid
	row.jkt = proofKeyThumbprnt.String
	return &row, nil
}

func (a *Authenticator) nowMillis() float64 { return float64(a.Now().UnixMilli()) }

// VerifySessionToken mirrors SessionStore.verify (without the reusable dev token).
func (a *Authenticator) VerifySessionToken(token string) (*Session, *Error) {
	var claims struct {
		V      int      `json:"v"`
		Kind   string   `json:"kind"`
		Sid    string   `json:"sid"`
		Sub    string   `json:"sub"`
		Method string   `json:"method"`
		Jkt    string   `json:"jkt"`
		Plk    int      `json:"plk"`
		Exp    *float64 `json:"exp"`
	}
	if err := a.verifySigned(token, &claims); err != nil {
		return nil, err
	}
	if (claims.V != 1 && claims.V != 2) || claims.Kind != "session" || claims.Sid == "" || claims.Exp == nil {
		return nil, invalid("Invalid session token payload.")
	}
	switch claims.Method {
	case "browser-session-cookie", "bearer-access-token", "dpop-access-token":
	default:
		return nil, invalid("Invalid session token payload.")
	}
	// A peer link's row holds its deadline; every other token carries its own.
	rowHoldsDeadline := claims.Plk == 1
	if !rowHoldsDeadline && *claims.Exp <= a.nowMillis() {
		return nil, invalid("Session token expired.")
	}
	row, err := a.loadRow(claims.Sid)
	if err != nil {
		return nil, err
	}
	if row.revoked {
		return nil, invalid("Session token revoked.")
	}
	if rowHoldsDeadline && !row.expiresAt.After(a.Now()) {
		return nil, invalid("Session token expired.")
	}
	return &Session{SessionID: claims.Sid, Subject: claims.Sub, Method: claims.Method, Scopes: row.scopes, ProofKeyThumbprint: claims.Jkt}, nil
}

// VerifyWebSocketTicket mirrors SessionStore.verifyWebSocketToken. audience is "" when
// the ticket names none.
func (a *Authenticator) VerifyWebSocketTicket(ticket string) (*Session, string, *Error) {
	var claims struct {
		V    int      `json:"v"`
		Kind string   `json:"kind"`
		Sid  string   `json:"sid"`
		Aud  string   `json:"aud"`
		Jkt  string   `json:"jkt"`
		Exp  *float64 `json:"exp"`
	}
	if err := a.verifySigned(ticket, &claims); err != nil {
		return nil, "", err
	}
	if claims.V != 1 || claims.Kind != "websocket" || claims.Sid == "" || claims.Exp == nil {
		return nil, "", invalid("Invalid WebSocket ticket payload.")
	}
	if strings.HasPrefix(claims.Sid, devSessionPrefix) {
		return nil, "", invalid("Reusable dev sessions are not supported by hhhd.")
	}
	if *claims.Exp <= a.nowMillis() {
		return nil, "", invalid("WebSocket ticket expired.")
	}
	row, err := a.loadRow(claims.Sid)
	if err != nil {
		return nil, "", err
	}
	if !row.expiresAt.After(a.Now()) {
		return nil, "", invalid("WebSocket session expired.")
	}
	if row.revoked {
		return nil, "", invalid("WebSocket session revoked.")
	}
	return &Session{SessionID: claims.Sid, Subject: row.subject, Method: row.method, Scopes: row.scopes, ProofKeyThumbprint: claims.Jkt}, claims.Aud, nil
}

// RequestURL is the URL the client addressed, as DPoP proofs bind it.
func RequestURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host + r.URL.EscapedPath()
}

func (a *Authenticator) consumeDpop(r *http.Request, proof, thumbprint, accessToken string) *Error {
	result, failure := verifyDpopProof(proof, r.Method, RequestURL(r), a.Now(), thumbprint, accessToken)
	if failure != nil {
		return &Error{Reason: "invalid_credential", DpopFailureReason: failure.wireReason(), Diagnostic: failure.reason}
	}
	sum := sha256.Sum256([]byte(result.thumbprint + ":" + result.jti))
	content := fmt.Sprintf("thumbprint=%s\njti=%s\niat=%d\nconsumedAt=%s", result.thumbprint, result.jti, result.iat,
		a.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	err := createMarker(a.secretsDir, "dpop-proof-"+b64url(sum[:]), []byte(content))
	if errors.Is(err, os.ErrExist) {
		return &Error{Reason: "invalid_credential", DpopFailureReason: "replay", Diagnostic: "DPoP proof replayed."}
	}
	if err != nil {
		return internal(err)
	}
	return nil
}

type credential struct {
	token  string
	cookie bool
}

func (a *Authenticator) selectCredential(r *http.Request) *credential {
	if c, err := r.Cookie(a.CookieName); err == nil && c.Value != "" {
		return &credential{token: c.Value, cookie: true}
	}
	if t := authorizationToken(r, "Bearer "); t != "" {
		return &credential{token: t}
	}
	if t := authorizationToken(r, "DPoP "); t != "" {
		return &credential{token: t}
	}
	if a.LegacyCookieName != "" {
		if c, err := r.Cookie(a.LegacyCookieName); err == nil {
			return &credential{token: c.Value, cookie: true}
		}
	}
	return nil
}

func authorizationToken(r *http.Request, prefix string) string {
	h := r.Header.Get("Authorization")
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// HasCredential reports whether the request carries anything Authenticate* would read.
func (a *Authenticator) HasCredential(r *http.Request) bool {
	return a.selectCredential(r) != nil || strings.TrimSpace(r.URL.Query().Get("wsTicket")) != ""
}

// browserOriginAllowed mirrors isBrowserOriginAllowed: cookies span ports, so cookie
// credentials only count from this server's own origin or a trusted app origin.
func (a *Authenticator) browserOriginAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin" || a.TrustedOrigins[origin] {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	originHost := strings.ToLower(u.Host)
	first := func(v string) string { return strings.ToLower(strings.TrimSpace(strings.Split(v, ",")[0])) }
	return originHost == first(r.Host) || (r.Header.Get("X-Forwarded-Host") != "" && originHost == first(r.Header.Get("X-Forwarded-Host")))
}

// AuthenticateRequest mirrors EnvironmentAuth.authenticateHttpRequest.
func (a *Authenticator) AuthenticateRequest(r *http.Request) (*Session, *Error) {
	cred := a.selectCredential(r)
	if cred == nil || cred.token == "" {
		return nil, &Error{Reason: "missing_credential"}
	}
	if cred.cookie && !a.browserOriginAllowed(r) {
		return nil, invalid("Browser sessions are only accepted from the app's own origin.")
	}
	session, err := a.VerifySessionToken(cred.token)
	if err != nil {
		return nil, err
	}
	if session.Subject == mcpClientSubject {
		return nil, invalid("MCP client sessions are only accepted by the MCP endpoint.")
	}
	dpopToken := authorizationToken(r, "DPoP ")
	if session.ProofKeyThumbprint != "" {
		if dpopToken == "" || dpopToken != cred.token {
			return nil, &Error{Reason: "invalid_credential", DpopFailureReason: "invalid_proof", Diagnostic: "DPoP-bound access token requires DPoP authorization."}
		}
		if err := a.consumeDpop(r, r.Header.Get("DPoP"), session.ProofKeyThumbprint, dpopToken); err != nil {
			return nil, err
		}
	} else if dpopToken != "" {
		return nil, &Error{Reason: "invalid_credential", DpopFailureReason: "invalid_proof", Diagnostic: "DPoP authorization requires a proof-bound access token."}
	}
	return session, nil
}

// AuthenticateWebSocket mirrors EnvironmentAuth.authenticateWebSocketUpgrade. use is
// "rpc" for /ws and "media" for media sockets and streams.
func (a *Authenticator) AuthenticateWebSocket(r *http.Request, use string) (*Session, *Error) {
	query := r.URL.Query()
	ticket := query.Get("wsTicket")
	if strings.TrimSpace(ticket) == "" {
		return a.AuthenticateRequest(r)
	}
	session, audience, err := a.VerifyWebSocketTicket(ticket)
	if err != nil {
		return nil, err
	}
	if session.Subject == mcpClientSubject {
		return nil, invalid("MCP client sessions are only accepted by the MCP endpoint.")
	}
	if audience != "" && audience != use {
		return nil, invalid("WebSocket ticket was issued for the " + audience + " route.")
	}
	if session.ProofKeyThumbprint != "" {
		// Browsers cannot set headers on a WebSocket, so the proof may ride in the query.
		proof := r.Header.Get("DPoP")
		if proof == "" {
			proof = query.Get("dpop")
		}
		if proof == "" {
			return nil, &Error{Reason: "invalid_credential", DpopFailureReason: "invalid_proof", Diagnostic: "DPoP-bound WebSocket ticket requires a DPoP proof."}
		}
		if err := a.consumeDpop(r, proof, session.ProofKeyThumbprint, ticket); err != nil {
			return nil, err
		}
	}
	return session, nil
}

// StillValid reports whether a live socket's session may stay open: not revoked, and
// not expired unless a newer session for the same DPoP key renewed it.
func (a *Authenticator) StillValid(session *Session) (bool, error) {
	row, err := a.loadRow(session.SessionID)
	if err != nil {
		if err.Internal {
			return true, err
		}
		return false, nil
	}
	if row.revoked {
		return false, nil
	}
	if row.expiresAt.After(a.Now()) {
		return true, nil
	}
	jkt := session.ProofKeyThumbprint
	if jkt == "" {
		jkt = row.jkt
	}
	if jkt == "" {
		return false, nil
	}
	var renewed int
	qerr := a.db.QueryRow(`SELECT COUNT(*) FROM auth_sessions
		WHERE proof_key_thumbprint = ? AND revoked_at IS NULL AND expires_at > ?`,
		jkt, a.Now().UTC().Format("2006-01-02T15:04:05.000Z")).Scan(&renewed)
	if qerr != nil {
		return true, qerr
	}
	return renewed > 0, nil
}

// TraceID returns an id for error bodies, like the legacy server's span trace ids.
func TraceID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
