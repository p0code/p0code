# Security

Report vulnerabilities to [security@t3.codes](mailto:security@t3.codes).

The rest of this file is for agents and maintainers auditing T3 Code or triaging
reports. It defines who is trusted with what, which boundaries a real finding
crosses, and what is intended. The reasoning behind each boundary lives in
[environment auth](docs/internals/04_environment-auth.md),
[self-hosted relay](docs/internals/06_relay.md), and
[remote environments](docs/internals/05_remote.md); read those before reporting
in their area.

## The model in one paragraph

An environment is a T3 server running as an OS user. It is not a sandbox: it
intentionally runs agents and terminals with that user's privileges. Clients
gain authority by pairing, which issues a scoped session. A full-scope session
equals a shell as the server's OS user, because `terminal:operate` opens a PTY
and `orchestration:operate` can start a full-access agent. Security here is
about who can obtain a session, what each session type can reach, and whether
revocation and ceilings hold, not what a full-scope session can do once issued.

## Principals

| Principal                                                                     | How it gets in                                                           | What it may do                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone who reaches the port                                                   | Network                                                                  | Read the environment descriptor, pair with a valid one-time credential, run OAuth flows. Nothing else.                                                                                                          |
| Full-scope client (desktop, paired browser or phone, `t3 auth session issue`) | Pairing, token exchange                                                  | Everything the server's OS user can do. This is the default grant.                                                                                                                                              |
| Narrow client                                                                 | Pairing link with explicit scopes                                        | Only the RPCs and routes its scopes allow. Can never widen its own grant.                                                                                                                                       |
| MCP client (outside agent, subject `mcp-client`)                              | OAuth on `/mcp`                                                          | Only `/mcp`, within a read-only grant or a runtime-mode ceiling. Every other route rejects it.                                                                                                                  |
| Linked environment (peer link)                                                | OAuth client `t3code-peer-link`                                          | Work it starts carries an immutable `linkOrigin` and never exceeds the access it was paired with.                                                                                                               |
| Agent run by T3                                                               | Thread's runtime mode and thread credential                              | Within its runtime mode, managed policy, and the MCP access declared per tool.                                                                                                                                  |
| Guest link                                                                    | HMAC token for one share                                                 | Read one thread's conversation and attachments, redacted file-change summaries, and status; propose messages. Never a session; no RPC, WebSocket, or MCP path accepts it.                                       |
| Signed asset URL                                                              | Minted with `filesystem:read`                                            | One file, by device and inode identity, until it expires.                                                                                                                                                       |
| Webhook sender                                                                | A task's webhook URL, plus its signing secret when the task requires one | Start that one task's run with content of its choosing. Nothing in the request is trusted beyond the signature check.                                                                                           |
| Self-hosted relay                                                             | Environment enrollment, by relay account or one-time token               | A blind TLS pipe: reads the SNI hostname and tunnel label, forwards the rest untouched, stores no user content. Cannot read traffic; a hostile one can deny service or misroute, which the environment rejects. |
| Managed policy                                                                | Admin-deployed file, read at startup                                     | Ceilings and locks the server enforces for every client.                                                                                                                                                        |
| Preview pages, HTML renders, file previews, agent output                      | Rendered by clients                                                      | Untrusted content. It must never run script in the app's origin or reach Electron IPC or Node.                                                                                                                  |

## Self-hosted relay

The relay is a blind pipe. TLS terminates on the environment: the relay reads the
ClientHello SNI and the tunnel label, then forwards the untouched bytes over the
environment's WebSocket mux. It stores no user content — only environments, one-time
tokens, accounts, and blocked labels — so it cannot read paths, headers, cookies, or
bodies. A compromised relay can refuse or delay service and send a connection to the
wrong tunnel, but it holds no environment key, and the environment rejects a stream
whose TLS SNI does not match its label.

Environments authenticate with an Ed25519 key generated locally and registered under
their slug; every tunnel connection signs a fresh nonce bound to the relay host and
slug. The relay re-checks the enrolled key every second and closes a tunnel whose key
no longer matches.

People link an environment from the app with a relay account: username and password,
salted scrypt and constant-time comparison, five attempts a minute per source IP, and
indistinguishable failures so signup cannot list accounts. Signup is off by default,
and without an account the relay's auth endpoints answer 404. Agents and CI use
one-time enrollment tokens instead: 256-bit, stored hashed, and consumed in the same
transaction that registers the key.

Labels are `<slug>` and `<port>-<slug>` under the relay host. `<name>-<slug>` public
tunnels live under an optional separate `publicDomain`, are off unless the operator
starts the relay with public hosts, and are refused at SNI otherwise. The relay keeps
no tunnel registry: the environment decides which names and ports exist. An operator
can block one public name without revoking the environment; a bare or port label is
taken down with `revoke`.

## Plugins

