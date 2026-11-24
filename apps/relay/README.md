# hhh-relay

A self-hosted TCP relay for environment HTTPS and WebSocket traffic. TLS for environment hostnames terminates inside the environment. The relay owns only its control-host certificate. Protect environment traffic with the account-specific CAA records shown by relay status: HTTP-01 alone lets a hostile relay issue another certificate. A DNS operator can remove CAA; Certificate Transparency makes issuance visible. Self-operation avoids a third party. Environment login/pairing remains the environment's responsibility.

## Run

Point both `relay.example.com` and `*.relay.example.com` DNS A records at your VPS. Open TCP ports **80 and 443** directly to this process. Avoid an HTTP reverse proxy or a CDN that terminates environment TLS. HTTP-01 needs public port 80 even when using a custom ACME directory.

From the repository root (Node 26 and Vite+ installed):

```sh
vp install
RELAY_HOST=relay.example.com RELAY_ACME_EMAIL=you@example.com \
  node apps/relay/src/cli.ts serve
node apps/relay/src/cli.ts enroll
node apps/relay/src/cli.ts ls
node apps/relay/src/cli.ts revoke abcdef
```

`enroll` prints a one-time token valid for one hour. Pass it privately to the environment. These admin commands access the same SQLite file as `serve`; use `--state` consistently. The relay observes revocations from another process within one second and closes live tunnels. Tokens are SHA-256 hashed at rest; the database contains public keys, never environment private keys.

For Docker, from `apps/relay`:

```sh
RELAY_HOST=relay.example.com RELAY_ACME_EMAIL=you@example.com docker compose up -d --build
docker compose exec relay node apps/relay/src/cli.ts enroll
docker compose exec relay node apps/relay/src/cli.ts ls
docker compose exec relay node apps/relay/src/cli.ts revoke abcdef
```

Compose environment variables must also be set when running `docker compose exec`.

| Flag                | Environment variable       | Default                     |
| ------------------- | -------------------------- | --------------------------- |
| `--host`            | `RELAY_HOST`               | required for serve          |
| `--state`           | `RELAY_STATE`              | `./relay-data/state.sqlite` |
| `--bind-host`       | `RELAY_BIND_HOST`          | `0.0.0.0`                   |
| `--tls-port`        | `RELAY_TLS_PORT`           | `443`                       |
| `--http-port`       | `RELAY_HTTP_PORT`          | `80`                        |
| `--cert-dir`        | `RELAY_CERT_DIR`           | `./relay-data/certs`        |
| `--cert`, `--key`   | `RELAY_CERT`, `RELAY_KEY`  | ACME when omitted           |
| `--email`           | `RELAY_ACME_EMAIL`         | optional ACME contact       |
| `--directory-url`   | `RELAY_ACME_DIRECTORY_URL` | Let's Encrypt production    |
| `--max-streams`     | `RELAY_MAX_STREAMS`        | `128` per tunnel            |
| `--idle-timeout-ms` | `RELAY_IDLE_TIMEOUT_MS`    | `120000` per stream         |

BYO certificate/key paths are PEM files covering the relay's own hostname. Mount them in Docker and set `RELAY_CERT` and `RELAY_KEY`. For Let's Encrypt staging use `https://acme-staging-v02.api.letsencrypt.org/directory`. ACME certificates and private keys are saved atomically and renewed at two thirds of their lifetime. Preserve the data volume across restarts. Run only one `serve` process per state file.

## Environment integration

Import explicit subpaths from `@t3tools/relay-tunnel`:

- `auth`: `generateEnvironmentKeyPair`, `enrollEnvironment`, Ed25519 helpers.
- `certificates`: `HttpChallengeStore`, `AcmeCertificateManager`, `acmeDirectories`.
- `client`: `RelayTunnelClient`.
- `mux`, `codec`, `sni`: standalone transport primitives.

Persist the environment keypair locally, enroll its public key with `enrollEnvironment("https://relay.example.com", token, publicKey)`, and retain the returned slug. Slugs are 6–32 lowercase letters/digits, starting with a letter. Re-enrollment cannot overwrite a reserved slug.

