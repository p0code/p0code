package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"p0d/internal/authtest"
)

// The test binary doubles as a fake legacy server when P0D_FAKE_LEGACY is set, so the
// sidecar manager can start it like the real one.
func TestMain(m *testing.M) {
	if os.Getenv("P0D_FAKE_LEGACY") == "1" {
		runFakeLegacy()
		return
	}
	os.Setenv("P0CODE_SECRET_BACKEND", "file")
	os.Exit(m.Run())
}

func runFakeLegacy() {
	var port string
	for i, arg := range os.Args {
		if arg == "--port" {
			port = os.Args[i+1]
		}
	}
	token := os.Getenv("P0D_INTERNAL_TOKEN")
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/t3/environment", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) })
	mux.HandleFunc("/api/echo", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "t3_session_9_abc", Value: "issued"})
		json.NewEncoder(w).Encode(map[string]string{
			"token":         r.Header.Get("X-P0d-Internal-Token"),
			"session":       r.Header.Get("X-P0d-Session-Id"),
			"authorization": r.Header.Get("Authorization"),
			"host":          r.Host,
			"forwardedFor":  r.Header.Get("X-Forwarded-For"),
		})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-P0d-Internal-Token") != token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		session := r.Header.Get("X-P0d-Session-Id")
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ws.SetReadLimit(-1)
		ctx := r.Context()
		acks := make(chan struct{}, 8)
		write := func(v any) {
			b, _ := json.Marshal(v)
			ws.Write(ctx, websocket.MessageText, b)
		}
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var msg struct {
				Tag     string          `json:"_tag"`
				ID      json.RawMessage `json:"id"`
				Method  string          `json:"tag"`
				Payload json.RawMessage `json:"payload"`
			}
			json.Unmarshal(data, &msg)
			switch {
			case msg.Tag == "Ack":
				acks <- struct{}{}
			case msg.Tag == "Ping":
				write(map[string]string{"_tag": "Pong"})
			case msg.Method == "legacy.echo":
				write(map[string]any{"_tag": "Exit", "requestId": msg.ID, "exit": map[string]any{
					"_tag": "Success", "value": map[string]any{"session": session, "query": r.URL.RawQuery, "payload": msg.Payload},
				}})
			case msg.Method == "legacy.stream":
				go func(id json.RawMessage) {
					for i := 1; i <= 2; i++ {
						write(map[string]any{"_tag": "Chunk", "requestId": id, "values": []int{i}})
						<-acks
					}
					write(map[string]any{"_tag": "Exit", "requestId": id, "exit": map[string]any{"_tag": "Success", "value": nil}})
				}(msg.ID)
			case msg.Method == "legacy.defect":
				write(map[string]any{"_tag": "Defect", "defect": "fake defect"})
			case msg.Method == "legacy.hang":
			}
		}
	})
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, mux))
}

type harness struct {
	t     *testing.T
	home  *authtest.Home
	srv   *Server
	token string
}

func start(t *testing.T, legacy bool) *harness {
	t.Helper()
	home := authtest.New(t)
	home.AddSession(t, "s1", "client", authtest.AllScopes, "")
	cfg := Config{Home: home.Dir, Host: "127.0.0.1", ReadyFile: home.Dir + "/ready.json", Version: "test", LegacyIdle: 200 * time.Millisecond,
		Logger: log.New(io.Discard, "", 0)}
	if legacy {
		t.Setenv("P0D_FAKE_LEGACY", "1")
		cfg.Legacy = []string{os.Args[0]}
	}
	srv, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	return &harness{t: t, home: home, srv: srv, token: home.SessionToken("s1", "client", time.Hour, "")}
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func (h *harness) dial(query string, token string) *client {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := strings.Replace(h.srv.URL(), "http", "ws", 1) + "/ws?orchestrationProtocol=2" + query
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}, CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	ws.SetReadLimit(-1)
	h.t.Cleanup(func() { ws.CloseNow() })
	return &client{t: h.t, ws: ws}
}

func (c *client) send(frame string) {
	c.t.Helper()
	if err := c.ws.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
		c.t.Fatal(err)
	}
}

// next returns the next message that is not a heartbeat, joining frame parts.
func (c *client) next() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pending := ""
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			c.t.Fatal(err)
		}
		frame := string(data)
		if strings.HasPrefix(frame, "\x1e") {
			pending += frame[1:]
			continue
		}
		frame, pending = pending+frame, ""
		var msg map[string]any
		if err := json.Unmarshal([]byte(frame), &msg); err != nil {
			c.t.Fatalf("bad frame %q: %v", frame, err)
		}
		if msg["_tag"] != "Pong" {
			return msg
		}
	}
}