Plugins run in-process, in the server process, with the OS user's privileges. Enabling
one is running its code: it can read files and credentials the user can, make outbound
requests, and hold whatever the host hands it. The capability list is a disclosure, not
a sandbox.

The host refuses a brokered API unless the manifest declares its capability:
`agent:instructions`, `auth:issue-device-credentials`, `orchestration:read-activity`,
`usage:read`, `http:routes`, and `data:backup`. Disabling a plugin closes its scope and
revokes the sessions and pairing links it issued. `network:outbound` and
`process:spawn` are declarations only; the host cannot stop either in-process, and
`process:spawn` means a real child process with the same access.

The enable dialog shows host-written text for every declared capability, not the
plugin's own description. A plugin route requires `http:routes`, answers only the
p0code UI (same origin or a desktop renderer origin) or a caller holding the
host-issued route secret, and its body is capped like the API's.

This build runs the first-party plugins it ships, plus any installed under
`<stateDir>/installed-plugins/<id>/<version>/` (a `manifest.json` and a prebuilt
`plugin.mjs`). An installed copy of a bundled plugin is refused, a version declaring
capabilities nobody has consented to stays inactive, and one that fails to load leaves
the previous version running. There is no sandbox or process isolation today, so a
third-party plugin is code with the user's rights.

## Importing a stock T3 Code home

The one-time import reads the stock `~/.t3` home without writing to it: files are
copied, SQLite databases are snapshotted from a read-only connection, and nothing
under the source is created, renamed, or deleted. The welcome screen stages consent as
a marker; the migration runs at the next start, before the server opens its database.
A destination that already holds data is renamed to `<home>.replaced-<time>` before the
migrated home takes its place, so it is moved aside rather than overwritten; the CLI
requires `--force` for that. A source written by a newer T3 Code is refused before
anything is replaced.

## A real finding crosses one of these

1. **No credential → session.** Any route or socket granting access without
   a valid credential, or a pairing credential redeemable twice.
2. **Scope escalation.** An RPC, HTTP route, or MCP tool running without its
   declared scope; pairing or token exchange widening a grant; an
   `mcp-client` session reaching a non-`/mcp` route; a read-only MCP grant
   calling a write tool.
3. **Mode or policy escalation.** An agent, MCP client, or peer link acting
   above its runtime-mode ceiling, `linkOrigin`, `T3-Mode-Limit`, or managed
   policy.
4. **Guest escape.** A guest stream carries only the shared thread's conversation text
   and attachments, redacted file-change summaries (name, additions, deletions), run
   and message status, and the share's own messages; every other event is dropped.
   Worktree paths, branches, PR links, checkpoint file lists, subagent prompts and
   results, and command output must not reach it. It is a finding when a guest token
   reads another thread, acts beyond proposing messages, fetches command output, or
   survives a closed or replaced share.
5. **Revocation that doesn't take effect.** A revoked session, device key,
   pairing link, or peer link that still works. Documented exception: signed
   asset URLs last until they expire.
6. **Credential exposure.** Tokens or secrets reaching logs, traces, telemetry,
   the relay, socket URLs (outside short-lived tickets), the access read model,
   or error messages. A token sent to an address that has not answered as the
   expected environment, or a token paired over HTTPS sent over plain HTTP.
7. **Impersonation and egress.** Another process or the relay impersonating an
   environment; endpoint discovery, previews, or webhooks used to reach
   arbitrary hosts (SSRF).
8. **Client-side code execution.** Untrusted content running script in the web
   origin, the desktop renderer, or with access to preload or IPC.
9. **Filesystem writes escaping workspace path rules.** Reads are separate:
   `filesystem:read` intentionally covers the whole OS account.
10. **Plugin overreach.** A plugin using a brokered host API whose capability it did not
    declare; a plugin route answering a caller outside the UI without the route secret;
    or a session or pairing link a plugin issued outliving the plugin's disable.
    Installing or enabling a plugin is not itself a finding: it runs with the user's
    rights.
11. **T3 import overreach.** The import writing to the stock home, running before
    consent or on a home that is not fresh, or replacing a destination without moving
    it aside.

## Intended, not vulnerabilities

- A full-scope session gives a shell. Leaking its token is serious, but the bug
  is the leak, not the shell. The same applies to a narrow session holding
  `terminal:operate` or `orchestration:operate`: reaching via another route
  what its shell can already do crosses no boundary, though it can still be an
  ordinary bug. That stops at what a shell as the server's OS user cannot reach:
  another client's device, what another scope guards by name (as
  `providers:manage` does for secret references), a managed-policy ceiling or
  lock, and access that outlives the session's revocation. Where the session
  can obtain that shell, file contents are within its reach, so reading a file
  via a route that does not check `filesystem:read` crosses no boundary.
