package server

import (
	"bytes"
	"errors"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"p0d/internal/auth"
)

const (
	tokenExchangeGrant  = "urn:ietf:params:oauth:grant-type:token-exchange"
	bootstrapTokenType  = "urn:t3:params:oauth:token-type:environment-bootstrap"
	accessTokenType     = "urn:ietf:params:oauth:token-type:access_token"
	maxTokenRequestBody = 64 << 10
)

var (
	// desktopExchangeFailures bounds wrong tokens per peer address before the native
	// path closes to it for desktopExchangeLockout.
	desktopExchangeFailures = 10
	desktopExchangeWindow   = time.Minute
	desktopExchangeLockout  = time.Minute
)

// serveToken signs the desktop in natively when a loopback client exchanges a token
// derived from --desktop-bootstrap-secret-file. Every other /oauth/token request (pairing
// credentials, renewal, DPoP, scoped requests) goes to the legacy server untouched.
func (s *Server) serveToken(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxTokenRequestBody+1))
	if err != nil {
		return
	}
	r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
	form, ok := desktopExchangeForm(r, body)
	if !ok || !isLoopbackRequest(r) {
		s.serveProxy(w, r)
		return
	}
	peer := clientIP(r)
	now := time.Now()
	if wait := s.desktopFailures.lockedFor(peer, now); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"code": "rate_limited", "message": "Too many failed desktop sign-in attempts. Try again later.",
		})
		return
	}
	if !s.desktopSecret.Matches(form.Get("subject_token"), now) {
		// It may still be a pairing credential, which only the legacy server knows.
		s.desktopFailures.fail(peer, now)
		s.serveProxy(w, r)
		return
	}
	s.desktopFailures.reset(peer)

	client := clientMetadata(r, form)
	issued, err := s.auth.IssueDesktopSession(client)
	if errors.Is(err, auth.ErrStateUninitialized) && s.legacy != nil {
		// Only a brand-new home gets here: the legacy server's startup migrations create the schema.
		if _, release, acquireErr := s.legacy.Acquire(r.Context()); acquireErr == nil {
			release()
			issued, err = s.auth.IssueDesktopSession(client)
		}
	}
	if err != nil {
		s.cfg.Logger.Printf("desktop session issuance failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"_tag": "EnvironmentInternalError", "code": "internal_error", "reason": "access_token_issuance_failed", "traceId": auth.TraceID(),
		})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":      issued.Token,
		"issued_token_type": accessTokenType,
		"token_type":        "Bearer",
		"expires_in":        max(0, int64(time.Until(issued.ExpiresAt)/time.Second)),
		"scope":             strings.Join(issued.Scopes, " "),
	})
}

var clientDeviceTypes = map[string]bool{"desktop": true, "mobile": true, "tablet": true, "bot": true, "unknown": true}

// desktopExchangeForm accepts only the plain bearer bootstrap exchange the native path
// implements; anything it does not fully understand is the legacy server's to answer.
func desktopExchangeForm(r *http.Request, body []byte) (url.Values, bool) {
	if len(body) > maxTokenRequestBody || r.Header.Get("DPoP") != "" {
		return nil, false
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/x-www-form-urlencoded" {
		return nil, false
	}
	form, err := url.ParseQuery(string(body))
	if err != nil || form.Get("grant_type") != tokenExchangeGrant || form.Get("subject_token_type") != bootstrapTokenType ||
		form.Get("requested_token_type") != accessTokenType || form.Has("scope") {
		return nil, false
	}
	if deviceType := form.Get("client_device_type"); deviceType != "" && !clientDeviceTypes[deviceType] {
		return nil, false
	}
	return form, true
}

// isLoopbackRequest is true for a same-machine client that did not come through a local
// reverse proxy (Tailscale Serve and the like connect from loopback too).
func isLoopbackRequest(r *http.Request) bool {
	ip := net.ParseIP(clientIP(r))
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	for key := range r.Header {
		switch k := strings.ToLower(key); {
		case k == "x-forwarded-for", k == "forwarded", k == "x-real-ip", strings.HasPrefix(k, "tailscale-"):
			return false
		}
	}
	return true
}

