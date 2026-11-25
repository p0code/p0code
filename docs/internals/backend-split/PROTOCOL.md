# Client ↔ backend wire protocol

What web, desktop and mobile clients speak to `apps/server` today, written so a second
server (`apps/p0d`) can implement it. Checked against `effect@4.1.5` (patched,
`node_modules/.pnpm/effect@4.1.5*/node_modules/effect/src/rpc`) and the files linked
below. When this page and the code disagree, the code wins; fix the page.

Everything here is plain HTTP/1.1 plus one WebSocket. All JSON is UTF-8.

## 1. HTTP surface

| Route                                                                                                                                                                          | Auth         | Notes                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `GET /ws`                                                                                                                                                                      | session (§2) | The RPC socket (§3).                                                                         |
| `GET /.well-known/t3/environment`                                                                                                                                              | none         | Environment descriptor. Clients and pairing probe it.                                        |
| `/.well-known/oauth-*`, `/oauth/token`, `/oauth/mcp/*`, `/connect-agent`                                                                                                       | own          | OAuth for devices and MCP clients. Tokens ride in bodies; proofs in the `DPoP` header.       |
| `GET /api/auth/session`                                                                                                                                                        | optional     | `{authenticated:false, auth}` without a credential, never 401.                               |
| `POST /api/auth/browser-session`, `/api/auth/pairing-token`, `/api/auth/websocket-ticket[/:use]`, `/api/auth/clients/*`, `/api/auth/pairing-links/revoke`                      | mixed        | Pairing, cookies, tickets, revocation. Schemas: `packages/contracts/src/environmentHttp.ts`. |
| `/api/orchestration/*`, `/api/projects*`, `/api/pull-requests/diff`, `/api/voice/*`, `/api/relay/*`, `/api/peer-link/*`, assets, attachments, previews, speech, device streams | session      | HTTP side channels for large or binary payloads.                                             |
| `/mcp`                                                                                                                                                                         | MCP bearer   | Only `mcp-client` sessions; every other route rejects them.                                  |
| `GET *`                                                                                                                                                                        | none         | The web app's static files (or a dev redirect).                                              |

Auth failures on these routes return:

```json
HTTP 401
{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential"|"invalid_credential","dpopFailureReason":"…","traceId":"<hex>"}
```

`dpopFailureReason` is present only for DPoP failures (`invalid_proof`, `key_mismatch`,
`request_mismatch`, `token_mismatch`, `time_window`, `replay`). Internal failures are
`500 {"_tag":"EnvironmentInternalError","code":"internal_error","reason":"…","traceId":"…"}`.
Missing scope is `403 {"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":…}`.

## 2. Authentication

Source: `apps/server/src/auth/EnvironmentAuth.ts`, `SessionStore.ts`, `dpop.ts`,
`packages/shared/src/dpop.ts`.

### 2.1 Session tokens

```
token = base64url(JSON claims) "." base64url(HMAC-SHA256(key, <the base64url claims string>))
```

base64url is unpadded. `key` is the 32 random bytes of the server secret
`server-signing-key`: the file `<home>/secrets/server-signing-key.bin`, or, when
`<home>/secrets/keychain-backend` exists (and `P0CODE_SECRET_BACKEND` is not `file`),
the OS keychain entry service `p0code`, account `<ns>:server-signing-key` where
`ns = sha256(realpath(<home>/secrets)).hex[0:16]`. The entry value is `b:<base64>`, or
`c:<gen>:<count>` with chunks at accounts `<ns>#<gen>.<i>:server-signing-key`
(`packages/shared/src/credentialKeychain.ts`).

Session claims: `v` (1|2), `kind:"session"`, `sid`, `sub`, `scopes`, `method`
(`browser-session-cookie` | `bearer-access-token` | `dpop-access-token`), optional `jkt`
(DPoP key thumbprint), `rtc`, `plk:1` (peer link), `rnw:1` (renewable), `iat`, `exp`
(**epoch milliseconds**).