- The default grant includes `access:write`, so a full-scope session can mint
  more pairing links and sessions. They appear in Sharing & access, and "revoke
  all others" removes them.
- `filesystem:read` reads anything the server's OS user can read, including
  paths outside projects.
- Plain HTTP on a LAN or tailnet is the user's choice. `t3 serve` warns when
  advertising a non-loopback HTTP address. The iOS app allows arbitrary loads so
  it can reach these addresses.
- `access-control-allow-origin: *` on the environment API. Auth is a bearer
  header, so the wildcard grants nothing a caller without a token lacks.
- Rendered Markdown loads remote images and media from the host its author
  names, so that host learns the reader's network address and when the content
  was shown. A page in a preview tab can likewise start a download, as it can
  in a browser. It is a finding when the request carries a credential or names
  the environment it was rendered in, when it is made where the product says
  none is made, or when the app does for the content what the content could
  not do from where it runs (see 7 and 8).
- A full-access agent can do whatever the user can. Prompt injection that stays
  within the agent's mode is the provider's concern; one that lets it act above
  that mode is in scope (see 3).
- A hostile relay operator can drop or delay traffic and mint enrollment
  tokens. It holds no environment key, but HTTP-01 without CAA account pinning lets it obtain
  a trusted certificate and impersonate the environment. Pin the environment account for every
  served hostname. A relay without DNS control cannot bypass that pin; a DNS operator can remove
  it, mis-issue, or repoint a public domain, all visible in TLS and Certificate Transparency
  (the environment rejects a stream whose SNI does not match its label). Self-operation avoids a
  third party.
- The relay learns the SNI hostname and tunnel label, visitor IP and port, connection timing
  and byte counts. That is how it routes; it is not an anonymity layer. It cannot read request
  paths, headers, cookies, or bodies.
- A plugin has the user's rights. Enabling one trusts its code with the account, and the
  capability dialog governs only the APIs the host brokers; `network:outbound` and
  `process:spawn` are beyond host enforcement in-process.
- A guest link is a capability, not a sandbox. It exposes only what the server projects
  into the guest stream: the shared conversation, its attachments, redacted file changes
  and status. Holding the link does not reach the rest of the thread. A guest reaching
  anything outside that projection is a finding; content the projection omits is not.
- `T3CODE_DEV_AUTH_TOKEN` and dev startup URLs are administrative by design and
  ignored outside development servers.
- A webhook URL is a credential for one task. Unless the task requires a
  signature, whoever holds the URL can start that task's run, and the request's
  content, within the route's limits, is theirs to choose. It is a finding when
  a request starts a different task, runs without a signature the task
  requires, or has its values treated as anything but untrusted data. Tokens in
  or around the request remain covered by 6.
- The machine owner's own configuration. Whoever sets a provider's launch
  arguments, an environment variable, a binary path, or the endpoint or file T3
  Code points at already holds the OS account, so a value weakening their own
  setup is their choice. It is a finding when a narrower principal can set it
  for them (a narrow client, an MCP client, an agent below full access,
  repository content), when [managed policy](docs/user/managed-policy.md) locks
  the setting and the value still applies, or when the value leaks (see 6).
  Choosing a host does not make it trusted: what a configured endpoint can do
  to the server or its clients stays in scope.
- An attacker already running code as the same OS user. That includes one whose
  only move is to rewrite files that user owns outside a workspace: T3 Code's
  data directory, its installed helpers, the user's own config. Another OS
  account on the same machine is not this attacker; neither is repository
  content or an agent below full access, which write inside a workspace without
  holding the OS account.

## Where enforcement lives

