# Kiro

p0code runs the [Kiro CLI](https://kiro.dev/docs/cli/) as an agent, using your own Kiro account,
custom agents, steering, hooks, and MCP configuration.

## Set up Kiro

1. Install the Kiro CLI on the machine running the p0code server. On macOS or Linux, run
   `curl -fsSL https://cli.kiro.dev/install | bash`. On Windows 11, run
   `irm 'https://cli.kiro.dev/install.ps1' | iex` in PowerShell. Kiro's
   [installation guide](https://kiro.dev/docs/getting-started/installation/) lists other options.
2. Run `kiro-cli login` once in a terminal. Kiro Pro and higher plans can instead set an API key as
   `KIRO_API_KEY` in the Kiro provider's environment variables.
3. Open **Settings → Providers**, enable Kiro, and refresh it.

If `kiro-cli` is not on the server's `PATH`, set its **Binary path**. On macOS and Linux, the
installer usually puts it in `~/.local/bin`. p0code starts Kiro's CLI V3 engine, so a Kiro CLI
that cannot run V3 will not start.

- **Models**: Listed from your signed-in Kiro account (defaults to `auto` unless your account/org sets another). Supported models expose a **Reasoning** effort selector.
- **Custom agents**: Pick built-in agents (e.g. Spec, Plan) or user agents from `~/.kiro/agents` in the **Agent** selector next to the model (refresh provider after adding/removing agents). Project `.kiro/agents` are not listed yet. The thread's model takes precedence over an agent's `model` field.

## Permission modes

- **Supervised**: Prompts for writes and commands, disables Kiro Autopilot, and asks you to review file changes at the end of a turn.
- **Full access**: Approves tool calls automatically with Autopilot on.

**Auto** and **Auto-accept edits** are not supported. Kiro's **Always allow** (which persists workspace-wide) is only shown when Kiro offers no one-time option.

## Steering, forks, and compaction

The thread's model still applies when an agent sets its own `model`. An agent that was removed
leaves the thread on Kiro's current agent.

## Permission Modes

Kiro asks before tool calls such as writes and commands, and p0code answers by the permission mode:

- **Supervised** sends those requests to you. Kiro's Autopilot is off, so Kiro also asks you to
  review the turn's file changes before it finishes.
- **Full access** approves them without asking you. Autopilot stays on, so there is no review step.

Kiro offers no **Auto** or **Auto-accept edits**. Approvals offer only the choices Kiro sends. Kiro's
**Always allow** saves a rule for the whole workspace, so p0code shows it only when Kiro offers no
one-time choice.

## Steering, Forks and Compaction

- A message you send while Kiro is working joins the running turn. Kiro reads it once its current
  step or tool call finishes. A message with images stops the turn and starts a new one with it.
- Forking a thread from a message gives the fork Kiro's own copy of the conversation up to that
  message.
- `/compact` uses Kiro's own compaction. Kiro also compacts on its own as the conversation fills its
  context.
