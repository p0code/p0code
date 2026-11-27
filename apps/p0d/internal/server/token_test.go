package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"p0d/internal/auth"
	"p0d/internal/authtest"
)

type desktopHarness struct {
	*harness
	secret *auth.DesktopSecret
}

func startDesktop(t *testing.T, legacy bool) *desktopHarness {
	t.Helper()
	h := startWith(t, legacy, func(home *authtest.Home, cfg *Config) {
		cfg.DesktopSecretFile, _ = home.WriteDesktopSecret(t)
	})
	secret, err := auth.LoadDesktopSecret(h.srv.cfg.DesktopSecretFile)
	if err != nil {
		t.Fatal(err)
	}
	return &desktopHarness{harness: h, secret: secret}
}

func desktopForm(token string) url.Values {
	return url.Values{
		"grant_type":           {tokenExchangeGrant},
		"subject_token":        {token},
		"subject_token_type":   {bootstrapTokenType},
		"requested_token_type": {accessTokenType},
		"client_label":         {"p0code Desktop"},
		"client_device_type":   {"desktop"},
	}
}

func (h *desktopHarness) exchange(form url.Values, header http.Header) (*http.Response, map[string]any) {
	h.t.Helper()
	req, _ := http.NewRequest("POST", h.srv.URL()+"/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	json.NewDecoder(res.Body).Decode(&body)
	return res, body
}

func TestDesktopExchangeOpensSocketWithoutLegacy(t *testing.T) {
	h := startDesktop(t, true)
	res, body := h.exchange(desktopForm(h.secret.Token(time.Now())), http.Header{"User-Agent": {"p0code/1.0 Electron/39.0 (X11; Linux x86_64)"}})
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Pragma") != "no-cache" {
		t.Fatalf("exchange: %d %v %v", res.StatusCode, res.Header, body)
	}
	if body["issued_token_type"] != accessTokenType || body["token_type"] != "Bearer" ||
		body["scope"] != strings.Join(auth.AdministrativeScopes, " ") || body["expires_in"].(float64) < 30*24*3600-60 {
		t.Fatalf("response %v", body)
	}
	token := body["access_token"].(string)
	session, verr := h.srv.auth.VerifySessionToken(token)
	if verr != nil {
		t.Fatal(verr)
	}
	row := h.home.Session(t, session.SessionID)
	if row.Label.String != "p0code Desktop" || row.DeviceType != "desktop" || row.IPAddress.String != "127.0.0.1" ||
		row.OS.String != "Linux" || row.Browser.String != "Electron" || !strings.HasPrefix(row.UserAgent.String, "p0code/1.0") {
		t.Fatalf("client metadata %+v", row)
	}

	c := h.dial("&frameParts=1", token)
	c.send(`{"_tag":"Request","id":0,"tag":"server.probe","payload":{},"headers":[]}`)
	if exitOf(t, c.next())["_tag"] != "Success" {
		t.Fatal("server.probe failed for the desktop session")
	}
	if st, _ := h.srv.Legacy().Status(); st.State != "stopped" {
		t.Fatalf("signing in woke the legacy server: %+v", st)
	}
}

