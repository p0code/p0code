package auth_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"p0d/internal/auth"
	"p0d/internal/authtest"
)

func writeSecret(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadDesktopSecret(t *testing.T) {
	cases := []struct {
		name    string
		content string
		mode    os.FileMode
		wantErr string
	}{
		{"base64url 32 bytes", "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA\n", 0o600, ""},
		{"padded", "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=", 0o600, ""},
		{"hex secret the Electron app writes today", strings.Repeat("ab", 32), 0o600, ""},
		{"empty", "", 0o600, "empty"},
		{"whitespace", " \n\t", 0o600, "empty"},
		{"too short", "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeA", 0o600, "need at least 32"},
		{"not base64url", strings.Repeat("+/", 30), 0o600, "not base64url"},
		{"group readable", strings.Repeat("ab", 32), 0o640, "group or others"},
		{"world readable", strings.Repeat("ab", 32), 0o604, "group or others"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if runtime.GOOS == "windows" && c.mode != 0o600 {
				t.Skip("no POSIX modes on Windows")
			}
			_, err := auth.LoadDesktopSecret(writeSecret(t, c.content, c.mode))
			if c.wantErr == "" && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}

	if _, err := auth.LoadDesktopSecret(filepath.Join(t.TempDir(), "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing file: %v", err)
	}
	if _, err := auth.LoadDesktopSecret(t.TempDir()); err == nil {
		t.Error("directory accepted")
	}
}

func TestDesktopTokenWindows(t *testing.T) {
	secret, err := auth.LoadDesktopSecret(writeSecret(t, strings.Repeat("ab", 32), 0o600))
	if err != nil {
		t.Fatal(err)
	}
	// From currentDesktopBootstrapToken in packages/shared, for this secret at this time.
	now := time.UnixMilli(1_800_000_000_000)
	const fromNode = "f0cf04f8e6f3b5214e81644f8b67dd4ed2c4af2083005480d375c54fb8639824"
	if got := secret.Token(now); got != fromNode {
		t.Errorf("token %s differs from the Node server's %s", got, fromNode)
	}
	token := secret.Token(now)
	window := 12 * time.Hour
	for name, at := range map[string]time.Time{"current": now, "next window": now.Add(-window), "previous window": now.Add(window)} {
		if !secret.Matches(token, at) {
			t.Errorf("%s rejected", name)
		}
	}
	for name, presented := range map[string]string{
		"two windows old": secret.Token(now.Add(-2 * window)),
		"raw secret":      strings.Repeat("ab", 32),
		"wrong":           strings.Repeat("0", 64),
		"empty":           "",
	} {
		if secret.Matches(presented, now) {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestIssueDesktopSession(t *testing.T) {
	home := authtest.New(t)
	home.AddSession(t, "other", "client", authtest.AllScopes, "")
	a := newAuth(t, home)

	first, err := a.IssueDesktopSession(auth.ClientMetadata{Label: "p0code Desktop", DeviceType: "desktop", IPAddress: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	s, verr := a.VerifySessionToken(first.Token)
	if verr != nil {
		t.Fatal(verr)
	}
	if s.Subject != auth.DesktopSubject || s.Method != "bearer-access-token" || !slices.Equal(s.Scopes, auth.AdministrativeScopes) {
		t.Fatalf("verified %+v", s)
	}
	if d := time.Until(first.ExpiresAt); d < 29*24*time.Hour || d > 30*24*time.Hour {
		t.Fatalf("expires in %v", d)
	}
	row := home.Session(t, first.SessionID)
	var scopes []string
	json.Unmarshal([]byte(row.Scopes), &scopes)
	if row.Label.String != "p0code Desktop" || row.DeviceType != "desktop" || row.IPAddress.String != "127.0.0.1" ||
		row.UserAgent.Valid || row.ProofKeyThumbprt.Valid || !slices.Equal(scopes, auth.AdministrativeScopes) {
		t.Fatalf("row %+v", row)
	}

	second, err := a.IssueDesktopSession(auth.ClientMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, verr := a.VerifySessionToken(first.Token); verr == nil {
		t.Error("the earlier desktop session survived a new one")
	}
	if home.Session(t, second.SessionID).DeviceType != "unknown" {
		t.Error("device type should default to unknown")
	}
	if home.LiveSessions(t, "client") != 1 {
		t.Error("another subject's session was revoked")
	}
}

func TestIssueDesktopSessionConcurrently(t *testing.T) {
	home := authtest.New(t)
	a := newAuth(t, home)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			if _, err := a.IssueDesktopSession(auth.ClientMetadata{}); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if n := home.LiveSessions(t, auth.DesktopSubject); n != 1 {
		t.Fatalf("%d live desktop sessions, want 1", n)
	}
}

func TestIssueDesktopSessionCreatesSigningKey(t *testing.T) {
	home := authtest.New(t)
	keyPath := filepath.Join(home.Dir, "secrets", "server-signing-key.bin")
	os.Remove(keyPath)
	a := newAuth(t, home)
	issued, err := a.IssueDesktopSession(auth.ClientMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(keyPath)
	if err != nil || len(key) != 32 {
		t.Fatalf("key %d bytes, %v", len(key), err)
	}
	if info, _ := os.Stat(keyPath); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("key mode %v", info.Mode())
	}
	if _, verr := a.VerifySessionToken(issued.Token); verr != nil {
		t.Fatal(verr)
	}
}

func TestIssueDesktopSessionUninitializedHome(t *testing.T) {
	t.Setenv("P0CODE_SECRET_BACKEND", "file")
	a, err := auth.New(filepath.Join(t.TempDir(), "userdata"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.IssueDesktopSession(auth.ClientMetadata{}); !errors.Is(err, auth.ErrStateUninitialized) {
		t.Fatalf("want ErrStateUninitialized, got %v", err)
	}
}