func exitOf(t *testing.T, msg map[string]any) map[string]any {
	t.Helper()
	if msg["_tag"] != "Exit" {
		t.Fatalf("want Exit, got %v", msg)
	}
	return msg["exit"].(map[string]any)
}

func TestHealthzAndReadyFile(t *testing.T) {
	h := start(t, false)
	res, err := http.Get(h.srv.URL() + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", res, err)
	}
	data, err := os.ReadFile(h.home.Dir + "/ready.json")
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Pid  int    `json:"pid"`
		Port int    `json:"port"`
		URL  string `json:"url"`
	}
	json.Unmarshal(data, &ready)
	if ready.Pid != os.Getpid() || ready.Port != h.srv.Port() || ready.URL != h.srv.URL() {
		t.Fatalf("ready file %s", data)
	}
}

func TestUpgradeRejections(t *testing.T) {
	h := start(t, false)
	ws := strings.Replace(h.srv.URL(), "http", "ws", 1) + "/ws"
	ctx := context.Background()
	if _, res, err := websocket.Dial(ctx, ws, nil); err == nil || res.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("missing protocol: %v %v", res, err)
	}
	_, res, err := websocket.Dial(ctx, ws+"?orchestrationProtocol=2", nil)
	if err == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing credential: %v %v", res, err)
	}
	var body map[string]string
	json.NewDecoder(res.Body).Decode(&body)
	if body["_tag"] != "EnvironmentAuthInvalidError" || body["reason"] != "missing_credential" {
		t.Fatalf("401 body %v", body)
	}
}

