package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"p0d/internal/auth"
)

// TestRealLegacyServer runs p0d in front of the real Node server (apps/server). It is
// slow and needs node plus installed workspace deps, so it only runs with
// P0D_NODE_INTEGRATION=1. P0D_NODE_SERVER_BIN points at another checkout's bin.ts.
func TestRealLegacyServer(t *testing.T) {
	if os.Getenv("P0D_NODE_INTEGRATION") != "1" {
		t.Skip("set P0D_NODE_INTEGRATION=1 to run against apps/server")
	}
	bin, err := filepath.Abs("../../../server/src/bin.ts")
	if override := os.Getenv("P0D_NODE_SERVER_BIN"); override != "" {
		bin = override
	}
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	// Keep the Node server away from the real ~/.p0code and the OS keychain.
	t.Setenv("HOME", filepath.Join(base, "home"))
	t.Setenv("P0CODE_SECRET_BACKEND", "file")
	issue := exec.Command("node", bin, "auth", "session", "issue", "--base-dir", base, "--token-only")
	out, err := issue.Output()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	token := regexp.MustCompile(`(?m)^ey[\w-]+\.[\w-]+$`).FindString(string(out))
	if token == "" {
		t.Fatalf("no token in %q", out)
	}

	secretFile := filepath.Join(base, "desktop-secret")
	if err := os.WriteFile(secretFile, []byte(strings.Repeat("ab", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := Start(Config{
		Home: filepath.Join(base, "userdata"), Host: "127.0.0.1", Version: "test",
		Legacy: []string{"node", bin, "serve"}, LegacyIdle: time.Minute,
		Logger: log.New(io.Discard, "", 0), DesktopSecretFile: secretFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	h := &harness{t: t, srv: srv, token: token}

	// Go-native: the Node-issued token verifies in Go without starting Node.
	c := h.dial("&frameParts=1", token)
	c.send(`{"_tag":"Request","id":0,"tag":"server.probe","payload":{},"headers":[]}`)
	if exitOf(t, c.next())["_tag"] != "Success" {
		t.Fatal("server.probe failed")
	}
	if st, _ := srv.Legacy().Status(); st.State != "stopped" {
		t.Fatalf("legacy started for a native call: %+v", st)
	}

	// Native desktop sign-in, then the Node server verifies the p0d-issued token itself.
	secret, err := auth.LoadDesktopSecret(secretFile)
	if err != nil {
		t.Fatal(err)
	}
	form := url.Values{"grant_type": {tokenExchangeGrant}, "subject_token": {secret.Token(time.Now())},
		"subject_token_type": {bootstrapTokenType}, "requested_token_type": {accessTokenType}}
	res, err := http.PostForm(srv.URL()+"/oauth/token", form)
	if err != nil {
		t.Fatal(err)
	}
	var issued struct {
		AccessToken string `json:"access_token"`
	}
	json.NewDecoder(res.Body).Decode(&issued)
	if res.StatusCode != http.StatusOK || issued.AccessToken == "" {
		t.Fatalf("desktop exchange: %s", res.Status)
	}
	if st, _ := srv.Legacy().Status(); st.State != "stopped" {
		t.Fatalf("legacy started for desktop sign-in: %+v", st)
	}
	addr, release, err := srv.Legacy().Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	direct, _ := http.NewRequest("GET", "http://"+addr+"/api/auth/session", nil)
	direct.Header.Set("Authorization", "Bearer "+issued.AccessToken)
	res, err = http.DefaultClient.Do(direct)
	release()
	if err != nil {
		t.Fatal(err)
	}
	var nodeState struct {
		Authenticated bool   `json:"authenticated"`
		SessionMethod string `json:"sessionMethod"`
	}
	json.NewDecoder(res.Body).Decode(&nodeState)
	if !nodeState.Authenticated || nodeState.SessionMethod != "bearer-access-token" {
		t.Fatalf("Node rejected the p0d-issued desktop token: %+v", nodeState)
	}

	// Proxied over the same socket: Node answers as the p0d-verified session.
	c.send(`{"_tag":"Request","id":1,"tag":"server.getSettings","payload":{},"headers":[]}`)
	msg := c.next()
	if exit := exitOf(t, msg); exit["_tag"] != "Success" {
		t.Fatalf("server.getSettings: %v", msg)
	}

	req, _ := http.NewRequest("GET", srv.URL()+"/api/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Authenticated bool   `json:"authenticated"`
		SessionMethod string `json:"sessionMethod"`
	}
	json.NewDecoder(res.Body).Decode(&state)
	if !state.Authenticated || state.SessionMethod != "bearer-access-token" {
		t.Fatalf("proxied /api/auth/session: %+v", state)
	}
}
