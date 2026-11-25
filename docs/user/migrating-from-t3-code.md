# Moving over from T3 Code

hhhcode keeps its data in `~/.hhh`, separate from a stock T3 Code install in `~/.t3`.
The two apps never share a database, so you can keep T3 Code installed while you try hhhcode.

## Import your data

The first time the desktop app starts with an empty `~/.hhh` and finds T3 Code data, it asks
whether to **Import from T3 Code**. Choose **Import** and the app restarts with your threads,
settings and providers. Choose **Start fresh** to begin empty; you can still import later.

From a terminal, with hhhcode stopped:

```sh
t3 migrate from-t3 --dry-run   # show what would be copied, write nothing
t3 migrate from-t3             # import ~/.t3 into ~/.hhh
```

| Flag                    | What it does                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--from <dir>`          | T3 Code home to read. Default `~/.t3`.                                                                            |
| `--to <dir>`            | hhhcode home to create. Default `HHHCODE_HOME`, else `~/.hhh`.                                                    |
| `--dry-run`             | Print the report and write nothing.                                                                               |
| `--force`               | Import even if the destination has data. The old destination is renamed to `<to>.replaced-<time>`, never deleted. |
| `--keep-environment-id` | Keep T3 Code's environment id and signing keys (see below).                                                       |
| `--json`                | Print the report as JSON.                                                                                         |

A server started on an empty `~/.hhh` logs a hint when it finds T3 Code data; it never imports on
its own. Because that first start already creates `~/.hhh`, import afterwards with `--force`.

## What is copied

- Settings, client and desktop settings, keybindings, saved environments, the connection
  catalog, themes, workflows and `service.env`.
- Threads, projects and their history: the database is copied as a consistent snapshot, so it is
  safe even while T3 Code is running.
- Attachments and browser artifacts.
- Every provider instance in your settings (Claude, Codex, Antigravity, OpenCode, Pi, Cursor,
  Grok, Kiro, ACP agents, fx, Muse Code), including extra accounts, their order and account
  profiles, provider homes that T3 Code kept inside `~/.t3`, provider sign-ins (imported straight
  into the OS keychain rather than copied as files), and usage-limit state.

## Where credentials live

hhhcode stores its own credentials (signing keys, peer links, provider sign-ins, self-hosted relay
and TLS private keys, and plugin secrets) in your OS keychain (macOS Keychain, Windows Credential
Manager, or Linux Secret Service). You can check the active backend under **Settings → Secrets**.
On a headless Linux server with no keychain available, hhhcode logs a warning at startup and falls
back to owner-only files (`HHHCODE_SECRET_BACKEND=file` silences the warning;
`HHHCODE_SECRET_BACKEND=keychain` requires a keychain).

Paths that pointed into `~/.t3` are rewritten to `~/.hhh`. T3 Code's own folder is only read:
nothing in `~/.t3` is changed, moved or deleted.

## What is left in place

- **Shared folders.** Worktrees, project-less thread folders (`scratch`) and managed project
  folders stay in `~/.t3`, and imported threads keep pointing there. Provider homes outside
  `~/.t3` (for example a `CLAUDE_CONFIG_DIR` such as `~/.claude_work`, or `~/.codex`) are shared
  as well. The report lists each one.
- **Not copied.** Logs, caches, downloaded runtimes and tools, T3 Connect sign-ins and
  credentials, relay clients, anonymous ids and other telemetry leftovers, and running-server
  state. hhhcode downloads what it needs again.

## Paired devices and the environment id

By default hhhcode starts with a new environment id, so phones and browsers paired with T3 Code
need to be paired again. With `--keep-environment-id` the id, server signing key and peer links
are copied and existing pairings keep working, but then never run T3 Code and hhhcode at the same
time: both would claim to be the same environment.

## Choosing another folder

Set `HHHCODE_HOME` to use a different folder, or pass `--base-dir` to a single command.
`T3CODE_HOME` is still honored when it is set, for setups that already export it; unset it if it
points at your T3 Code folder, or hhhcode will use T3 Code's data directly.

Importing twice is safe: a finished import leaves a marker, and running the command again reports
that the folder was already imported unless you pass `--force`.