func TestTokenRequestsForwardedUnchanged(t *testing.T) {
	h := startDesktop(t, true)
	valid := h.secret.Token(time.Now())
	renewal := desktopForm("some-access-token")
	renewal.Set("subject_token_type", accessTokenType)
	scoped := desktopForm(valid)
	scoped.Set("scope", "orchestration:read")
	badDevice := desktopForm(valid)
	badDevice.Set("client_device_type", "toaster")
	cases := []struct {
		name   string
		form   url.Values
		header http.Header
	}{
		{"wrong token, maybe a pairing credential", desktopForm("pairing-credential"), nil},
		{"access token renewal", renewal, nil},
		{"DPoP-bound exchange", desktopForm(valid), http.Header{"Dpop": {"proof"}}},
		{"scoped exchange", scoped, nil},
		{"unknown device type", badDevice, nil},
		{"through a local reverse proxy", desktopForm(valid), http.Header{"X-Forwarded-For": {"203.0.113.9"}}},
		{"through Tailscale Serve", desktopForm(valid), http.Header{"Tailscale-User-Login": {"someone"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, body := h.exchange(c.form, c.header)
			if res.StatusCode != http.StatusTeapot || body["body"] != c.form.Encode() || body["dpop"] != c.header.Get("DPoP") {
				t.Fatalf("not forwarded unchanged: %d %v", res.StatusCode, body)
			}
		})
	}
	if n := h.home.LiveSessions(t, auth.DesktopSubject); n != 0 {
		t.Fatalf("%d desktop sessions issued for forwarded requests", n)
	}
}

func TestDesktopExchangeOnlyFromLoopback(t *testing.T) {
	h := startDesktop(t, false)
	for addr, native := range map[string]bool{"127.0.0.1:5000": true, "[::1]:5000": true, "192.0.2.10:5000": false, "[2001:db8::1]:5000": false} {
		req := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(desktopForm(h.secret.Token(time.Now())).Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.RemoteAddr = addr
		rec := httptest.NewRecorder()
		h.srv.serveToken(rec, req)
		// With no legacy server, a forwarded request is a 404.
		if got := rec.Code == http.StatusOK; got != native {
			t.Errorf("%s: status %d, want native=%v", addr, rec.Code, native)
		}
	}
}

func TestDesktopExchangeLockout(t *testing.T) {
	old := desktopExchangeFailures
	desktopExchangeFailures = 3
	t.Cleanup(func() { desktopExchangeFailures = old })
	h := startDesktop(t, false)
	for range 3 {
		if res, _ := h.exchange(desktopForm("guess"), nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("wrong token: %d", res.StatusCode)
		}
	}
	res, body := h.exchange(desktopForm(h.secret.Token(time.Now())), nil)
	if res.StatusCode != http.StatusTooManyRequests || res.Header.Get("Retry-After") == "" || body["code"] != "rate_limited" {
		t.Fatalf("locked out peer got %d %v", res.StatusCode, body)
	}
	h.srv.desktopFailures.reset("127.0.0.1")
	if res, _ := h.exchange(desktopForm(h.secret.Token(time.Now())), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("after lockout: %d", res.StatusCode)
	}
}

func TestDesktopExchangeConcurrent(t *testing.T) {
	h := startDesktop(t, false)
	var wg sync.WaitGroup
	tokens := make(chan string, 8)
	for range 8 {
		wg.Go(func() {
			res, body := h.exchange(desktopForm(h.secret.Token(time.Now())), nil)
			if res.StatusCode != http.StatusOK {
				t.Errorf("exchange: %d %v", res.StatusCode, body)
				return
			}
			tokens <- body["access_token"].(string)
		})
	}
	wg.Wait()
	close(tokens)
	live := 0
	for token := range tokens {
		if _, err := h.srv.auth.VerifySessionToken(token); err == nil {
			live++
		}
	}
	// Each exchange replaces the desktop's earlier session, as the legacy server does.
	if live != 1 || h.home.LiveSessions(t, auth.DesktopSubject) != 1 {
		t.Fatalf("%d live tokens, want 1", live)
	}
}

func TestDesktopExchangeMigratesFreshHome(t *testing.T) {
	t.Setenv("P0D_FAKE_LEGACY_MIGRATE", "1")
	fresh := filepath.Join(t.TempDir(), "userdata")
	h := startWith(t, true, func(home *authtest.Home, cfg *Config) {
		cfg.DesktopSecretFile, _ = home.WriteDesktopSecret(t)
		cfg.Home = fresh
		cfg.ReadyFile = ""
	})
	secret, _ := auth.LoadDesktopSecret(h.srv.cfg.DesktopSecretFile)
	dh := &desktopHarness{harness: h, secret: secret}
	res, body := dh.exchange(desktopForm(secret.Token(time.Now())), nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("fresh home: %d %v", res.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(fresh, "secrets", "server-signing-key.bin")); err != nil {
		t.Fatalf("signing key: %v", err)
	}
}

func TestStartRejectsBadDesktopSecret(t *testing.T) {
	home := authtest.New(t)
	for name, path := range map[string]string{
		"missing": filepath.Join(t.TempDir(), "none"),
		"empty":   writeFile(t, "", 0o600),
		"short":   writeFile(t, "abcd", 0o600),
	} {
		if _, err := Start(Config{Home: home.Dir, Host: "127.0.0.1", DesktopSecretFile: path}); err == nil {
			t.Errorf("%s secret file accepted", name)
		}
	}
}

func writeFile(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	return path
}
