package rpc

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitFrame(t *testing.T) {
	small := []byte(`{"_tag":"Pong"}`)
	if parts := splitFrame(small); len(parts) != 1 || string(parts[0]) != string(small) {
		t.Fatalf("small frame split: %q", parts)
	}
	// Mixed 1-, 3- and 4-byte runes so cuts land inside code points.
	frame := []byte(`{"v":"` + strings.Repeat("a€😀", 20000) + `"}`)
	parts := splitFrame(frame)
	var joined strings.Builder
	for i, part := range parts {
		if len(part) > partBytes {
			t.Fatalf("part %d is %d bytes", i, len(part))
		}
		last := i == len(parts)-1
		if strings.HasPrefix(string(part), partPrefix) == last {
			t.Fatalf("part %d prefix wrong (last=%v)", i, last)
		}
		body := strings.TrimPrefix(string(part), partPrefix)
		if !utf8.ValidString(body) {
			t.Fatalf("part %d cuts a code point", i)
		}
		joined.WriteString(body)
	}
	if joined.String() != string(frame) {
		t.Fatal("parts do not join back to the frame")
	}
}

func TestDecodeFrame(t *testing.T) {
	msgs, err := decodeFrame([]byte(` [{"_tag":"Ping"},{"_tag":"Eof"}]`))
	if err != nil || len(msgs) != 2 {
		t.Fatalf("batch: %v %v", msgs, err)
	}
	msgs, err = decodeFrame([]byte(`{"_tag":"Ping"}`))
	if err != nil || len(msgs) != 1 {
		t.Fatalf("single: %v %v", msgs, err)
	}
}
