# Terminal

T3 Code includes integrated terminals running on the environment's host machine, with persistent scrollback across reconnects.

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the environment that launches the p0code server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
p0code tries its usual fallback shells.

Example for Git Bash on Windows (PowerShell, then fully quit and reopen T3 Code):

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit p0code, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart p0code.

Each terminal retains up to **5,000 lines** and **8 MiB** of scrollback on the server.

| Action                     | macOS                              | Windows / Linux                            |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| Scroll page up/down        | `Shift+PageUp` / `Shift+PageDown`  | `Shift+PageUp` / `Shift+PageDown`          |
| Jump to start / latest     | `Cmd+Shift+Home` / `Cmd+Shift+End` | `Ctrl+Shift+Home` / `Ctrl+Shift+End`       |
| Select all retained output | `Cmd+A`                            | `Ctrl+Shift+A` (`Ctrl+A` stays shell home) |
| Next / previous terminal   | `Cmd+Shift+]` / `Cmd+Shift+[`      | `Ctrl+Alt+]` / `Ctrl+Alt+[`                |

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. p0code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when p0code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

While a terminal is focused, use `Cmd+Shift+]` for the next terminal and `Cmd+Shift+[` for
the previous one on macOS. On Windows and Linux, use `Ctrl+Alt+]` and `Ctrl+Alt+[`. Cycling
wraps through tabs and split panes in the focused drawer or right panel. Rebind these
shortcuts in Settings > Keybindings.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## fish

p0code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
p0code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches p0code. A shell export applies
when you launch p0code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
