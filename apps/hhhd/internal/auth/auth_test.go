package auth_test

import (
	"net/http/httptest"
	"testing"
	"time"

	"hhhd/internal/auth"
	"hhhd/internal/authtest"
)

func newAuth(t *testing.T, home *authtest.Home) *auth.Authenticator {
	t.Helper()
	t.Setenv("HHHCODE_SECRET_BACKEND", "file")
	a, err := auth.New(home.Dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	a.CookieName = "t3_session_1_abc"
	return a
}

func TestBearerSession(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "s1", "client", []string{"orchestration:read"}, "")
	a := newAuth(t, home)

	r := httptest.NewRequest("GET", "http://localhost/api/x", nil)
	r.Header.Set("Authorization", "Bearer "+home.SessionToken("s1", "client", time.Hour, ""))
	s, err := a.AuthenticateRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	if s.SessionID != "s1" || len(s.Scopes) != 1 || s.Scopes[0] != "orchestration:read" {
		t.Fatalf("unexpected session %+v", s)
	}

	cases := map[string]string{
		"expired":   home.SessionToken("s1", "client", -time.Second, ""),
		"unknown":   home.SessionToken("nope", "client", time.Hour, ""),
		"tampered":  home.SessionToken("s1", "client", time.Hour, "") + "x",
		"malformed": "not-a-token",
	}
	for name, token := range cases {
		r.Header.Set("Authorization", "Bearer "+token)
		if _, err := a.AuthenticateRequest(r); err == nil || err.Reason != "invalid_credential" {
			t.Errorf("%s: want invalid_credential, got %v", name, err)
		}
	}

	r.Header.Del("Authorization")
	if _, err := a.AuthenticateRequest(r); err == nil || err.Reason != "missing_credential" {
		t.Errorf("want missing_credential, got %v", err)
	}

	home.Revoke(t, "s1")
	r.Header.Set("Authorization", "Bearer "+home.SessionToken("s1", "client", time.Hour, ""))
	if _, err := a.AuthenticateRequest(r); err == nil {
		t.Error("revoked session was accepted")
	}
}

func TestCookieOrigin(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "s1", "client", authtest.AllScopes, "")
	a := newAuth(t, home)
	token := home.SessionToken("s1", "client", time.Hour, "")

	r := httptest.NewRequest("GET", "http://127.0.0.1:4000/api/x", nil)
	r.Header.Set("Cookie", "t3_session_1_abc="+token)
	r.Header.Set("Origin", "http://127.0.0.1:4000")
	if _, err := a.AuthenticateRequest(r); err != nil {
		t.Fatalf("same origin: %v", err)
	}
	r.Header.Set("Origin", "hhhcode://app")
	if _, err := a.AuthenticateRequest(r); err != nil {
		t.Fatalf("desktop origin: %v", err)
	}
	r.Header.Set("Origin", "http://127.0.0.1:5000")
	if _, err := a.AuthenticateRequest(r); err == nil {
		t.Fatal("cookie from another port's origin was accepted")
	}
}

func TestMcpSessionsRejected(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "m1", "mcp-client", authtest.AllScopes, "")
	a := newAuth(t, home)
	r := httptest.NewRequest("GET", "http://localhost/ws", nil)
	r.Header.Set("Authorization", "Bearer "+home.SessionToken("m1", "mcp-client", time.Hour, ""))
	if _, err := a.AuthenticateRequest(r); err == nil {
		t.Fatal("MCP client session was accepted outside /mcp")
	}
}

func TestWebSocketTicketAudience(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "s1", "client", authtest.AllScopes, "")
	a := newAuth(t, home)

	r := httptest.NewRequest("GET", "http://localhost/ws?wsTicket="+home.Ticket("s1", "rpc", ""), nil)
	if _, err := a.AuthenticateWebSocket(r, "rpc"); err != nil {
		t.Fatalf("rpc ticket on rpc route: %v", err)
	}
	if _, err := a.AuthenticateWebSocket(r, "media"); err == nil {
		t.Fatal("rpc ticket accepted on media route")
	}
	r = httptest.NewRequest("GET", "http://localhost/ws?wsTicket="+home.Ticket("s1", "", ""), nil)
	if _, err := a.AuthenticateWebSocket(r, "media"); err != nil {
		t.Fatalf("audience-less ticket: %v", err)
	}
}

func TestDpopBoundTicketAndToken(t *testing.T) {
	home := authtest.New(t)
	key := authtest.NewDpopKey()
	home.AddSession(t, "d1", "device", authtest.AllScopes, key.Thumbprint)
	a := newAuth(t, home)

	ticket := home.Ticket("d1", "rpc", key.Thumbprint)
	url := "http://127.0.0.1:4000/ws"
	proof := key.Proof("GET", url, ticket)
	r := httptest.NewRequest("GET", url+"?orchestrationProtocol=2&wsTicket="+ticket+"&dpop="+proof, nil)
	if _, err := a.AuthenticateWebSocket(r, "rpc"); err != nil {
		t.Fatalf("valid proof: %v", err)
	}
	if _, err := a.AuthenticateWebSocket(r, "rpc"); err == nil || err.DpopFailureReason != "replay" {
		t.Fatalf("replayed proof: want replay, got %v", err)
	}

	wrongURL := key.Proof("GET", "http://127.0.0.1:4001/ws", ticket)
	r = httptest.NewRequest("GET", url+"?wsTicket="+ticket+"&dpop="+wrongURL, nil)
	if _, err := a.AuthenticateWebSocket(r, "rpc"); err == nil || err.DpopFailureReason != "request_mismatch" {
		t.Fatalf("wrong htu: want request_mismatch, got %v", err)
	}

	other := authtest.NewDpopKey()
	r = httptest.NewRequest("GET", url+"?wsTicket="+ticket+"&dpop="+other.Proof("GET", url, ticket), nil)
	if _, err := a.AuthenticateWebSocket(r, "rpc"); err == nil || err.DpopFailureReason != "key_mismatch" {
		t.Fatalf("other key: want key_mismatch, got %v", err)
	}

	token := home.SessionToken("d1", "device", time.Hour, key.Thumbprint)
	r = httptest.NewRequest("GET", "http://127.0.0.1:4000/api/x?y=1", nil)
	r.Header.Set("Authorization", "DPoP "+token)
	r.Header.Set("DPoP", key.Proof("GET", "http://127.0.0.1:4000/api/x", token))
	if _, err := a.AuthenticateRequest(r); err != nil {
		t.Fatalf("DPoP access token: %v", err)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	if _, err := a.AuthenticateRequest(r); err == nil {
		t.Fatal("DPoP-bound token accepted as a bearer token")
	}
}

func TestStillValid(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "s1", "client", authtest.AllScopes, "")
	a := newAuth(t, home)
	s := &auth.Session{SessionID: "s1"}
	if ok, _ := a.StillValid(s); !ok {
		t.Fatal("live session reported invalid")
	}
	home.Revoke(t, "s1")
	if ok, _ := a.StillValid(s); ok {
		t.Fatal("revoked session reported valid")
	}
}

func TestCookieName(t *testing.T) {
	name, legacy := auth.CookieName(3773, "127.0.0.1", "/home/u/.hhh/userdata", "env")
	if legacy != "" || len(name) != len("t3_session_3773_")+12 {
		t.Fatalf("loopback name %q legacy %q", name, legacy)
	}
	name, legacy = auth.CookieName(3773, "0.0.0.0", "/x", "env")
	if legacy != "t3_session" || len(name) != len("t3_session_")+12 {
		t.Fatalf("remote name %q legacy %q", name, legacy)
	}
}
