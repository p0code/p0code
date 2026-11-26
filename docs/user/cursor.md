# Cursor

Run Cursor's local agent in T3 Code using your paid Cursor account or `CURSOR_API_KEY`.

## Prerequisites and sign-in

- **Node.js 22.13+** on the environment's machine.
- A **paid Cursor plan** via browser sign-in or `CURSOR_API_KEY`.
- Open **Settings → Providers → Cursor** and choose **Sign in** (works on remote environments and configured mobile instances too).

The adapter currently uses the SDK's local-agent runtime so runs operate in the selected p0code
workspace. Cursor cloud agents need repository and cloud-environment configuration that p0code does
not expose yet.

Custom Cursor MCP servers and plugins are not configured in p0code. They load from the environment
machine's Cursor config when the agent opens: project `.cursor/mcp.json`, user `~/.cursor/mcp.json`,
and installed plugins under `~/.cursor/plugins`. A project's own Cursor config, including its
`.cursor/mcp.json`, loads only in **Full access**; in the other
[permission modes](./permission-modes.md) a checkout cannot start MCP servers. Plugin tools
can appear without a login; OAuth MCP servers still need credentials. Run `agent mcp login <server>`
with the cwd set to the T3 project root (tokens land in
`~/.cursor/projects/<folder-slug>/mcp-auth.json`). Cursor desktop Connections auth does not write
that file, and the local SDK cannot complete interactive MCP OAuth itself—auth attempts fail with
messages such as "MCP authentication is not supported in local SDK runs" or that the auth server
does not support dynamic client registration. After you add or change skills, plugins, or MCP
servers, or after a successful CLI login, use **Restart agent session**.

- Supports streaming text, reasoning, tool activity, plans, image attachments, mid-turn text steering (steers with attachments or mode changes restart the run), and **Edit from here** / checkpoint rewind (rewinding to the first message starts a fresh session).
- **Subagents**: Cursor `task` subagents appear as read-only child threads; message the parent thread to interact.
- **Forking**: Uses a [portable handoff](./portable-handoffs.md) into a fresh Cursor session.
- **Cloud agents**: Not yet supported—runs operate locally in your T3 Code workspace.
- **Permissions**: **Full access** disables Cursor's sandbox; restricted modes enable it. On Windows, the Cursor SDK has no filesystem sandbox, so **Auto** and **Supervised** run without filesystem isolation when Cursor Auto-review is enabled, while **Auto-accept edits** cannot start on Windows.

Choose **Sign in**, then open the sign-in page and complete it in your browser. p0code
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Providers** for an already configured Cursor instance.

Cursor loads MCP servers and plugins from `~/.cursor/mcp.json`, `~/.cursor/plugins`, and (in **Full access** only) the project's `.cursor/mcp.json`.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped p0code MCP tools alongside ambient Cursor MCP/plugins from disk;
- image attachments;
- interruption, queued app messages, and in-turn steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork or interactive approval callbacks. A
text-only steer reaches the current run without restarting it.
When Cursor cannot deliver the steer, the same message is queued for the next turn after
this run finishes. If you press Stop, that follow-up stays held until you resume the queue. Steers
with attachments and provider or runtime changes that must apply immediately interrupt and restart
the run.
Same-provider Cursor forks use the orchestrator's portable full-thread context handoff into a fresh
Cursor agent. **Edit from here** and checkpoint rollback rewind the same Cursor agent to just before
the selected message, as `cursor-agent`'s `/rewind` does, so it keeps its exact earlier history.
Rewinding to the thread's first message starts a fresh Cursor agent instead.
The SDK has in-process custom callback tools, but the V2 adapter intentionally uses the
authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes normally enable it. On Windows, Auto and Supervised run without filesystem
isolation when Cursor Auto-review is enabled, because the SDK does not support a filesystem sandbox
there. Restricted modes without Auto-review, including the default Auto-accept edits mode, still
request the sandbox and cannot start on Windows. Explicit sandbox policies remain authoritative,
including restrictive policies that the Windows SDK rejects. Explicit approval policy overrides
control Auto-review, which is not represented as an interactive p0code approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter p0 record:cursor-replay --scenario simple
```

After adding or changing skills, plugins, or MCP logins, run **Restart agent session** from the command palette.
