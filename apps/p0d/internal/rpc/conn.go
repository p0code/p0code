package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Identity is the authenticated session behind a client socket.
type Identity struct {
	SessionID string
	Subject   string
	Scopes    []string
}

// Call is one decoded request handed to a Go handler.
type Call struct {
	Identity *Identity
	Method   string
	Payload  json.RawMessage
	Headers  json.RawMessage
}

// UnaryFunc answers a request with one value. Return Fail(...) for an expected error
// (encoded as Exit Fail); any other error becomes a defect (Exit Die).
type UnaryFunc func(ctx context.Context, call *Call) (any, error)

// StreamFunc emits chunks until it returns. emit blocks until the client acks the
// chunk, like effect/rpc does. ctx ends when the client interrupts or disconnects.
type StreamFunc func(ctx context.Context, call *Call, emit func(values ...any) error) error

type handler struct {
	scope  string
	unary  UnaryFunc
	stream StreamFunc
}

// Registry holds the methods ported to Go. Every other method goes to the legacy server.
type Registry struct{ handlers map[string]handler }

func NewRegistry() *Registry { return &Registry{handlers: map[string]handler{}} }

// Unary registers a request/response method guarded by scope ("" means any session).
func (r *Registry) Unary(method, scope string, fn UnaryFunc) {
	r.handlers[method] = handler{scope: scope, unary: fn}
}

// Stream registers a streaming method guarded by scope.
func (r *Registry) Stream(method, scope string, fn StreamFunc) {
	r.handlers[method] = handler{scope: scope, stream: fn}
}

// Failure is an expected RPC error. Value is encoded as-is, so tagged errors should be
// maps or structs carrying "_tag".
type Failure struct{ Value any }

func (f *Failure) Error() string { return fmt.Sprintf("rpc failure: %v", f.Value) }

// Fail wraps an expected error value.
func Fail(value any) error { return &Failure{Value: value} }

// Dialer opens a socket to the legacy server for one client socket. release is called
// once the socket is closed.
type Dialer func(ctx context.Context) (ws *websocket.Conn, release func(), err error)

const (
	heartbeatInterval = 20 * time.Second
	readLimit         = 256 << 20
	defaultUpIdle     = 30 * time.Second
)

// Conn serves one client socket.
type Conn struct {
	ws    *websocket.Conn
	id    *Identity
	reg   *Registry
	dial  Dialer
	split bool
	// UpstreamIdle closes the legacy socket this long after its last request ends.
	UpstreamIdle time.Duration

	ctx     context.Context
	writeMu sync.Mutex

	mu    sync.Mutex
	calls map[string]*goCall
	up    *upstream
}

type goCall struct {
	cancel context.CancelFunc
	acks   chan struct{}
}

type upstream struct {
	out      chan []byte
	done     chan struct{}
	inflight map[string]json.RawMessage
	idle     *time.Timer
}

// NewConn wraps an accepted socket. split enables frame parts (the client asked for
// them with ?frameParts=1). dial may be nil when there is no legacy server.
func NewConn(ws *websocket.Conn, id *Identity, reg *Registry, dial Dialer, split bool) *Conn {
	ws.SetReadLimit(readLimit)
	return &Conn{ws: ws, id: id, reg: reg, dial: dial, split: split, UpstreamIdle: defaultUpIdle, calls: map[string]*goCall{}}
}

// Serve runs until the client disconnects or ctx ends.
func (c *Conn) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.ctx = ctx
	defer func() {
		c.mu.Lock()
		up := c.up
		c.mu.Unlock()
		if up != nil {
			c.dropUpstream(up, "p0d: client disconnected")
		}
	}()
	go c.heartbeat(ctx)
	for {
		_, frame, err := c.ws.Read(ctx)
		if err != nil {
			return err
		}
		messages, err := decodeFrame(frame)
		if err != nil {
			c.write(defectFrame(map[string]string{"name": "SyntaxError", "message": err.Error()}))
			continue
		}
		for _, raw := range messages {
			c.handle(raw)
		}
	}
}

// Close ends the socket, e.g. when its session is revoked.
func (c *Conn) Close(reason string) { c.ws.Close(websocket.StatusNormalClosure, reason) }

func (c *Conn) heartbeat(ctx context.Context) {
	// Proxies drop sockets after ~60s without upstream bytes; clients ignore unsolicited pongs.
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.write(pongFrame)
		}
	}
}

