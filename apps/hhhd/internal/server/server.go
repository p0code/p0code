// Package server is hhhd's HTTP front: /healthz, the /ws RPC socket, and a proxy that
// forwards every route hhhd has not ported to the legacy server.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"hhhd/internal/auth"
	"hhhd/internal/rpc"
	"hhhd/internal/sidecar"
)

// orchestrationProtocolVersion is ORCHESTRATION_PROTOCOL_VERSION in packages/contracts.
const orchestrationProtocolVersion = "2"

var (
	// sessionCheckInterval is how often a live socket re-checks that its session is still valid.
	sessionCheckInterval = 15 * time.Second
	// upstreamIdle is how long a client's legacy socket stays open with nothing in flight.
	upstreamIdle = 30 * time.Second
)

// Config is `hhhd serve`'s flags.
type Config struct {
	Home       string
	Host       string
	Port       int
	ReadyFile  string
	Legacy     []string
	LegacyIdle time.Duration
	Version    string
	Logger     *log.Logger
}

// Server is a running hhhd.
type Server struct {
	cfg      Config
	auth     *auth.Authenticator
	legacy   *sidecar.Manager
	registry *rpc.Registry
	listener net.Listener
	http     *http.Server
}

// Start listens and serves in the background.
func Start(cfg Config) (*Server, error) {
	if cfg.Logger == nil {
		cfg.Logger = log.New(os.Stderr, "hhhd: ", log.LstdFlags)
	}
	home, err := filepath.Abs(cfg.Home)
	if err != nil {
		return nil, err
	}
	cfg.Home = home
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	authenticator, err := auth.New(home)
	if err != nil {
		listener.Close()
		return nil, err
	}
	environmentID, _ := os.ReadFile(filepath.Join(home, "environment-id"))
	authenticator.CookieName, authenticator.LegacyCookieName = auth.CookieName(port, cfg.Host, home, strings.TrimSpace(string(environmentID)))

	s := &Server{cfg: cfg, auth: authenticator, registry: rpc.NewRegistry(), listener: listener}
	if len(cfg.Legacy) > 0 {
		// The legacy server keeps its state in <base-dir>/userdata.
		if filepath.Base(home) != "userdata" {
			listener.Close()
			return nil, fmt.Errorf("--legacy-server needs --home to be a <base>/userdata folder, got %s", home)
		}
		s.legacy = sidecar.New(cfg.Legacy, filepath.Dir(home), cfg.LegacyIdle)
		s.legacy.Logger = cfg.Logger
	}
	registerHandlers(s.registry, s)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /ws", s.serveWS)
	mux.HandleFunc("/", s.serveProxy)
	s.http = &http.Server{Handler: mux, ReadHeaderTimeout: 30 * time.Second}
	go s.http.Serve(listener)

	if cfg.ReadyFile != "" {
		if err := writeReadyFile(cfg.ReadyFile, port, s.URL()); err != nil {
			s.Close()
			return nil, err
		}
	}
	return s, nil
}

// Port is the bound port.
func (s *Server) Port() int { return s.listener.Addr().(*net.TCPAddr).Port }

// URL is a URL a local client can reach.
func (s *Server) URL() string {
	host := s.cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(s.Port()))
}

// Legacy is the sidecar manager, or nil.
func (s *Server) Legacy() *sidecar.Manager { return s.legacy }

// Registry is where ported RPC methods live.
func (s *Server) Registry() *rpc.Registry { return s.registry }

// Close stops serving and stops the sidecar.
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := s.http.Shutdown(ctx)
	if errors.Is(err, context.DeadlineExceeded) {
		err = s.http.Close()
	}
	if s.legacy != nil {
		s.legacy.Stop()
	}
	s.auth.Close()
	if s.cfg.ReadyFile != "" {
		os.Remove(s.cfg.ReadyFile)
	}
	return err
}

func writeReadyFile(path string, port int, url string) error {
	data, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "port": port, "url": url})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// writeAuthError mirrors EnvironmentAuthInvalidError / EnvironmentInternalError bodies.
func writeAuthError(w http.ResponseWriter, err *auth.Error) {
	if err.Internal {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"_tag": "EnvironmentInternalError", "code": "internal_error", "reason": "internal_error", "traceId": auth.TraceID(),
		})
		return
	}
	body := map[string]string{"_tag": "EnvironmentAuthInvalidError", "code": "auth_invalid", "reason": err.Reason, "traceId": auth.TraceID()}
	if err.DpopFailureReason != "" {
		body["dpopFailureReason"] = err.DpopFailureReason
	}
	writeJSON(w, http.StatusUnauthorized, body)
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if query.Get("orchestrationProtocol") != orchestrationProtocolVersion {
		writeJSON(w, http.StatusUpgradeRequired, map[string]any{
			"code":                         "orchestration_protocol_incompatible",
			"message":                      "Update this client to one that supports orchestration protocol " + orchestrationProtocolVersion + ".",
			"orchestrationProtocolVersion": 2,
		})
		return
	}
	session, authErr := s.auth.AuthenticateWebSocket(r, "rpc")
	if authErr != nil {
		writeAuthError(w, authErr)
		return
	}
	// Like the legacy server: deflate with context takeover, except for the desktop's
	// own same-machine session. Origins were checked with the credential.
	compression := websocket.CompressionContextTakeover
	if session.Subject == "desktop-bootstrap" {
		compression = websocket.CompressionDisabled
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: compression})
	if err != nil {
		return
	}
	defer ws.CloseNow()

	var dial rpc.Dialer
	if s.legacy != nil {
		dial = s.upstreamDialer(r, session)
	}
	identity := &rpc.Identity{SessionID: session.SessionID, Subject: session.Subject, Scopes: session.Scopes}
	conn := rpc.NewConn(ws, identity, s.registry, dial, query.Has("frameParts"))
	conn.UpstreamIdle = upstreamIdle

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.watchSession(ctx, conn, session)
	conn.Serve(ctx)
}