```ts
const challenges = new HttpChallengeStore();
const certificates = new AcmeCertificateManager({
  directory: "/environment-state/relay-certs",
  challenges,
  email: "you@example.com",
  // byo: { cert: "/certs/wildcard.pem", key: "/certs/wildcard.key" },
});
const tunnel = new RelayTunnelClient({
  relayUrl: "https://relay.example.com",
  slug,
  privateKey,
  challenges,
  getSecureContext: (hostname) => certificates.getSecureContext(hostname),
  allowPort: (port) => exposedPorts.has(port),
  onSecureConnection: (socket, metadata) => {
    // The integrator must enforce environment auth before proxying a port.
    if (metadata.port) portHttpServer.emit("connection", socket);
    else environmentHttpServer.emit("connection", socket);
  },
});
tunnel.on("connectionError", (error) => console.error(error));
tunnel.start();
// Obtain the main certificate after the tunnel is connected, so HTTP-01 can pass.
// On shutdown: tunnel.stop(); certificates.close();
```

The client emits `connected`, `disconnected`, and `connectionError`. It reconnects automatically with capped exponential backoff and jitter. `stop()` stops retries and closes streams. `getSecureContext` requests certificates on demand and keeps them renewed; forwarded port hostnames are authorized with `allowPort` before certificate issuance. The caller owns HTTP authentication and port proxying. Both main and port hosts support HTTP/1.1 WebSocket upgrades. ECH, HTTP/2, UDP, and arbitrary non-TLS TCP are outside this protocol.

## Wire protocol

`wss://<relay>/_hhh/tunnel` starts with text JSON: relay `{type:"challenge",nonce}`, environment `{type:"authenticate",slug,signature}`, relay `{type:"authenticated"}`. The single-use nonce expires after ten seconds. The Ed25519 signature signs UTF-8 `hhh-relay/v1|<relayHost>|<slug>|<nonce>`; `relayHost` excludes the port. A new authenticated connection replaces the old one for that slug.

After authentication each binary WebSocket message is one frame: **u8 type, u32 big-endian stream ID, payload**. WebSocket fragmentation is handled at message boundaries. Frame size is bounded to 64 KiB. Only the relay opens streams, using monotonically increasing nonzero IDs.

| Type        | Value | Payload                                             |
| ----------- | ----- | --------------------------------------------------- |
| OPEN        | 1     | JSON `{label,kind:"tls"\|"http",remoteAddr?,port?}` |
| DATA        | 2     | Up to 16 KiB per sender chunk                       |
| CLOSE       | 3     | byte `0`: half-close, byte `1`: reset both halves   |
| WINDOW      | 4     | u32 big-endian bytes of new credit                  |
| PING / PONG | 5 / 6 | Empty, stream ID 0                                  |

Each direction starts with 256 KiB credit per stream. A full reader stops returning credit; writers honor Node stream backpressure and WebSocket send completion. A stalled stream leaves other streams usable. PING/PONG detects dead tunnels. Streams have caps and idle timeouts; ClientHello parsing and authentication have separate size/deadline bounds.

On 443 the relay peeks and replays the full ClientHello, including fragmented TLS records. Its own SNI host goes to `/healthz`, `/_hhh/enroll`, and `/_hhh/tunnel`. `<slug>.<relay>` and `<port>-<slug>.<relay>` go untouched to the owning environment. Unknown SNI closes the connection. Port 80 forwards only HTTP-01 GET paths to environments and serves the relay's own challenges locally; other requests get a 308 HTTPS redirect.

## Verify

```sh
vp test run packages/relay-tunnel/src apps/relay/src
vp run --filter @t3tools/relay-tunnel typecheck
vp run --filter @t3tools/relay typecheck
vp lint packages/relay-tunnel apps/relay
```

Tests generate ephemeral self-signed certificates with `openssl`. The localhost integration test checks the environment certificate fingerprint, HTTP response, WebSocket upgrade, forwarded port, ACME routing, enrollment token reuse, tunnel replacement, and live revocation. TLS verification is relaxed only in that test.