func (c *Conn) write(frame []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	parts := [][]byte{frame}
	if c.split {
		parts = splitFrame(frame)
	}
	for _, part := range parts {
		if err := c.ws.Write(c.ctx, websocket.MessageText, part); err != nil {
			return err
		}
	}
	return nil
}

func (c *Conn) handle(raw json.RawMessage) {
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.write(defectFrame(map[string]string{"name": "SyntaxError", "message": err.Error()}))
		return
	}
	switch env.Tag {
	case "Ping":
		c.write(pongFrame)
	case "Request":
		c.request(raw, &env)
	case "Ack", "Interrupt":
		c.control(raw, &env)
	case "Eof":
	default:
		c.write(defectFrame("Unknown request tag: " + env.Tag))
	}
}

func validID(id json.RawMessage) bool {
	if len(id) == 0 {
		return false
	}
	switch id[0] {
	case '"', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return true
	}
	return false
}

func (c *Conn) request(raw json.RawMessage, env *envelope) {
	if !validID(env.ID) && !env.Notify {
		c.write(defectFrame("Invalid request id: " + string(env.ID)))
		return
	}
	key := requestKey(env.ID)
	c.mu.Lock()
	_, busy := c.calls[key]
	if c.up != nil {
		_, proxied := c.up.inflight[key]
		busy = busy || proxied
	}
	c.mu.Unlock()
	if busy && !env.Notify {
		return
	}
	if h, ok := c.reg.handlers[env.Method]; ok {
		c.runGo(h, env, key)
		return
	}
	if c.dial == nil {
		if !env.Notify {
			c.write(exitFrame(env.ID, dieExit("Unknown request tag: "+env.Method)))
		}
		return
	}
	c.proxy(key, env.ID, raw, env.Notify)
}

func (c *Conn) control(raw json.RawMessage, env *envelope) {
	key := requestKey(env.RequestID)
	c.mu.Lock()
	call := c.calls[key]
	var up *upstream
	if c.up != nil {
		if _, ok := c.up.inflight[key]; ok {
			up = c.up
		}
	}
	c.mu.Unlock()
	switch {
	case call != nil && env.Tag == "Ack":
		select {
		case call.acks <- struct{}{}:
		default:
		}
	case call != nil:
		call.cancel()
	case up != nil:
		select {
		case up.out <- raw:
		case <-up.done:
		}
	}
}

// authorizationError mirrors rpcAuthorizationError in apps/server/src/auth/RpcAuthorization.ts.
func authorizationError(scope string) map[string]string {
	parent := scope
	switch scope {
	case "relay:configure":
		parent = "relay:write"
	case "filesystem:read", "diagnostics:read":
		parent = "orchestration:read"
	case "settings:write", "providers:manage", "environment:maintain", "preview:operate", "source-control:write", "filesystem:write", "plugins:manage":
		parent = "orchestration:operate"
	case "terminal:read":
		parent = "terminal:operate"
	}
	return map[string]string{
		"_tag":               "EnvironmentAuthorizationError",
		"message":            "The authenticated token is missing required scope: " + scope + ".",
		"requiredScope":      parent,
		"requiredPermission": scope,
	}
}