func (s *Server) watchSession(ctx context.Context, conn *rpc.Conn, session *auth.Session) {
	t := time.NewTicker(sessionCheckInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ok, err := s.auth.StillValid(session)
			if err != nil {
				s.cfg.Logger.Printf("session check failed: %v", err)
			}
			if !ok {
				conn.Close("session ended")
				return
			}
		}
	}
}

// upstreamDialer opens the client's socket to the legacy server, carrying the
// client's query (minus credentials and framing) and its verified session.
func (s *Server) upstreamDialer(r *http.Request, session *auth.Session) rpc.Dialer {
	query := r.URL.Query()
	for _, key := range []string{"wsTicket", "dpop", "frameParts"} {
		query.Del(key)
	}
	header := http.Header{}
	for _, key := range []string{"User-Agent", "Origin"} {
		if v := r.Header.Get(key); v != "" {
			header.Set(key, v)
		}
	}
	header.Set("X-Forwarded-For", clientIP(r))
	header.Set(sidecar.TokenHeader, s.legacy.Token)
	header.Set(sidecar.SessionHeader, session.SessionID)
	host := r.Host
	return func(ctx context.Context) (*websocket.Conn, func(), error) {
		addr, release, err := s.legacy.Acquire(ctx)
		if err != nil {
			return nil, nil, err
		}
		u := url.URL{Scheme: "ws", Host: addr, Path: "/ws", RawQuery: query.Encode()}
		ws, res, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: header, Host: host})
		if err != nil {
			release()
			if res != nil {
				return nil, nil, fmt.Errorf("legacy server refused the socket: %s", res.Status)
			}
			return nil, nil, err
		}
		return ws, release, nil
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// serveProxy forwards any route hhhd has not ported. A request whose credential hhhd
// verifies reaches the legacy server as that session (credentials stripped, internal
// token added). Anything else goes through untouched and the legacy server applies its
// own checks, which keeps pairing, OAuth, MCP and token renewal working.
func (s *Server) serveProxy(w http.ResponseWriter, r *http.Request) {
	for key := range r.Header {
		if strings.HasPrefix(strings.ToLower(key), "x-hhhd-") {
			r.Header.Del(key)
		}
	}
	if s.legacy == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "not_found", "message": "hhhd has no legacy server for this route."})
		return
	}
	var session *auth.Session
	if s.auth.HasCredential(r) {
		var err *auth.Error
		if r.URL.Query().Has("wsTicket") {
			session, err = s.auth.AuthenticateWebSocket(r, "media")
		} else {
			session, err = s.auth.AuthenticateRequest(r)
		}
		if err != nil && err.Internal {
			writeAuthError(w, err)
			return
		}
	}

	addr, release, err := s.legacy.Acquire(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"code": "legacy_unavailable", "message": err.Error()})
		return
	}
	defer release()
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&url.URL{Scheme: "http", Host: addr})
			pr.Out.Host = pr.In.Host
			pr.SetXForwarded()
			if pr.In.TLS == nil {
				pr.Out.Header.Set("X-Forwarded-Proto", pr.In.Header.Get("X-Forwarded-Proto"))
				if pr.Out.Header.Get("X-Forwarded-Proto") == "" {
					pr.Out.Header.Del("X-Forwarded-Proto")
				}
			}
			if session != nil {
				stripCredentials(pr.Out, s.auth)
				pr.Out.Header.Set(sidecar.TokenHeader, s.legacy.Token)
				pr.Out.Header.Set(sidecar.SessionHeader, session.SessionID)
			}
		},
		ModifyResponse: func(res *http.Response) error {
			renameSessionCookies(res.Header, s.auth.CookieName)
			return nil
		},
		FlushInterval: -1,
	}
	proxy.ServeHTTP(w, r)
}

func stripCredentials(r *http.Request, a *auth.Authenticator) {
	// A DPoP header without DPoP authorization belongs to the route (e.g. /oauth/token), not the session.
	scheme, _, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	switch strings.ToLower(scheme) {
	case "dpop":
		r.Header.Del("DPoP")
		r.Header.Del("Authorization")
	case "bearer":
		r.Header.Del("Authorization")
	}
	var kept []string
	for _, c := range r.Cookies() {
		if c.Name != a.CookieName && c.Name != a.LegacyCookieName {
			kept = append(kept, c.String())
		}
	}
	r.Header.Del("Cookie")
	if len(kept) > 0 {
		r.Header.Set("Cookie", strings.Join(kept, "; "))
	}
	q := r.URL.Query()
	if q.Has("wsTicket") || q.Has("dpop") {
		q.Del("wsTicket")
		q.Del("dpop")
		r.URL.RawQuery = q.Encode()
	}
}

// renameSessionCookies gives session cookies the legacy server sets hhhd's cookie name:
// its own name embeds its private loopback port, which changes every time it starts.
func renameSessionCookies(h http.Header, name string) {
	cookies := h.Values("Set-Cookie")
	if len(cookies) == 0 {
		return
	}
	h.Del("Set-Cookie")
	for _, c := range cookies {
		if cookieName, rest, ok := strings.Cut(c, "="); ok && strings.HasPrefix(cookieName, "t3_session_") {
			c = name + "=" + rest
		}
		h.Add("Set-Cookie", c)
	}
}
