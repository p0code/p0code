# Pi

p0code can use your existing Pi coding agent installation while keeping Pi's models, auth,
extensions, skills, context files, and native session history.

## Set up Pi

1. Install [Pi](https://pi.dev) on the machine running the p0code server. Pi requires Node.js
   22.19 or newer; its platform installers can install Node if needed. p0code supports Pi
   0.84.3 or newer.
2. Run `pi` in a terminal, then `/login` to connect your model provider or configure its API key.
3. Open p0code Settings, enable Pi, and refresh the provider.

- In **Launch arguments**, `--provider` must be paired with `--model`. Flags that alter Pi's execution mode or session selection are rejected because T3 Code manages them.
- Update installer-managed Pi with `pi update`, or via your package manager (e.g. `nix profile upgrade pi`).

## Features and extensions

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need a custom agent
directory, endpoint, or model configuration. `--provider` must be paired with `--model`. p0code
rejects launch arguments that change Pi's execution mode or select a session because T3 owns those
parts of the process lifecycle.

## Permission modes

- **Supervised**: Asks before commands, file edits, and extension tools (reads proceed).
- **Auto-accept edits**: Allows Pi's edit/write tools; asks for commands and extension tools.
- **Full access**: Allows all tool calls without prompts.

## Custom providers

To use any OpenAI- or Anthropic-compatible API, open Pi's provider settings and choose
**Add provider** under **Custom providers**. Enter the base URL with its version path (for example
`https://api.example.com/v1`), then use **Load models** or type model IDs yourself. A context window
and per-million-token prices are optional; Pi uses the prices for the costs p0code shows.
**Test** sends one short request.

The models appear in the model picker under the provider's name. The API key stays in this
environment's secret storage and reaches Pi as an environment variable. p0code registers these
providers through its own extension and never edits `models.json`; providers you configured there
are listed read-only.

## What Carries Over

p0code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks the discovered active model's configured level as its default without
overriding it. Other models keep their Pi defaults when no level is selected. A model that lists
`serviceTiers` (for example `[{ "id": "priority", "name": "Fast" }]`) in its Pi definition gets
a speed picker with Standard plus those tiers. A chosen tier is sent as the request's
`service_tier`; Standard sends none and leaves the endpoint's default. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Switching providers uses portable conversation context. Extension
dialogs appear in the p0code composer, and the thread details context window follows Pi's own usage
reporting while a response streams and after it settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user extensions, and project extensions once the folder is trusted in Pi.
Blocking `select`, `confirm`, `input`, and `editor` dialogs work in p0code. Notifications appear in
the work log. Extensions can publish status text near the composer. Terminal titles and generic
widgets do not have a p0code equivalent.

## Permission Modes

p0code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without p0code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

p0code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, p0code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as p0code
threads.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If discovery cannot complete, p0code keeps Pi available with the `Pi default` model. Start a
  thread to let the interactive Pi session handle any startup prompt.
- If Pi skips project settings, extensions, skills, prompts, MCP servers, or system prompt files
  because the folder is not trusted, the thread shows a notice on the first turn of the Pi session.
  Run the configured Pi binary in that folder on the server machine, using the same provider
  environment, including `PI_CODING_AGENT_DIR` if set. Trust the folder or its parent with `/trust`,
  then start a new thread using that same worktree. Launch arguments with `--no-approve` keep
  project files off without the notice.
- To see context usage on web and desktop, turn on **Context window** in **Settings → Appearance →
  Thread details**. It appears once Pi reports usage for the thread. Some model providers only
  report usage when a response completes, so it can wait for the first reply.
