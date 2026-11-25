# Relay setup

Run and operate the self-hosted relay ([`apps/relay`](../../apps/relay)) that makes environments
behind NAT reachable at public HTTPS origins. The relay routes raw TCP by TLS SNI: TLS for
`<slug>.<relay-host>` terminates inside the environment, so the relay never holds an environment
key. Confidentiality against a hostile relay without DNS control requires CAA account pinning.
A DNS operator can remove the pin and obtain another certificate (visible in Certificate
Transparency). Self-operation avoids a third party. Trust boundaries are in
[Self-hosted relay](../internals/06_relay.md).
There are no cloud accounts: enrollment tokens plus the environment's own pairing and session auth
are the only authority.

## DNS and ports

Point two DNS A records at the relay host:

- `relay.example.com`
- `*.relay.example.com`

For public tunnels on a separate domain (see [Public hosts](#public-hosts)), also point
`*.usercontent.example` at it.

Open TCP ports **80 and 443** directly to the relay process. Do not put an HTTP reverse proxy or a
CDN in front of it: anything that terminates the environment hostnames' TLS breaks the encryption
guarantee, and HTTP-01 needs public port 80 even when you use a custom ACME directory.

## Run with Docker

From `apps/relay`:

```sh
RELAY_HOST=relay.example.com RELAY_ACME_EMAIL=you@example.com docker compose up -d --build
docker compose exec relay node apps/relay/src/cli.ts enroll
docker compose exec relay node apps/relay/src/cli.ts ls
docker compose exec relay node apps/relay/src/cli.ts revoke abcdef
docker compose exec relay node apps/relay/src/cli.ts block docs-abcdef
```

The image keeps its SQLite state and ACME certificates in the `relay-data` volume
(`RELAY_STATE=/data/state.sqlite` and `RELAY_CERT_DIR=/data/certs` are preset in the Dockerfile).
Preserve the volume across restarts. Compose environment variables must also be set when running
`docker compose exec`.

## Run with Node

From the repository root (Node 26 and Vite+ installed):

```sh
vp install
RELAY_HOST=relay.example.com RELAY_ACME_EMAIL=you@example.com \
  node apps/relay/src/cli.ts serve
```

## Admin commands

`hhh-relay [serve|enroll|ls|revoke|block|unblock|blocked] [options]`. Every command opens the same SQLite state file as
`serve` (default `./relay-data/state.sqlite`; pass `--state` or set `RELAY_STATE` consistently).
Run only one `serve` per state file. A running server observes revocations from another process
within about one second and closes the live tunnel; a newer authenticated tunnel for a slug
replaces the old one.

- `serve` — run the relay. Requires `--host` / `RELAY_HOST`.
- `enroll` — print a one-time enrollment token valid for one hour. Pass it privately to the
  environment owner, who links with `t3 relay link https://relay.example.com --token <token>`.
  Tokens are SHA-256 hashed at rest.
- `ls` — list enrolled environments (slug, public key, creation time) as JSON.
- `revoke <slug>` — remove an environment: its live tunnel closes and it can no longer
  authenticate.
- `block <name-label>` — refuse one public tunnel name label, such as an abusive public tunnel
  `docs-abcdef`, without unlinking its environment. Live connections to it close within about a
  second. `unblock <name-label>` lifts it; `blocked` lists blocked labels as JSON. Bare `<slug>` and
  `<port>-<slug>` labels are refused here: use `revoke <slug>` to cut an environment's own host.

Slugs are 6–32 lowercase letters/digits starting with a letter. The database stores public keys
only, never environment private keys, and an enrollment cannot overwrite an enrolled slug.

## Flags

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
| `--public-hosts`    | `RELAY_PUBLIC_HOSTS=1`     | off                         |
| `--public-domain`   | `RELAY_PUBLIC_DOMAIN`      | none (names use `--host`)   |

## Public hosts

Environments can publish a dev server, a file or a static folder as a public tunnel at
`<name>-<slug>.<domain>`. The relay routes those hostnames by SNI like every other environment
host: TLS still terminates on the environment, so the relay sees the hostname, the visitor's IP
and byte counts, never paths, headers or bodies. Names are owned by the environment and namespaced
by its slug; the relay keeps no registry.

- **Off by default.** Start with `--public-hosts` (or `RELAY_PUBLIC_HOSTS` set to `1`, `true`, `yes`
  or `on`, case-insensitive). Off, name hostnames
  are refused at SNI, and environments are told so when they connect. Hosting public content on
  your domain is an abuse and phishing liability, so think before enabling it on a shared relay.
- **Separate domain (recommended).** `--public-domain usercontent.example` puts names under that
  domain and nowhere else; `<slug>` and `<port>-<slug>` stay under `--host`. Tunnel pages run
  arbitrary JavaScript, and under `--host` they are same-site with the environment's own origin.
  The domain needs wildcard DNS to the relay and must not overlap `--host`. Without it, names live
  under `--host`.
- **Visitor limits.** Every label except an environment's own `<slug>` is a visitor: each source IP
  (IPv6 clients share a /64) gets a burst of 100 new connections, refilled at 20 a second, with at
  most 64 open. Quiet visitor streams are reaped after 15s. Every label is refused once a tunnel has
  `min(16, floor(maxStreams/2))` streams left, so the owner's own clients still connect when a
  tunnel is busy.
- **Takedown.** `block <name-label>` kills one public tunnel name; `revoke <slug>` kills the whole
  environment.

Public tunnel certificates are issued by the environment over HTTP-01 through port 80, the same way
as port hosts. Each name hostname appears in Certificate Transparency logs once its certificate is
issued.

## Certificates

The relay holds a certificate for its own control hostname only (its `/_hhh/*` endpoints).
Environments terminate TLS for `<slug>.<relay-host>` and `<port>-<slug>.<relay-host>` themselves
with certificates they own.

- **ACME (default).** HTTP-01 through the relay's own port 80. Certificates and private keys are
  saved atomically under `--cert-dir` and renewed at two thirds of their lifetime. Set `--email` /
  `RELAY_ACME_EMAIL` as the ACME contact.
- **Let's Encrypt staging.** Pass
  `--directory-url https://acme-staging-v02.api.letsencrypt.org/directory` for testing.
- **Bring your own.** `--cert` and `--key` (or `RELAY_CERT` / `RELAY_KEY`) name PEM files covering
  the relay's own hostname, for example from a private CA. Both are required together.

On the environment, `T3CODE_RELAY_CERT` / `T3CODE_RELAY_KEY` supply an environment-owned
certificate instead of ACME, and `T3CODE_RELAY_CA_CERT` names a CA the environment uses to verify
the relay's control-channel certificate.

## Environment side

Link an environment with `t3 relay link https://relay.example.com --token <token>` (the relay
subcommand accepts `--base-dir` / `--dev-url`). `t3 relay status` shows the link, public origin,
certificate state, and exposed ports as JSON; `t3 relay unlink` disconnects. A running server
applies the change immediately; a stopped server keeps the link in its state and serves the relay
on next start.

The public origin `https://<slug>.<relay-host>` mints everything clients use: pairing URLs
(`<public origin>/pair#token=…`), guest links (`<public origin>/guest#…`), webhooks
(`<public origin>/api/hooks/<hookId>/<token>`), and forwarded ports
(`https://<port>-<slug>.<relay-host>`). The stock mobile app and any browser pair and connect
through it without special configuration. See [Remote access](../user/remote-access.md) for the
user flow.

Environment variables on the environment side:

| Variable                                 | Meaning                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `T3CODE_PUBLIC_ORIGIN`                   | Manual public origin when your own reverse proxy serves the environment instead of the relay |
| `T3CODE_ACME_EMAIL`                      | ACME contact for the environment's own certificates                                          |
| `T3CODE_ACME_DIRECTORY`                  | ACME directory URL override, e.g. Let's Encrypt staging                                      |
| `T3CODE_RELAY_CERT` / `T3CODE_RELAY_KEY` | Environment-owned certificate and key instead of ACME                                        |
| `T3CODE_RELAY_CA_CERT`                   | CA for the relay's control-channel certificate                                               |

`T3CODE_PASSKEY_RP_DOMAINS` is build-only; see [Desktop passkeys](#desktop-passkeys).

## Troubleshooting

- **`RELAY_HOST or --host is required`** — `serve` needs the relay's own hostname.
- **`Both cert and key are required`** — `--cert` and `--key` must be passed together.
- **A `*.relay` hostname refuses connections or shows a wrong certificate** — check the DNS
  records, the enrollment (`hhh-relay ls`), and that the environment tunnel is up
  (`t3 relay status` on the environment). Unknown SNI closes the connection.
- **Environment certificates fail / HTTP-01 is not answered** — port 80 must be open to the relay
  and the environment's tunnel must be connected, because the challenge is forwarded through it.
  For a first try, point both sides at the Let's Encrypt staging directory and enroll a test
  environment.
- **Environment cannot link** — the enrollment token expires after one hour; mint a fresh one.
  The environment can also verify the relay control channel with `T3CODE_RELAY_CA_CERT` when the
  relay uses a private CA.
- **Tunnel keeps dropping** — check `--max-streams`, `--idle-timeout-ms`, and the environment's
  log. A relay behind a NAT that lacks 80/443 passthrough, or in front of a TLS-terminating proxy,
  shows up here.
- **A public tunnel hostname refuses connections** — the relay needs `--public-hosts`; with
  `--public-domain`, the name lives only under that domain (check its wildcard DNS). Check
  `hhh-relay blocked`. Busy tunnels refuse new visitor connections before the owner's.
- **`A public domain needs public hosts enabled`** — pass `--public-hosts` with `--public-domain`.
- **SQLite busy or a second `serve` fails** — run only one `serve` per state file.
- **Docker** — compose reads its variables at `docker compose up` and again at each
  `docker compose exec`; keep the `relay-data` volume.

## Desktop passkeys

Passkeys in a signed macOS build need an explicit App ID with **Associated Domains** and a
matching distribution provisioning profile. Signed builds—including local signed builds—set
`T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`, and `T3CODE_PASSKEY_RP_DOMAINS`
(comma-separated); each RP domain must serve Apple's
`/.well-known/apple-app-site-association`. Bump the build version after changing Associated
Domains so macOS refreshes cached Shared Web Credentials. Unsigned `dev:desktop` cannot exercise
passkeys.

### Pin certificate issuance

After linking, relay status and the web, desktop, and mobile relay settings show the environment's
ACME account URI and the exact DNS CAA records. Publish every record before relying on relay
confidentiality, including a record for each exposed port host. Port hosts are siblings of the
environment host, so CAA on the slug alone does not cover them. The record format is:

```text
<host> CAA 0 issue "letsencrypt.org; accounturi=<account URI>; validationmethods=http-01"
```

Keep the account key and URI together when restoring state. This pin prevents a relay without DNS
control from obtaining another trusted certificate through HTTP-01. A DNS operator can remove the
pin and mis-issue; monitor Certificate Transparency for unexpected issuance. Running your own relay
avoids a third party. Without the pin, a hostile relay can impersonate your environment.

For CLI enrollment, pipe the token to `t3 relay link https://relay.example.com --token-stdin`, set
`T3CODE_RELAY_ENROLLMENT_TOKEN`, or omit both in a terminal for a masked prompt. Avoid `--token`,
which exposes the credential in shell history and process arguments.
