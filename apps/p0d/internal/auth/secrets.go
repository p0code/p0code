package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/zalando/go-keyring"
)

// The legacy server keeps credentials in the OS keychain once this marker exists in
// the secrets folder (see packages/shared/src/credentialKeychain.ts), otherwise as
// <secretsDir>/<name>.bin.
const (
	keychainService    = "hhhcode" // kept from before the rename to p0code
	keychainMarkerFile = "keychain-backend"
)

var errSecretMissing = errors.New("secret not found")

// readSecret loads a credential the legacy server created. It never creates one.
func readSecret(secretsDir, name string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(secretsDir, name+".bin"))
	if err == nil && len(data) > 0 {
		return data, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if os.Getenv("P0CODE_SECRET_BACKEND") == "file" || os.Getenv("HHHCODE_SECRET_BACKEND") == "file" {
		return nil, errSecretMissing
	}
	if _, err := os.Stat(filepath.Join(secretsDir, keychainMarkerFile)); err != nil {
		return nil, errSecretMissing
	}
	return readKeychainSecret(secretsDir, name)
}

// credentialNamespace mirrors credentialNamespace(): sha256 of the resolved secrets
// folder, first 16 hex chars. A folder under ~/.p0code hashes as its pre-rename ~/.hhh
// path so moved homes keep their keychain entries (see previousAppHomePath()).
func credentialNamespace(secretsDir string) string {
	abs := resolvePath(secretsDir)
	if home, err := os.UserHomeDir(); err == nil {
		home = resolvePath(home)
		next := filepath.Join(home, ".p0code")
		if abs == next || strings.HasPrefix(abs, next+string(filepath.Separator)) {
			abs = filepath.Join(home, ".hhh", strings.TrimPrefix(abs, next))
		}
	}
	sum := sha256.Sum256([]byte(abs))
	return hex.EncodeToString(sum[:])[:16]
}

func resolvePath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

var chunkedHead = regexp.MustCompile(`^c:([0-9a-f]+):(\d+)$`)

func readKeychainSecret(secretsDir, name string) ([]byte, error) {
	ns := credentialNamespace(secretsDir)
	head, err := keyring.Get(keychainService, ns+":"+name)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, errSecretMissing
	}
	if err != nil {
		return nil, fmt.Errorf("read %s from keychain: %w", name, err)
	}
	if b64, ok := strings.CutPrefix(head, "b:"); ok {
		return base64.StdEncoding.DecodeString(b64)
	}
	m := chunkedHead.FindStringSubmatch(head)
	if m == nil {
		return nil, fmt.Errorf("unrecognized keychain entry for %s", name)
	}
	count, _ := strconv.Atoi(m[2])
	var b64 strings.Builder
	for i := range count {
		chunk, err := keyring.Get(keychainService, fmt.Sprintf("%s#%s.%d:%s", ns, m[1], i, name))
		if err != nil {
			return nil, fmt.Errorf("keychain entry %s is incomplete: %w", name, err)
		}
		b64.WriteString(chunk)
	}
	return base64.StdEncoding.DecodeString(b64.String())
}

// createMarker writes a single-use marker file, failing with os.ErrExist when it is
// already there. DPoP replay markers are shared with the legacy server this way.
func createMarker(secretsDir, name string, content []byte) error {
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(secretsDir, name+".bin"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(content)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
