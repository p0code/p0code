package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math"
	"math/big"
	"net/url"
	"strings"
	"time"
)

// Port of packages/shared/src/dpop.ts.

const dpopMaxSkewSeconds = 300

type dpopResult struct {
	thumbprint string
	jti        string
	iat        int64
}

// dpopFailure carries the failure code; dpopFailureReason maps it to the wire value.
type dpopFailure struct{ code, reason string }

func (f *dpopFailure) Error() string { return f.reason }

func (f *dpopFailure) wireReason() string {
	switch f.code {
	case "time_window", "key_mismatch":
		return f.code
	case "method_mismatch", "url_mismatch":
		return "request_mismatch"
	case "access_token_hash_mismatch":
		return "token_mismatch"
	}
	return "invalid_proof"
}

func b64url(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func decodeB64url(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

type dpopJwk struct {
	Kty string           `json:"kty"`
	Crv string           `json:"crv"`
	X   string           `json:"x"`
	Y   string           `json:"y"`
	D   *json.RawMessage `json:"d"`
}

func jwkThumbprint(jwk dpopJwk) string {
	// RFC 7638: required members in lexicographic order, no whitespace.
	canonical, _ := json.Marshal(struct {
		Crv string `json:"crv"`
		Kty string `json:"kty"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}{jwk.Crv, jwk.Kty, jwk.X, jwk.Y})
	sum := sha256.Sum256(canonical)
	return b64url(sum[:])
}

// normalizeHtu mirrors normalizeDpopHtu: the URL without query or fragment, as
// WHATWG URL serializes it.
func normalizeHtu(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && !(scheme == "http" && port == "80") && !(scheme == "https" && port == "443") {
		host += ":" + port
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return scheme + "://" + host + path, true
}

func verifyDpopProof(proof, method, requestURL string, now time.Time, expectedThumbprint, expectedAccessToken string) (*dpopResult, *dpopFailure) {
	if strings.TrimSpace(proof) == "" {
		return nil, &dpopFailure{"missing_proof", "Missing DPoP proof."}
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil, &dpopFailure{"malformed_proof", "Invalid DPoP compact JWT."}
	}
	var header struct {
		Typ string  `json:"typ"`
		Alg string  `json:"alg"`
		Jwk dpopJwk `json:"jwk"`
	}
	headerJSON, err := decodeB64url(parts[0])
	if err != nil || json.Unmarshal(headerJSON, &header) != nil || header.Typ != "dpop+jwt" || header.Alg != "ES256" ||
		header.Jwk.Kty != "EC" || header.Jwk.Crv != "P-256" || header.Jwk.X == "" || header.Jwk.Y == "" || header.Jwk.D != nil {
		return nil, &dpopFailure{"malformed_proof", "Invalid DPoP JWT header."}
	}
	var payload struct {
		Htm string   `json:"htm"`
		Htu string   `json:"htu"`
		Jti string   `json:"jti"`
		Iat *float64 `json:"iat"`
		Ath *string  `json:"ath"`
	}
	payloadJSON, err := decodeB64url(parts[1])
	if err != nil || json.Unmarshal(payloadJSON, &payload) != nil || payload.Htm == "" || payload.Htu == "" ||
		payload.Jti == "" || payload.Iat == nil || *payload.Iat != math.Trunc(*payload.Iat) {
		return nil, &dpopFailure{"malformed_proof", "Invalid DPoP JWT payload."}
	}
	thumbprint := jwkThumbprint(header.Jwk)
	if expectedThumbprint != "" && thumbprint != expectedThumbprint {
		return nil, &dpopFailure{"key_mismatch", "DPoP key thumbprint mismatch."}
	}
	if !strings.EqualFold(payload.Htm, method) {
		return nil, &dpopFailure{"method_mismatch", "DPoP method mismatch."}
	}
	if htu, ok := normalizeHtu(requestURL); !ok || payload.Htu != htu {
		return nil, &dpopFailure{"url_mismatch", "DPoP URL mismatch."}
	}
	if expectedAccessToken != "" {
		sum := sha256.Sum256([]byte(expectedAccessToken))
		if payload.Ath == nil || *payload.Ath != b64url(sum[:]) {
			return nil, &dpopFailure{"access_token_hash_mismatch", "DPoP access token hash mismatch."}
		}
	}
	x, errX := decodeB64url(header.Jwk.X)
	y, errY := decodeB64url(header.Jwk.Y)
	sig, errS := decodeB64url(parts[2])
	if errX != nil || errY != nil || errS != nil || len(x) != 32 || len(y) != 32 || len(sig) != 64 {
		return nil, &dpopFailure{"invalid_proof", "Invalid DPoP proof."}
	}
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !key.Curve.IsOnCurve(key.X, key.Y) {
		return nil, &dpopFailure{"invalid_proof", "Invalid DPoP proof."}
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return nil, &dpopFailure{"invalid_signature", "Invalid DPoP signature."}
	}
	iat := int64(*payload.Iat)
	if d := now.Unix() - iat; d > dpopMaxSkewSeconds || d < -dpopMaxSkewSeconds {
		return nil, &dpopFailure{"time_window", "DPoP proof is outside the allowed time window."}
	}
	return &dpopResult{thumbprint: thumbprint, jti: payload.Jti, iat: iat}, nil
}
