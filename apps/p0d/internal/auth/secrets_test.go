package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"testing"
)

// A home moved from ~/.hhh to ~/.p0code must keep reading the keychain entries the
// server wrote before the move.
func TestCredentialNamespaceKeepsPreRenameHash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	home = resolvePath(home)
	old := sha256.Sum256([]byte(filepath.Join(home, ".hhh", "userdata", "secrets")))
	got := credentialNamespace(filepath.Join(home, ".p0code", "userdata", "secrets"))
	if want := hex.EncodeToString(old[:])[:16]; got != want {
		t.Fatalf("namespace = %s, want the pre-rename %s", got, want)
	}
	other := filepath.Join(home, "elsewhere", "secrets")
	sum := sha256.Sum256([]byte(other))
	if got := credentialNamespace(other); got != hex.EncodeToString(sum[:])[:16] {
		t.Fatalf("a home outside ~/.p0code changed namespace: %s", got)
	}
}
