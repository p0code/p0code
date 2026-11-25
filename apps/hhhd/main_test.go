package main

import (
	"slices"
	"testing"
)

func TestSplitCommand(t *testing.T) {
	cases := map[string][]string{
		`node /opt/hhhd/legacy/bin.mjs serve`:            {"node", "/opt/hhhd/legacy/bin.mjs", "serve"},
		`"C:\Program Files\node.exe" 'a b' "say \"hi\""`: {`C:\Program Files\node.exe`, "a b", `say "hi"`},
		``: nil,
	}
	for line, want := range cases {
		got, err := splitCommand(line)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("splitCommand(%q) = %q, %v; want %q", line, got, err, want)
		}
	}
	if _, err := splitCommand(`node "unterminated`); err == nil {
		t.Error("unterminated quote accepted")
	}
}
