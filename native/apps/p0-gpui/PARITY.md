# `p0-gpui` Feature Parity Roadmap

This document tracks honest parity between `apps/web` (the React/Vite client) and `native/apps/p0-gpui` (the native GPUI desktop client talking to `apps/p0d`).

**Status legend:**
- **done** — implemented and wired end-to-end against `p0d` in this PR.
- **stub** — typed/routed placeholder or partial surface present; full behavior pending.
- **todo** — not yet started.

## Web Routes (`apps/web/src/routes/`)

| Web Route | Surface / Purpose | Status | Notes |
| --- | --- | --- | --- |
| `__root.tsx` | App shell, theme, connection bootstrap | **done** | Single GPUI window, system dark/light theme mirroring `apps/web/src/index.css`, `p0d` attach/spawn + local bootstrap auth |
| `_chat.tsx` | Main sidebar + thread layout | **done** | Collapsible project/thread sidebar, connection status chip, main pane |
| `_chat.index.tsx` | Default chat landing / active thread | **done** | Auto-selects active thread or shows empty state |
| `_chat.$environmentId.$threadId.tsx` | Open thread view | **done** | Virtualized variable-height feed, Markdown + code blocks, streaming deltas (<=60 Hz), approval card, composer |
| `threads.$environmentId.$threadId.tsx` | Direct thread permalink | **stub** | Local single-environment selection works; deep-link URL routing todo |
| `_chat.new.tsx` | New thread launcher | **stub** | Launching into selected project supported via `orchestration.launchThread` in `p0-client`; dedicated new-thread screen todo |
| `_chat.draft.$draftId.tsx` | Saved draft thread | **todo** | Local draft persistence not yet ported |
| `projects.$projectKey.tsx` | Project overview route | **stub** | Projects listed & collapsible in sidebar; dedicated project detail view todo |
| `_chat.linked.$viaEnvironmentId.$linkedEnvironmentId.$linkedThreadId.tsx` | Linked peer environment thread | **todo** | Multi-environment & peer links are Phase 4 |
| `_chat.pull-requests.tsx` | Pull requests list & review | **todo** | Phase 4 |
| `_chat.issues.tsx` | Issue tracker list & detail | **todo** | Phase 4 |
| `_chat.workflows.tsx` | Workflows runs & DAG view | **todo** | Phase 5 |
| `_chat.usage.tsx` | Token usage & cost dashboard | **todo** | Phase 5 |
| `welcome.tsx` | First-run onboarding | **todo** | Phase 4 |
| `pair.tsx` | Remote environment pairing (DPoP) | **stub** | `AuthMode::Dpop` stub in `p0-client`; ES256 keychain + pairing flow is Phase 4 |
| `connect.tsx` | Self-hosted relay / remote connect | **todo** | Phase 4 |
| `connect-agent.tsx` | Connect MCP agent flow | **todo** | Phase 4 |
| `approve-agent.tsx` | Approve MCP agent sign-in | **todo** | Phase 4 |
| `guest.tsx` | Guest share view | **todo** | Phase 4 |
| `_chat.settings.tsx` | Settings layout shell | **todo** | Phase 3/5 |
| `_chat.settings.open-source-licenses.tsx` | Third-party license notices | **todo** | Phase 5 |
| `_chat.settings.beta.tsx` | Legacy redirect -> `/settings/labs` | **todo** | Redirect only |
| `_chat.settings.integrations.tsx` | Legacy redirect -> `/settings/source-control` | **todo** | Redirect only |
| `_chat.settings.storage.tsx` | Legacy redirect -> `/settings/maintenance` | **todo** | Redirect only |

## Settings Sections (All 25 `SettingsPath` entries)

| Settings Route | Label | Status | Target Phase |
| --- | --- | --- | --- |
| `/settings/general` | General | **todo** | Phase 3 |
| `/settings/appearance` | Appearance | **stub** | Follows system dark/light automatically; manual theme/font overrides in Phase 3 |
| `/settings/chat` | Chat | **todo** | Phase 3 |
| `/settings/diffs` | Diffs & pull requests | **todo** | Phase 3 |
| `/settings/keybindings` | Keybindings | **todo** | Phase 3 |
| `/settings/voice` | Voice | **todo** | Phase 6 |
| `/settings/snap-shot` | SnapShots | **todo** | Phase 6 |
| `/settings/providers` | Providers | **stub** | Providers & models loaded from `server.getConfig` for the composer model picker; provider management UI in Phase 3 |
| `/settings/threads` | Threads | **todo** | Phase 3 |
| `/settings/browser` | Browser | **todo** | Phase 6 |
| `/settings/devices` | Devices | **todo** | Phase 6 |
| `/settings/scheduled-tasks` | Scheduled tasks | **todo** | Phase 5 |
| `/settings/projects` | Projects | **todo** | Phase 3 |
| `/settings/source-control` | Source control & issues | **todo** | Phase 4 |
| `/settings/worktrees` | Worktrees | **todo** | Phase 3 |
| `/settings/deploy` | Deploy | **todo** | Phase 5 |
| `/settings/connections` | Environments | **stub** | Local `p0d` auto-attach/spawn + `--url` CLI flag; remote/DPoP environment catalog in Phase 4 |
| `/settings/access` | Sharing & access | **todo** | Phase 4 |
| `/settings/secrets` | Secrets | **todo** | Phase 4 |
| `/settings/plugins` | Plugins | **todo** | Phase 5 |
| `/settings/maintenance` | Maintenance | **todo** | Phase 5 |
| `/settings/diagnostics` | Diagnostics | **todo** | Phase 5 |
| `/settings/labs` | Labs | **todo** | Phase 5 |
| `/settings/about` | About | **todo** | Phase 3 |
| `/settings/archived` | Archive | **todo** | Phase 3 |

## Known Phase 1 Limitations / TODOs

- **Remote / DPoP auth (`AuthMode::Dpop`)**: Stubbed in `p0-client`; returns `ClientError::Unimplemented`. Local desktop bootstrap via `--desktop-bootstrap-secret-file` + HMAC-SHA256 `/oauth/token` exchange is implemented end-to-end.
- **Terminal drawer, Diff panel, File explorer, Command palette**: Planned for Phases 2–3.
- **Rich Markdown extensions**: Headings, paragraphs, lists, emphasis, inline code, links, and fenced code blocks are parsed with `pulldown-cmark` and cached per `(item_id, revision)`. KaTeX, Mermaid, and custom citation chips are deferred to later phases.
- **Headless verification**: When no Wayland/X11 display is present, run `p0-gpui --smoke` to boot/connect, fetch `server.probe` + `server.getConfig` + shell snapshot, print counts, and exit cleanly.
