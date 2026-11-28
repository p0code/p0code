package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// desktopTokenWindow is DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS in packages/shared/src/desktopBootstrapToken.ts.
const desktopTokenWindow = 12 * time.Hour

const minDesktopSecretBytes = 32

// DesktopSecret is the GUI's desktop bootstrap secret. Clients never send it: they send
// hex(HMAC-SHA256(secret, "t3-desktop-bootstrap:<window>")), exactly what the Node
// server accepts from the same secret, so either backend signs the desktop in.
type DesktopSecret struct {
	key []byte
}

// LoadDesktopSecret reads the secret once at startup; rotating it means restarting p0d.
// A missing, empty, short, malformed or group/other-accessible file is an error, so a
// misconfigured GUI fails at launch instead of at its first sign-in.
func LoadDesktopSecret(path string) (*DesktopSecret, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("desktop bootstrap secret: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("desktop bootstrap secret %s is not a regular file", path)
	}
	// Windows has no POSIX mode bits; its ACLs are the GUI's job.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("desktop bootstrap secret %s is accessible by group or others (mode %04o); chmod 600 it", path, info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("desktop bootstrap secret: %w", err)
	}
	secret, err := parseDesktopSecret(string(data))
	if err != nil {
		return nil, fmt.Errorf("desktop bootstrap secret %s: %w", path, err)
	}
	return secret, nil
}

func parseDesktopSecret(text string) (*DesktopSecret, error) {
	secret := strings.TrimSpace(text)
	if secret == "" {
		return nil, errors.New("file is empty")
	}
	raw, err := decodeB64url(secret)
	if err != nil {
		return nil, errors.New("not base64url")
	}
	if len(raw) < minDesktopSecretBytes {
		return nil, fmt.Errorf("decodes to %d bytes, need at least %d", len(raw), minDesktopSecretBytes)
	}
	// The Node server keys the HMAC with the secret's UTF-8 text, not its decoded bytes.
	return &DesktopSecret{key: []byte(secret)}, nil
}

// Token is the credential a client presents during the window that contains now.
func (d *DesktopSecret) Token(now time.Time) string {
	return d.token(now.UnixMilli() / desktopTokenWindow.Milliseconds())
}

func (d *DesktopSecret) token(window int64) string {
	mac := hmac.New(sha256.New, d.key)
	mac.Write([]byte("t3-desktop-bootstrap:" + strconv.FormatInt(window, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// Matches mirrors isValidDesktopBootstrapToken: the previous, current and next windows
// are accepted, the next one for clock lag between WSL and Windows.
func (d *DesktopSecret) Matches(token string, now time.Time) bool {
	presented := []byte(strings.TrimSpace(token))
	current := now.UnixMilli() / desktopTokenWindow.Milliseconds()
	ok := false
	for _, window := range []int64{current - 1, current, current + 1} {
		if hmac.Equal([]byte(d.token(window)), presented) {
			ok = true
		}
	}
	return ok
}