func TestNativeMethods(t *testing.T) {
	h := start(t, false)
	c := h.dial("", h.token)

	c.send(`{"_tag":"Ping"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, data, err := c.ws.Read(ctx); err != nil || string(data) != `{"_tag":"Pong"}` {
		t.Fatalf("ping: %s %v", data, err)
	}

	c.send(`{"_tag":"Request","id":0,"tag":"server.probe","payload":{},"headers":[]}`)
	msg := c.next()
	exit := exitOf(t, msg)
	if msg["requestId"] != float64(0) || exit["_tag"] != "Success" || exit["value"].(map[string]any)["serverTime"] == "" {
		t.Fatalf("probe: %v", msg)
	}

	// String ids come back as strings; batches are allowed.
	c.send(`[{"_tag":"Request","id":"a","tag":"nope","payload":{},"headers":[]},{"_tag":"Request","id":"b","tag":"server.probe","payload":{},"headers":[]}]`)
	first, second := c.next(), c.next()
	if first["requestId"] != "a" || second["requestId"] != "b" {
		t.Fatalf("batch: %v %v", first, second)
	}
	cause := exitOf(t, first)["cause"].([]any)[0].(map[string]any)
	if cause["_tag"] != "Die" || cause["defect"] != "Unknown request tag: nope" {
		t.Fatalf("unknown tag: %v", first)
	}

	c.send(`{"_tag":"Request","id":5,"tag":"p0d.subscribeStatus","payload":{},"headers":[]}`)
	chunk := c.next()
	values := chunk["values"].([]any)
	if chunk["_tag"] != "Chunk" || values[0].(map[string]any)["version"] != "test" {
		t.Fatalf("status chunk: %v", chunk)
	}
	c.send(`{"_tag":"Ack","requestId":5}`)
	c.send(`{"_tag":"Interrupt","requestId":5,"interruptors":[]}`)
	cause = exitOf(t, c.next())["cause"].([]any)[0].(map[string]any)
	if cause["_tag"] != "Interrupt" {
		t.Fatalf("interrupt: %v", cause)
	}

	c.send(`{"_tag":"Bogus"}`)
	if msg := c.next(); msg["_tag"] != "Defect" || msg["defect"] != "Unknown request tag: Bogus" {
		t.Fatalf("bogus: %v", msg)
	}
}

func TestScopeCheck(t *testing.T) {
	h := start(t, false)
	h.home.AddSession(t, "limited", "client", []string{"access:read"}, "")
	c := h.dial("", h.home.SessionToken("limited", "client", time.Hour, ""))
	c.send(`{"_tag":"Request","id":1,"tag":"server.probe","payload":{},"headers":[]}`)
	cause := exitOf(t, c.next())["cause"].([]any)[0].(map[string]any)
	failure := cause["error"].(map[string]any)
	if cause["_tag"] != "Fail" || failure["_tag"] != "EnvironmentAuthorizationError" || failure["requiredScope"] != "orchestration:read" {
		t.Fatalf("scope failure: %v", cause)
	}
}

func TestSessionRevocationClosesSocket(t *testing.T) {
	old := sessionCheckInterval
	sessionCheckInterval = 50 * time.Millisecond
	t.Cleanup(func() { sessionCheckInterval = old })
	h := start(t, false)
	c := h.dial("", h.token)
	h.home.Revoke(t, "s1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.ws.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				t.Fatalf("want normal close, got %v", err)
			}
			return
		}
	}
}

func TestProxyToLegacy(t *testing.T) {
	oldIdle := upstreamIdle
	upstreamIdle = 100 * time.Millisecond
	t.Cleanup(func() { upstreamIdle = oldIdle })
	h := start(t, true)
	if st, _ := h.srv.Legacy().Status(); st.State != "stopped" {
		t.Fatalf("legacy started eagerly: %+v", st)
	}

	c := h.dial("&clientSurface=web&frameParts=1&dpop=ignored", h.token)
	big := strings.Repeat("é", 60*1024)
	c.send(`{"_tag":"Request","id":1,"tag":"legacy.echo","payload":{"text":"` + big + `"},"headers":[]}`)
	c.send(`{"_tag":"Request","id":2,"tag":"server.probe","payload":{},"headers":[]}`)
	got := map[float64]map[string]any{}
	for range 2 {
		msg := c.next()
		got[msg["requestId"].(float64)] = exitOf(t, msg)
	}
	echo := got[1]["value"].(map[string]any)
	if echo["session"] != "s1" || echo["query"] != "clientSurface=web&orchestrationProtocol=2" {
		t.Fatalf("legacy saw %v", echo)
	}
	if echo["payload"].(map[string]any)["text"] != big {
		t.Fatal("large proxied frame did not survive frame parts")
	}
	if got[2]["_tag"] != "Success" {
		t.Fatalf("native call next to proxied call: %v", got[2])
	}

	c.send(`{"_tag":"Request","id":3,"tag":"legacy.stream","payload":{},"headers":[]}`)
	for i := 1; i <= 2; i++ {
		chunk := c.next()
		if chunk["_tag"] != "Chunk" || chunk["values"].([]any)[0] != float64(i) {
			t.Fatalf("chunk %d: %v", i, chunk)
		}
		c.send(`{"_tag":"Ack","requestId":3}`)
	}
	if exitOf(t, c.next())["_tag"] != "Success" {
		t.Fatal("stream did not end")
	}

	// A legacy socket defect fails only the proxied requests in flight.
	c.send(`{"_tag":"Request","id":4,"tag":"legacy.hang","payload":{},"headers":[]}`)
	c.send(`{"_tag":"Request","id":5,"tag":"legacy.defect","payload":{},"headers":[]}`)
	for range 2 {
		cause := exitOf(t, c.next())["cause"].([]any)[0].(map[string]any)
		if cause["_tag"] != "Die" || cause["defect"] != "fake defect" {
			t.Fatalf("defect: %v", cause)
		}
	}

	// HTTP: a verified credential becomes the trusted session header; spoofed headers are dropped.
	req, _ := http.NewRequest("GET", h.srv.URL()+"/api/echo", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var seen map[string]string
	json.NewDecoder(res.Body).Decode(&seen)
	if seen["session"] != "s1" || seen["authorization"] != "" || seen["token"] == "" || seen["forwardedFor"] != "127.0.0.1" {
		t.Fatalf("legacy saw %v", seen)
	}
	if !strings.HasPrefix(res.Header.Get("Set-Cookie"), h.srv.auth.CookieName+"=issued") {
		t.Fatalf("cookie not renamed: %s", res.Header.Get("Set-Cookie"))
	}
	req, _ = http.NewRequest("GET", h.srv.URL()+"/api/echo", nil)
	req.Header.Set("X-P0d-Session-Id", "s1")
	req.Header.Set("X-P0d-Internal-Token", "guess")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	seen = nil
	json.NewDecoder(res.Body).Decode(&seen)
	if seen["session"] != "" || seen["token"] != "" {
		t.Fatalf("spoofed identity reached legacy: %v", seen)
	}

	// Idle: the client's legacy socket closes, then the legacy server stops.
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, _ := h.srv.Legacy().Status()
		if st.State == "stopped" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("legacy never went idle: %+v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// It starts again on demand.
	c.send(`{"_tag":"Request","id":6,"tag":"legacy.echo","payload":{},"headers":[]}`)
	if exitOf(t, c.next())["_tag"] != "Success" {
		t.Fatal("legacy did not restart")
	}
}
