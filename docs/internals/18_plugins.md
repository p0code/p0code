# Plugins

Plugins are first-party workspace packages under [`plugins/`](../../plugins) that the server runs
in-process, off by default. The host is [`apps/server/src/plugins`](../../apps/server/src/plugins);
plugins depend only on [`@t3tools/plugin-api`](../../packages/plugin-api), never on server internals.

## Shape

- **Bundled only.** [`registry.ts`](../../apps/server/src/plugins/registry.ts) lists what a build
  ships; nothing is loaded from disk. Capabilities are declarations shown before enabling. The
  host enforces the ones it brokers (device credentials, agent activity, declared HTTP routes);
  outbound network and helper processes cannot be enforced in-process, which is why third-party
  loading would need a separate process boundary first.
- **One scope per plugin.** Enabling runs `plugin.start` in a fresh scope; disabling closes it, so
  every fiber, child process, and finalizer the plugin owns ends with it. A failed start closes
  the scope and shows the error as the plugin's status; nothing a plugin does can stop the server.
  `Scope.provide` must stay innermost when starting a plugin: the platform context it receives
  carries the host's own scope, which would otherwise collect the plugin's finalizers.
- **Settings are the switch.** `plugins.<id>.enabled` in server settings decides what runs, so a
  settings edit and the RPC agree. Changing it needs `relay:configure`, the administrative scope,
  because a plugin can open the environment to an outside service.
- **Sessions are owned by subject.** Credentials a plugin mints use the subject `plugin:<id>`. The
  host revokes that subject's sessions and pairing links whenever the plugin is disabled, and at
  startup for plugins that are off, so a plugin cannot leave devices signed in after it is gone.
  This is separate from the retired `cloud-connect` subject, which startup still always revokes.
- **Routes are fixed paths.** A plugin's HTTP routes are declared in its manifest and mounted at
  startup; they answer 404 while the plugin is off. Paths are absolute because an external
  service may call them (the bridge's are upstream T3 Connect's).

## Unofficial T3 Connect bridge

[`plugins/t3-connect-bridge`](../../plugins/t3-connect-bridge) re-links an environment to
upstream T3 Connect (`relay.t3.codes`, Clerk at `clerk.t3.codes`) so stock T3 Code clients signed
in to a T3 account reach it, and the store mobile app gets push and Live Activities, which a
[self-hosted relay](06_relay.md) cannot deliver.

Trust model, plainly: this is the upstream design, not the fork's.

- **Not end-to-end encrypted.** The managed tunnel is a Cloudflare Tunnel; TLS terminates at
  Cloudflare's edge and the traffic crosses Cloudflare in the clear. T3's relay brokers every
  connection and sees account, device and connection metadata, and the thread and project titles
  in published activity.
- **The relay can let devices in.** A mint request signed with the relay's key gets a one-time
  pairing credential bound to the requesting device's DPoP key, with the standard client scopes.
  Whoever controls the relay's mint key controls who connects while the bridge is on. Proofs are
  checked for issuer, audience, linked account, scope, lifetime, and replay (in memory; a proof
  lives at most five minutes).
- **Coexists with the self-hosted relay.** The bridge never touches `PublicOrigin`: pairing URLs,
  guest links and forwarded ports keep using the self-hosted relay's origin.
- **Nothing else phones home.** The only outbound calls are sign-in (Clerk), the relay API, the
  pinned cloudflared download from GitHub, and the tunnel itself; upstream's relay tracing and
  OTLP export were not ported.

Sign-in is the RFC 8628 device flow run by the server, so it works when the browser is on another
machine; clients never load Clerk. Upstream releases the provisioned tunnel when the environment
stops (Cloudflare bills per tunnel), so the bridge releases it on stop and links again on start;
a tunnel Cloudflare keeps rejecting is also recovered by linking again, with a growing cooldown.