// clientMetadata mirrors deriveAuthClientMetadata in apps/server/src/auth/utils.ts.
func clientMetadata(r *http.Request, form url.Values) auth.ClientMetadata {
	userAgent := strings.TrimSpace(r.Header.Get("User-Agent"))
	ua := strings.ToLower(userAgent)
	m := auth.ClientMetadata{
		Label:      strings.TrimSpace(form.Get("client_label")),
		IPAddress:  strings.TrimPrefix(clientIP(r), "::ffff:"),
		UserAgent:  userAgent,
		DeviceType: form.Get("client_device_type"),
		OS:         strings.TrimSpace(form.Get("client_os")),
		Browser:    firstMatch(ua, browserPatterns),
	}
	if m.DeviceType == "" {
		m.DeviceType = "unknown"
		if ua != "" {
			m.DeviceType = firstMatch(ua, devicePatterns)
		}
	}
	if m.OS == "" {
		m.OS = firstMatch(ua, osPatterns)
	}
	return m
}

type uaPattern struct {
	re   *regexp.Regexp
	name string
}

func firstMatch(ua string, patterns []uaPattern) string {
	if ua == "" {
		return ""
	}
	for _, p := range patterns {
		if p.re.MatchString(ua) {
			return p.name
		}
	}
	return ""
}

var (
	devicePatterns = []uaPattern{
		{regexp.MustCompile(`bot|crawler|spider|slurp|curl|wget`), "bot"},
		{regexp.MustCompile(`ipad|tablet`), "tablet"},
		{regexp.MustCompile(`iphone|android.+mobile|mobile`), "mobile"},
		{regexp.MustCompile(``), "desktop"},
	}
	browserPatterns = []uaPattern{
		{regexp.MustCompile(`edg(?:e|a|ios)?/`), "Edge"},
		{regexp.MustCompile(`opr/|opios/`), "Opera"},
		{regexp.MustCompile(`firefox/|fxios/`), "Firefox"},
		{regexp.MustCompile(`electron/`), "Electron"},
		{regexp.MustCompile(`chrome/|crios/`), "Chrome"},
	}
	osPatterns = []uaPattern{
		{regexp.MustCompile(`iphone|ipad|ipod`), "iOS"},
		{regexp.MustCompile(`android`), "Android"},
		{regexp.MustCompile(`mac os x|macintosh`), "macOS"},
		{regexp.MustCompile(`windows nt`), "Windows"},
		{regexp.MustCompile(`linux`), "Linux"},
	}
)

// failureLimiter counts wrong desktop tokens per peer address in fixed windows.
type failureLimiter struct {
	mu      sync.Mutex
	entries map[string]*failureEntry
}

type failureEntry struct {
	count       int
	windowStart time.Time
	lockedUntil time.Time
}

func (l *failureLimiter) lockedFor(peer string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.entries[peer]; e != nil {
		return e.lockedUntil.Sub(now)
	}
	return 0
}

func (l *failureLimiter) fail(peer string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]*failureEntry{}
	}
	if len(l.entries) > 1024 {
		for key, e := range l.entries {
			if now.After(e.lockedUntil) && now.Sub(e.windowStart) > desktopExchangeWindow {
				delete(l.entries, key)
			}
		}
	}
	e := l.entries[peer]
	if e == nil {
		e = &failureEntry{windowStart: now}
		l.entries[peer] = e
	}
	if now.Sub(e.windowStart) > desktopExchangeWindow {
		e.count, e.windowStart = 0, now
	}
	e.count++
	if e.count >= desktopExchangeFailures {
		e.lockedUntil = now.Add(desktopExchangeLockout)
		e.count = 0
		e.windowStart = now
	}
}

func (l *failureLimiter) reset(peer string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, peer)
}
