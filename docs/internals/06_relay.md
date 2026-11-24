# Self-hosted relay

The relay ([`apps/relay`](../../apps/relay)) lets an environment behind NAT be reached at a public
HTTPS origin with TLS terminating on the environment. There are no cloud accounts: the relay is a pipe
that routes raw TCP by TLS SNI, and the environment's own auth (pairing, scoped sessions, guest
links) is the only authority. Setup lives in the [relay runbook](../operations/02_relay-setup.md).

## TLS and certificate issuance trust

- **TLS passthrough.** The relay's `:443` listener reads only the ClientHello SNI and pipes the
  untouched bytes over the environment's tunnel. TLS terminates inside the environment
  ([`packages/relay-tunnel`](../../packages/relay-tunnel)), which owns its private keys and
  certificates. Traffic stays private against a compromised relay without DNS control only when
  certificate issuance is pinned to the environment ACME account using CAA (RFC 8657).
- **Certificates come from ACME HTTP-01 through the tunnel.** `:80` forwards only
  `/.well-known/acme-challenge/*` by Host to the owning environment, so the environment proves
  control of its own hostname without giving the relay a key or a DNS credential. HTTP-01 alone
  also lets a hostile relay issue another certificate. Add the exact CAA records from relay status
  for the environment and each exposed port; port hosts are siblings, so a slug record does not
  protect them. Use `CAA 0 issue "letsencrypt.org; accounturi=<account URI>; validationmethods=http-01"`.
  The account URI persists with the account key. Publish the pin after account registration and
  before relying on the relay; preserve it across renewals. A DNS operator can remove CAA and
  mis-issue a certificate (visible in Certificate Transparency). Self-operation avoids a third party.
- **Clients need nothing special.** Because the environment presents a publicly trusted certificate
  for `<slug>.<relay-host>`, the stock mobile app, hosted web, and any browser pair and connect
  with the normal pairing URL (`<public origin>/pair#token=…`). Never add a relay-specific client
  protocol; that would break the stock clients.
- **No push.** Push notifications to the store builds need the upstream APNs/FCM keys, so they are
  not available through a self-hosted relay.

## Enrollment and tunnel auth

- The relay operator mints one-time enrollment tokens (hashed at rest). Linking an environment
  registers its locally generated Ed25519 public key under a slug; every tunnel connection signs a
  fresh relay nonce bound to the relay host and slug, so a captured handshake cannot be replayed.
- A newer authenticated tunnel for a slug replaces the old one; revoking a slug closes its live
  tunnel. Nothing the relay holds is a credential on the environment.

## Public origin is the routing truth

- The environment derives its `publicOrigin` from the relay link it is currently serving (or an
  explicit override for a user-managed reverse proxy). Pairing URLs, guest links, and forwarded
  ports are minted from it.
- Guest links stay bound to the host they were minted for and are rechecked against the host the
  environment currently serves, so unlinking or changing the relay revokes them. Never trust the
  request `Host` header alone.

## Forwarded ports

`<port>-<slug>.<relay-host>` routes to the same tunnel; the environment decides whether that port
is exposed and proxies HTTP/WebSocket to loopback only after auth: an environment session
(private) or a signed, expiring, revocable link token exchanged for a host-scoped cookie. The
server's own port is never forwardable. Unexposing revokes outstanding links.
