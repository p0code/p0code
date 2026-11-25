package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// TestRealLegacyServer runs hhhd in front of the real Node server (apps/server). It is
// slow and needs node plus installed workspace deps, so it only runs with
// HHHD_NODE_INTEGRATION=1.
func TestRealLegacyServer(t *testing.T) {
	if os.Getenv("HHHD_NODE_INTEGRATION") != "1" {
		t.Skip("set HHHD_NODE_INTEGRATION=1 to run against apps/server")
	}
	bin, err := filepath.Abs("../../../server/src/bin.ts")
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	// Keep the Node server away from the real ~/.hhh and the OS keychain.
	t.Setenv("HOME", filepath.Join(base, "home"))
	t.Setenv("HHHCODE_SECRET_BACKEND", "file")
	issue := exec.Command("node", bin, "auth", "session", "issue", "--base-dir", base, "--token-only")
	out, err := issue.Output()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	token := regexp.MustCompile(`(?m)^ey[\w-]+\.[\w-]+$`).FindString(string(out))
	if token == "" {
		t.Fatalf("no token in %q", out)
	}

	srv, err := Start(Config{
		Home: filepath.Join(base, "userdata"), Host: "127.0.0.1", Version: "test",
		Legacy: []string{"node", bin, "serve"}, LegacyIdle: time.Minute,
		Logger: log.New(io.Discard, "", 0),
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

	// Proxied over the same socket: Node answers as the hhhd-verified session.
	c.send(`{"_tag":"Request","id":1,"tag":"server.getSettings","payload":{},"headers":[]}`)
	msg := c.next()
	if exit := exitOf(t, msg); exit["_tag"] != "Success" {
		t.Fatalf("server.getSettings: %v", msg)
	}

	req, _ := http.NewRequest("GET", srv.URL()+"/api/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
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