func (c *Conn) runGo(h handler, env *envelope, key string) {
	silent := env.Notify || env.Discard
	if h.scope != "" && !slices.Contains(c.id.Scopes, h.scope) {
		if !env.Notify {
			c.write(exitFrame(env.ID, failExit(authorizationError(h.scope))))
		}
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	call := &goCall{cancel: cancel, acks: make(chan struct{}, 1)}
	if !env.Notify {
		c.mu.Lock()
		c.calls[key] = call
		c.mu.Unlock()
	}
	if env.Discard {
		c.write(exitFrame(env.ID, successExit(nil)))
	}
	info := &Call{Identity: c.id, Method: env.Method, Payload: env.Payload, Headers: env.Headers}
	id := env.ID
	go func() {
		defer func() {
			cancel()
			c.mu.Lock()
			if c.calls[key] == call {
				delete(c.calls, key)
			}
			c.mu.Unlock()
		}()
		var value any
		var err error
		if h.unary != nil {
			value, err = h.unary(ctx, info)
		} else {
			err = h.stream(ctx, info, func(values ...any) error {
				if len(values) == 0 || silent {
					return ctx.Err()
				}
				frame, err := chunkFrame(id, values)
				if err != nil {
					return err
				}
				if err := c.write(frame); err != nil {
					return err
				}
				select {
				case <-call.acks:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			})
		}
		if silent {
			return
		}
		var exit any
		var failure *Failure
		switch {
		case ctx.Err() != nil:
			exit = interruptExit()
		case asFailure(err, &failure):
			exit = failExit(failure.Value)
		case err != nil:
			exit = dieExit(errorDefect(err))
		default:
			exit = successExit(value)
		}
		c.write(exitFrame(id, exit))
	}()
}

func asFailure(err error, target **Failure) bool {
	f, ok := err.(*Failure)
	if ok {
		*target = f
	}
	return ok
}

// proxy forwards one request to the legacy server over this client's upstream socket.
// The client's request id is reused as-is: one upstream socket serves one client.
func (c *Conn) proxy(key string, id, raw json.RawMessage, notify bool) {
	c.mu.Lock()
	up := c.up
	if up == nil {
		up = &upstream{out: make(chan []byte, 256), done: make(chan struct{}), inflight: map[string]json.RawMessage{}}
		c.up = up
		go c.runUpstream(up)
	}
	if !notify {
		up.inflight[key] = id
		if up.idle != nil {
			up.idle.Stop()
			up.idle = nil
		}
	}
	c.mu.Unlock()
	select {
	case up.out <- raw:
	case <-up.done:
		// It failed between taking it and sending; the drop already answered inflight ids.
	}
}

func (c *Conn) runUpstream(up *upstream) {
	ws, release, err := c.dial(c.ctx)
	if err != nil {
		c.dropUpstream(up, "p0d: legacy server unavailable: "+err.Error())
		return
	}
	defer release()
	defer ws.CloseNow()
	ws.SetReadLimit(readLimit)
	go c.readUpstream(up, ws)
	for {
		select {
		case <-up.done:
			ws.Close(websocket.StatusNormalClosure, "")
			return
		case frame := <-up.out:
			if err := ws.Write(c.ctx, websocket.MessageText, frame); err != nil {
				c.dropUpstream(up, "p0d: legacy server connection failed: "+err.Error())
				return
			}
		}
	}
}

func (c *Conn) readUpstream(up *upstream, ws *websocket.Conn) {
	for {
		_, frame, err := ws.Read(c.ctx)
		if err != nil {
			c.dropUpstream(up, "p0d: legacy server connection closed")
			return
		}
		var env envelope
		if json.Unmarshal(frame, &env) != nil {
			continue
		}
		switch env.Tag {
		case "Chunk", "Exit":
			key := requestKey(env.RequestID)
			c.mu.Lock()
			_, known := up.inflight[key]
			if known && env.Tag == "Exit" {
				delete(up.inflight, key)
				c.armIdle(up)
			}
			c.mu.Unlock()
			if known {
				c.write(frame)
			}
		case "Defect":
			// A socket-level defect would end every request on the client socket,
			// including Go-handled ones, so it only fails the proxied requests.
			var defect struct {
				Defect json.RawMessage `json:"defect"`
			}
			json.Unmarshal(frame, &defect)
			c.failInflight(up, defect.Defect)
		}
	}
}

// armIdle closes an upstream that has nothing in flight. Caller holds c.mu.
func (c *Conn) armIdle(up *upstream) {
	if len(up.inflight) > 0 || up.idle != nil {
		return
	}
	up.idle = time.AfterFunc(c.UpstreamIdle, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.up == up && len(up.inflight) == 0 {
			c.up = nil
			close(up.done)
		}
	})
}

func (c *Conn) failInflight(up *upstream, defect any) {
	c.mu.Lock()
	ids := up.inflight
	up.inflight = map[string]json.RawMessage{}
	c.armIdle(up)
	c.mu.Unlock()
	for _, id := range ids {
		c.write(exitFrame(id, dieExit(defect)))
	}
}

func (c *Conn) dropUpstream(up *upstream, reason string) {
	c.mu.Lock()
	select {
	case <-up.done:
		c.mu.Unlock()
		return
	default:
	}
	close(up.done)
	if c.up == up {
		c.up = nil
	}
	if up.idle != nil {
		up.idle.Stop()
	}
	ids := up.inflight
	up.inflight = map[string]json.RawMessage{}
	c.mu.Unlock()
	for _, id := range ids {
		c.write(exitFrame(id, dieExit(reason)))
	}
}