Verification, in order: signature; claims shape; `exp > now` (skipped when `plk:1`,
whose deadline is the row's `expires_at`); row in `auth_sessions` exists; `revoked_at IS
NULL`. **Scopes come from the row, not the token.** Subject `mcp-client` is rejected
everywhere except `/mcp`. The reusable dev token (`T3CODE_DEV_AUTH_TOKEN`) is a
separate path and dev-only.

`auth_sessions` columns used: `session_id, subject, scopes (JSON array), method,
expires_at, revoked_at (ISO-8601 strings with ms, UTC), proof_key_thumbprint`.

### 2.2 Credential selection (HTTP and `/ws`)

First match wins:

1. Cookie named by `resolveSessionCookieName` (`apps/server/src/auth/utils.ts`):
   desktop mode `t3_session_<port>`; web mode on a loopback host
   `t3_session_<port>_<sha256(stateDir)[0:12]>`; web mode on a remote-reachable host
   `t3_session_<sha256(environmentId)[0:12]>`.
2. `Authorization: Bearer <token>`.
3. `Authorization: DPoP <token>`.
4. Legacy cookie `t3_session` (web mode, remote-reachable host only).

Cookie credentials are only accepted when `Origin` is absent, `Sec-Fetch-Site:
same-origin`, a desktop renderer origin (`p0code://app`, `t3code://app`, and `-dev`
variants), or `Origin`'s host equals `Host` / first `X-Forwarded-Host`.

If the session has `jkt`, the request must use `Authorization: DPoP <same token>` and a
valid `DPoP` header proof (§2.4). A DPoP authorization on a session without `jkt` is
rejected.

### 2.3 WebSocket tickets

Browsers cannot set headers on a WebSocket, so clients usually fetch a ticket first:
`POST /api/auth/websocket-ticket` (or `/websocket-ticket/:use`, `use` = `rpc` |
`media`) and connect with `?wsTicket=<ticket>`. Ticket claims: `v:1`,
`kind:"websocket"`, `sid`, optional `aud` (`rpc`|`media`), optional `jkt`, `iat`, `exp`
(5 minutes). Checks: signature, `exp`, row exists, not expired, not revoked, `aud`
matches the route (unset matches any). The session's subject, method and scopes come
from the row. Only `rpc` tickets carry `jkt`; then a proof is required in the `DPoP`
header or the `dpop` query parameter, bound to the ticket (`ath`). A present but invalid
`wsTicket` fails the upgrade; it does not fall back to other credentials.

### 2.4 DPoP proofs

Compact JWS, ES256. Header `{typ:"dpop+jwt", alg:"ES256", jwk:{kty:"EC", crv:"P-256",
x, y}}` (no `d`). Payload `{htm, htu, jti, iat (seconds, integer), ath?}`. Checks in
order: thumbprint (RFC 7638 over `{"crv","kty","x","y"}`, base64url SHA-256) equals the
expected `jkt`; `htm` equals the method (case-insensitive); `htu` equals the request URL
without query or fragment, as WHATWG `URL` serializes it (`X-Forwarded-Proto: https`
makes the scheme https; the host is the `Host` header); `ath = base64url(sha256(access
token or ticket))`; the signature (raw `r‖s`, 64 bytes) over `sha256(header.payload)`;
`|now − iat| ≤ 300 s`. Then the proof is consumed: the server atomically creates
`<home>/secrets/dpop-proof-<base64url(sha256("<thumbprint>:<jti>"))>.bin`; if it exists,
the proof is a replay.

### 2.5 Socket lifetime

A `/ws` socket closes when its session is revoked, or expires without a newer live
session for the same DPoP key (renewal keeps the socket). Clients reconnect with fresh
credentials.

## 3. The `/ws` upgrade

`GET /ws?<query>` with these parameters:

