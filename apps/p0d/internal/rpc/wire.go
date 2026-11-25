// Package rpc speaks the effect/rpc JSON-over-WebSocket protocol that apps/server
// serves on /ws. See docs/internals/backend-split/PROTOCOL.md.
package rpc

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// envelope is any client or server message. Only the routing fields are decoded;
// payloads stay raw so proxied frames are never re-encoded.
type envelope struct {
	Tag       string          `json:"_tag"`
	ID        json.RawMessage `json:"id,omitempty"`
	RequestID json.RawMessage `json:"requestId,omitempty"`
	Method    string          `json:"tag,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Headers   json.RawMessage `json:"headers,omitempty"`
	Discard   bool            `json:"discard,omitempty"`
	Notify    bool            `json:"isNotification,omitempty"`
}

// decodeFrame splits one text frame into messages. The JSON serialization accepts
// either a single object or an array of them.
func decodeFrame(frame []byte) ([]json.RawMessage, error) {
	trimmed := bytes.TrimLeft(frame, " \t\r\n")
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var batch []json.RawMessage
		err := json.Unmarshal(trimmed, &batch)
		return batch, err
	}
	return []json.RawMessage{frame}, nil
}

// requestKey normalizes an id ("1" and 1 are different ids on the wire, but the raw
// JSON text keeps them apart).
func requestKey(id json.RawMessage) string { return string(id) }

var pongFrame = []byte(`{"_tag":"Pong"}`)

func chunkFrame(id json.RawMessage, values []any) ([]byte, error) {
	return json.Marshal(struct {
		Tag       string          `json:"_tag"`
		RequestID json.RawMessage `json:"requestId"`
		Values    []any           `json:"values"`
	}{"Chunk", id, values})
}

type causeEntry struct {
	Tag     string `json:"_tag"`
	Error   any    `json:"error,omitempty"`
	Defect  any    `json:"defect,omitempty"`
	FiberID *int   `json:"fiberId,omitempty"`
}

type exitBody struct {
	Tag   string       `json:"_tag"`
	Value any          `json:"value,omitempty"`
	Cause []causeEntry `json:"cause,omitempty"`
}

func exitFrame(id json.RawMessage, exit any) []byte {
	b, err := json.Marshal(struct {
		Tag       string          `json:"_tag"`
		RequestID json.RawMessage `json:"requestId"`
		Exit      any             `json:"exit"`
	}{"Exit", id, exit})
	if err != nil {
		return exitFrame(id, dieExit("p0d: failed to encode response: "+err.Error()))
	}
	return b
}

// successExit encodes Exit.succeed(value). Stream RPCs and void results send null.
func successExit(value any) any {
	if value == nil {
		return json.RawMessage(`{"_tag":"Success","value":null}`)
	}
	return struct {
		Tag   string `json:"_tag"`
		Value any    `json:"value"`
	}{"Success", value}
}

func failExit(err any) exitBody {
	return exitBody{Tag: "Failure", Cause: []causeEntry{{Tag: "Fail", Error: err}}}
}

// dieExit encodes Exit.die(defect). Strings stay strings; errors become {name, message}
// like Schema.Defect does for Error instances.
func dieExit(defect any) exitBody {
	return exitBody{Tag: "Failure", Cause: []causeEntry{{Tag: "Die", Defect: defect}}}
}

func interruptExit() any {
	return json.RawMessage(`{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":null}]}`)
}

func errorDefect(err error) any {
	return map[string]string{"name": "Error", "message": err.Error()}
}

func defectFrame(defect any) []byte {
	b, _ := json.Marshal(struct {
		Tag    string `json:"_tag"`
		Defect any    `json:"defect"`
	}{"Defect", defect})
	return b
}

const (
	// partBytes matches SOCKET_FRAME_PART_BYTES in packages/shared/src/socketFrameParts.ts.
	partBytes  = 48 * 1024
	partPrefix = "\x1e"
)

// splitFrame cuts a frame into parts of at most partBytes UTF-8 bytes, never inside a
// code point. Every part but the last starts with a record separator.
func splitFrame(frame []byte) [][]byte {
	if len(frame) <= partBytes {
		return [][]byte{frame}
	}
	var parts [][]byte
	budget := partBytes - len(partPrefix)
	for len(frame) > partBytes {
		cut := budget
		for cut > 0 && !utf8.RuneStart(frame[cut]) {
			cut--
		}
		part := make([]byte, 0, cut+1)
		part = append(part, partPrefix...)
		part = append(part, frame[:cut]...)
		parts = append(parts, part)
		frame = frame[cut:]
	}
	return append(parts, frame)
}