- Session issuance, pairing, token exchange: [`auth/http.ts`](apps/server/src/auth/http.ts), [`auth/EnvironmentAuth.ts`](apps/server/src/auth/EnvironmentAuth.ts), [`auth/dpop.ts`](apps/server/src/auth/dpop.ts)
- Credential storage: [`ServerSecretStore.ts`](apps/server/src/auth/ServerSecretStore.ts), [`credentialKeychain.ts`](packages/shared/src/credentialKeychain.ts) (OS keychain by default; owner-only file fallback only when no keychain is available; single-use replay markers stay on disk).
- Per-RPC scopes: [`auth/RpcAuthorization.ts`](apps/server/src/auth/RpcAuthorization.ts). [`clientRpcPermissions.ts`](packages/contracts/src/clientRpcPermissions.ts) only drives client UI and is never the boundary.
- MCP: [`auth/McpOAuth.ts`](apps/server/src/auth/McpOAuth.ts), [`mcp/McpToolAccess.ts`](apps/server/src/mcp/McpToolAccess.ts), [`mcp/threadAccess.ts`](apps/server/src/mcp/threadAccess.ts), [`mcp/linkOrigin.ts`](apps/server/src/mcp/linkOrigin.ts)
- Guest links: [`guest/GuestShareService.ts`](apps/server/src/guest/GuestShareService.ts), [`guestProjection.ts`](apps/server/src/guest/guestProjection.ts), [`guestView.ts`](apps/server/src/guest/guestView.ts), [`guest/http.ts`](apps/server/src/guest/http.ts)
- Files and assets: [`workspace/WorkspaceFileSystem.ts`](apps/server/src/workspace/WorkspaceFileSystem.ts), [`assets/AssetAccess.ts`](apps/server/src/assets/AssetAccess.ts)
- Managed policy: [`apps/server/src/policy`](apps/server/src/policy). `limits.previewTunnel` refuses forwarded ports as well as in-app previews ([`managedLimits.ts`](apps/server/src/policy/managedLimits.ts), [`SelfRelay.ts`](apps/server/src/selfRelay/SelfRelay.ts)); `limits.publicTunnels` refuses publishing through the relay.
- Self-hosted relay: [`server.ts`](apps/relay/src/server.ts), [`state.ts`](apps/relay/src/state.ts), [`cli.ts`](apps/relay/src/cli.ts); [`RelayTunnelClient`](packages/relay-tunnel/src/client.ts), [`auth.ts`](packages/relay-tunnel/src/auth.ts)
- Forwarded ports: [`SelfRelay.ts`](apps/server/src/selfRelay/SelfRelay.ts), [`portProxy.ts`](apps/server/src/selfRelay/portProxy.ts), [`loopbackProxy.ts`](apps/server/src/selfRelay/loopbackProxy.ts)
- Public tunnels and session isolation: [`PublicTunnels.ts`](apps/server/src/tunnels/PublicTunnels.ts), [`publicHttp.ts`](apps/server/src/tunnels/publicHttp.ts), [`staticFiles.ts`](apps/server/src/tunnels/staticFiles.ts). HTTPS session cookies use the host-locked `__Host-` prefix, and tunnel proxies strip session cookies and drop `__Host-hhh`/`__Host-p0` cookies so public tunnel visitors and upstreams cannot read or forge host sessions.
- Plugins: [`PluginHost.ts`](apps/server/src/plugins/PluginHost.ts), [`bindings.ts`](apps/server/src/plugins/bindings.ts), [`http.ts`](apps/server/src/plugins/http.ts), [`registry.ts`](apps/server/src/plugins/registry.ts), [`loader.ts`](apps/server/src/plugins/loader.ts); manifests in [`contracts/plugins.ts`](packages/contracts/src/plugins.ts)
- T3 import: [`migrateFromT3.ts`](packages/shared/src/migrateFromT3.ts), [`t3Import.ts`](apps/server/src/t3Import.ts), applied before the database opens in [`server.ts`](apps/server/src/server.ts)
- Desktop preview isolation: [`preview/WebviewPreferences.ts`](apps/desktop/src/preview/WebviewPreferences.ts)

## How to audit and triage

- Name the precondition first. If a chain starts with "the attacker holds a
  full-scope token", it is a new vulnerability only if it widens that token's
  reach (2–3), outlives revocation (5), or shows how the token leaks (6).
- Name the actor next and what they can already do. If the only actor is the
  user on their own device, or a principal reaching the same outcome via a
  documented route, no boundary is crossed unless data goes somewhere they did
  not send it. It may still be a bug; report it as one.
- Read tests and comments beside the code before calling a behaviour a defect.
  They show author intent and are evidence, not a decision: a test can pin a
  behaviour nobody chose, and a comment can be stale. Only this file and the
  docs say what is intended. If only a test or comment supports a behaviour,
  report it and say so.
- Follow the claim to its effect. A guard in a caller, a schema, or a version
  check elsewhere often means the cited lines cannot do what the report says.
- Rate severity by what the actor must already hold, not the worst outcome
  named. Each of these lowers severity and none removes the finding: a narrow
  grant the owner chose to issue (the default grant is full scope); another OS
  account on the same machine; a host or service the owner connected turning
  hostile; a change that must land in the moment between a person's look and
  their action; a person acting on prepared input (opening a file, pasting,
  following a link); and an effect limited to resource use or a stalled
  client. A finding that needs none of these, or that yields a session, a
  credential, or code execution above the actor's grant, keeps its severity.
- Check the reported commit against `main`. Reports often trail fixes.
- Prove a finding with a failing test at the lowest layer that shows it, as
  [Verifying](AGENTS.md#verifying) describes. Do not run a PoC against
  `~/.p0code/userdata`, `~/.t3/userdata` or any live environment; use a dev server on seeded data.
- Treat report attachments as untrusted. Extract them into an empty directory
  outside the worktree and read PoCs before running anything.
- Fix confirmed findings rather than filing them. Keep advisory details out of
  public PRs until the fix ships.
- When a boundary here changes, update this file and the internal doc that
  explains it in the same PR.