| Param                     | Meaning                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrationProtocol=2` | **Required.** Otherwise `426 {"code":"orchestration_protocol_incompatible","message":…,"orchestrationProtocolVersion":2}` before auth. |
| `wsTicket`, `dpop`        | §2.3.                                                                                                                                  |
| `frameParts`              | Present ⇒ server splits large frames (§4.3). New clients always send it.                                                               |
| `clientSurface`           | `web` / `desktop` / `mobile` etc., for tracing only.                                                                                   |
| `clientCapabilities`      | Comma list; `settingsSecretReferences` changes how settings encode secrets.                                                            |

Order: protocol check → authenticate (`use = "rpc"`) → upgrade. The server negotiates
`permessage-deflate` with context takeover, except for `desktop-bootstrap` sessions.
Each RPC request's `headers` are the upgrade request's headers followed by the headers
the client put in the message.

## 4. Framing

### 4.1 Frames

Text frames, one JSON value each (`RpcSerialization.layerJson`). A client frame may be a
single message object or an array of them; the server always sends single objects.

### 4.2 Liveness

The client sends `{"_tag":"Ping"}` every 5 s and fails every pending request if no frame
of any kind arrives for 15 s (`PING_TIMEOUT`). The server answers each Ping with
`{"_tag":"Pong"}` and also sends an unsolicited `{"_tag":"Pong"}` every 20 s so idle
proxies keep the socket.

### 4.3 Frame parts

With `frameParts`, any server frame larger than 48 KiB (UTF-8) is sent as consecutive
frames of at most 48 KiB; every part except the last starts with `U+001E` and parts
never split a code point. The client buffers prefixed parts and treats each as a Pong
for liveness. Parts of one message are never interleaved with other frames
(`packages/shared/src/socketFrameParts.ts`).

## 5. Messages

Ids are whatever the client chose: effect's client uses a process-wide counter, so ids
are JSON numbers (`0, 1, 2…`); strings are allowed. The server echoes the id with its
original JSON type in `requestId`.

### Client → server

```jsonc
{"_tag":"Request","id":7,"tag":"server.probe","payload":{},"headers":[["k","v"]],
 "traceId":"…","spanId":"…","sampled":true}      // trace fields optional, ignored (tracing disabled)
{"_tag":"Request", …, "discard":true}            // fire-and-forget, see below
{"_tag":"Ack","requestId":7}                     // after each Chunk of a stream
{"_tag":"Interrupt","requestId":7,"interruptors":[]}
{"_tag":"Ping"}
{"_tag":"Eof"}                                   // no more requests; rarely sent
```

### Server → client

```jsonc
{"_tag":"Chunk","requestId":7,"values":[v1, v2]}       // stream values, non-empty batch
{"_tag":"Exit","requestId":7,"exit":<Exit>}            // ends the request
{"_tag":"Defect","defect":<defect>}                    // socket-level, see below
{"_tag":"Pong"}
```

### Exit encoding

```jsonc
{"_tag":"Success","value":<encoded success>}             // void and stream ends: "value":null
{"_tag":"Failure","cause":[
  {"_tag":"Fail","error":<encoded error>},               // expected error from the RPC's error schema
  {"_tag":"Die","defect":<defect>},                      // bug / unknown tag / bad payload
  {"_tag":"Interrupt","fiberId":<number|null>}           // interrupted
]}
```

Expected errors are `Schema.TaggedError`s and encode as their fields plus `_tag`, e.g.
`{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing
required scope: settings:write.","requiredScope":"orchestration:operate",
"requiredPermission":"settings:write"}`. Defects encode as a string when they are one,
`{"name":"Error","message":"…"}` for `Error` instances, or the plain JSON value.

### Semantics

- **Unary**: `Request` → one `Exit`.
- **Stream** (`stream: true` in `packages/contracts/src/rpc.ts`): `Request` → `Chunk`* →
  `Exit` (`Success` with `null`, or `Failure`). **Backpressure**: after each `Chunk` the
  server waits for the client's `Ack` before sending the next. For the methods in
  `apps/server/src/terminal/OutputProtocol.ts` (`terminal.attach`/`observe` by bytes;
  `subscribeServerConfig`, `orchestration.subscribeShell`/`subscribeThread` by count) the
  server acks its own chunks until 8 chunks (or 64 KiB) are outstanding; the client still
  acks every chunk.
- **Interrupt**: the server interrupts the handler and sends
  `Exit Failure [{"_tag":"Interrupt",…}]`. An interrupt for an unknown id sends nothing.
- **Discard** (`"discard":true`): the server answers `Exit Success null` as soon as the
  handler starts, then nothing more for that id.
- **Authorization**: each method needs one scope (`RPC_REQUIRED_SCOPES` and
  `requiredScopesForRpcCall` in `apps/server/src/auth/RpcAuthorization.ts`; some depend on
  the payload). Missing scope ⇒ `Exit Failure [Fail EnvironmentAuthorizationError]`.
- **Unknown method** ⇒ `Exit Failure [Die "Unknown request tag: <tag>"]`.
- **Payload that fails its schema** ⇒ `Exit Failure [Die "<schema issue text>"]`.
- **Handler defects** stay per request (`disableFatalDefects: true`).
- **Socket-level `Defect`** (unparseable JSON, unknown `_tag`, invalid id) fails **every**
  pending request on that socket at the client. Avoid it for anything request-scoped.
- **Never reuse an in-flight id.** In `apps/server` the duplicate interrupts the socket's
  read loop (`handleRequest` returns `Effect.interrupt`), which likely drops the socket;
  p0d ignores the duplicate.
- Closing the socket interrupts all of that client's requests.

## 6. How p0d implements it

- `apps/p0d/internal/rpc` speaks §4–§5. `Registry.Unary`/`Registry.Stream` register
  Go handlers with their scope; `emit` blocks until the client's `Ack`.
- Methods without a Go handler are forwarded **per request** over one upstream socket per
  client socket, opened lazily and closed 30 s after its last request ends. Ids pass
  through unchanged; upstream `Chunk`/`Exit` frames are relayed byte for byte (re-split
  for `frameParts`); `Ack`/`Interrupt` for proxied ids go upstream. Upstream `Pong`s are
  dropped (p0d sends its own). An upstream `Defect` or disconnect becomes
  `Exit Die` for the proxied requests in flight only, so Go-handled requests survive.
- The legacy server (`--legacy-server <cmd>`) starts on first use as
  `<cmd> --host 127.0.0.1 --port <free> --base-dir <dirname(home)>` with
  `P0D_INTERNAL_TOKEN` in its environment, and stops after `--legacy-idle-timeout`
  (5 min) without users.
- **Trust**: p0d authenticates every client itself (§2). Toward the legacy server it
  sends `X-P0d-Internal-Token` and `X-P0d-Session-Id` (the client's verified session)
  and strips the client's own credentials. The legacy server accepts that pair only when
  `P0D_INTERNAL_TOKEN` matches, loads the session from its own table (so revocation and
  scopes stay authoritative), and otherwise behaves as before. p0d drops any `X-P0d-*`
  header a client sends.
- **HTTP routes** p0d has not ported are reverse-proxied with `Host` preserved. A
  request whose credential p0d verifies goes through as that session; any other request
  goes through untouched and the legacy server applies its own rules (pairing, OAuth,
  `/mcp`, token renewal with an expired DPoP token).

## 7. Gotchas for porters

- `exp`/`iat` in session and ticket claims are **milliseconds**; DPoP `iat` is
  **seconds**.
- Scopes come from the `auth_sessions` row, never from the token.
- Void and stream successes encode `"value":null`, not an absent key.
- Echo `requestId` with the client's JSON type (`7` ≠ `"7"`).
- Stream chunks are one-at-a-time by default; forgetting to wait for `Ack` floods slow
  clients, and forgetting to forward `Ack` stalls proxied streams.
- The client counts **any** frame as liveness, but a long blocking call (e.g. starting
  the legacy server) must not stop the read loop from answering `Ping`.
- A DPoP proof is single-use across both servers: the replay marker files in
  `secrets/` are shared, so whichever server verifies a proof consumes it.
- The legacy server names its session cookie after its own (random) loopback port, so
  p0d renames `t3_session_*` cookies in proxied `Set-Cookie` headers to its own name.
  The `sessionCookieName` in `/api/auth/session`'s descriptor still shows the legacy
  name (no client reads it today), and the descriptor's `policy` reflects the legacy
  server's loopback bind, not p0d's.
- Behind p0d the legacy server sees every client as `127.0.0.1`; it takes the client
  IP from the last `X-Forwarded-For` entry, which p0d sets.
- With the keychain backend on macOS, p0d reads the signing key through
  `/usr/bin/security`, which may show a keychain access prompt the first time.
- `/ws` must not enforce `Origin` itself (cookie credentials already did); Go's
  `coder/websocket` rejects cross-origin upgrades unless `InsecureSkipVerify` is set.
- The session store's "connected" flag lives in the legacy server's memory and only
  sees sockets that made a proxied call.
