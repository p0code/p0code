# Plugins

Plugins run in-process, off by default. First-party workspace packages live under
[`plugins/`](../../plugins); external bundles can be installed explicitly with `p0 plugin add`. Each plugin lives in its own repository and is mounted as a git
submodule (`plugins/t3-connect-bridge` from `p0code/t3-connect-bridge`,
`plugins/obsidian-shared-memory` from `p0code/obsidian-sync`), so clone with
`git clone --recurse-submodules=plugins` (or run `git submodule update --init plugins/` in an existing checkout)
before running `pnpm install`. The host is [`apps/server/src/plugins`](../../apps/server/src/plugins);
plugins depend only on [`@t3tools/plugin-api`](../../packages/plugin-api), never on server internals.

## Shape

- **Bundled and installed.** [`registry.ts`](../../apps/server/src/plugins/registry.ts) merges bundled
  plugins with installed bundles. Code lives in `<stateDir>/installed-plugins/<id>/<version>`;
  `installed.json` selects the active and previous versions and records consent per version.
  Install/update stages code without importing it; explicit consent activates it disabled. Rollback
  uses the previous version's consent. Removal retains runtime data and secrets unless purged.
  Plugins run in-process with the server's OS privileges; capabilities do not sandbox third-party code.
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
- **Routes are fixed paths.** A plugin's HTTP routes are declared in its manifest and resolved against
  the running plugins; they answer 404 while the plugin is off. Paths are absolute because an external
  service may call them (the bridge's are upstream T3 Connect's). The host resolves current running
  manifests for each request and requires a same-origin caller or the per-plugin route secret.
  Unknown paths/methods return 404; JSON bodies are capped at 1 MiB.
- **Agent instructions are opt-in.** A plugin declaring `agent:instructions` may expose an
  `agentInstructions` effect returning a block appended to every agent turn while the plugin runs.
  `PluginHost` feeds those blocks into the runtime policy (`pluginInstructions`) through
  `PluginAgentInstructions` so orchestration layers built before `PluginHost` read live plugin
  state without a layer cycle.

- **Deploy providers are plugins; the host owns the rest.** A plugin built with
  `defineDeployProvider` declares `deploy:provider` and keeps each account's credentials in its own
  `PluginContext.storage` keyed by the host-issued `accountId`; [`DeployService`](../../apps/server/src/deploy/DeployService.ts)
  and [`DeployStore`](../../apps/server/src/deploy/DeployStore.ts) own Settings → Deploy, named
  accounts and their profile scoping, project mappings, recent history and pending approvals in
  SQLite (migration 121), and never store, log or return a token. Provider calls are not plugin
  actions, so `plugins.invoke` cannot deploy around the rule that a thread below Full access needs
  a person's approval.

## Obsidian shared memory

[`plugins/obsidian-shared-memory`](../../plugins/obsidian-shared-memory) (repo
[`p0code/obsidian-sync`](https://github.com/p0code/obsidian-sync)) syncs a shared agent memory
folder via Obsidian Headless (`ob`, Node 22+) and appends its memory instructions to agent turns
when enabled. Existing installs that used the former built-in `SharedMemorySync` are migrated once
at startup into `<stateDir>/plugins/obsidian-shared-memory/` (and secret
`plugin-obsidian-shared-memory-token`) before the plugin host reconciles enabled plugins.

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

## Backup and restore ownership

`data:backup` lends plugins scoped snapshots and staging, never permission to apply a restore.
Only the host's administrative RPC can approve a particular pending restore id. Startup applies
that approval under the server-owner lock before opening SQLite; a journal rolls back interrupted
replacement, and the old files remain in a `restore-replaced-*` directory. Snapshot manifests may
carry `sourceBaseDir` so settings paths can follow the same home rewrite as the T3 import.
