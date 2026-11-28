# Backend split: GUI apps + native `p0d` backend

Goal: on macOS, Linux and Windows the desktop **GUI** (Electron) and the **backend** ship and run
as separate things. The backend becomes a small native Go binary (`p0d`) that uses far less disk,
CPU and RAM than the Node server, and the SQLite database gets smaller.

## Why Go

Go builds one static binary per OS/arch, cross-compiles from one machine, compiles fast, and has
good libraries for the hard parts here (process/PTY handling, WebSockets, SQLite). Rust would save
a little more memory but costs much more time to port ~320k lines. Expect roughly 20–40 MB RSS for
the daemon instead of a few hundred MB for Node.

## Strategy: port piece by piece behind a proxy

Rewriting everything at once is not realistic. So:

1. `apps/p0d` (Go module) is **the backend the GUI, web and mobile clients talk to**. It serves the
   same HTTP routes and the same WebSocket RPC wire protocol (`effect/rpc`, `RpcSerialization.layerJson`)
   as `apps/server`, so clients do not change.
2. Every RPC method / HTTP route that `p0d` has ported is handled in Go. Every other one is
   **forwarded** to a legacy Node sidecar (`apps/server`). `p0d` starts the sidecar only when
   something needs it, on loopback, with an internal token, and stops it after it sits idle.
3. Domains move from the sidecar into Go one at a time (see `rpc-inventory.md`). When the last one
   moves, the sidecar and Node runtime are dropped from the backend package.

## `p0d` CLI contract (GUI and packaging depend on this; keep it stable)

```
p0d serve --home <dir> [--host 127.0.0.1] [--port 0] [--ready-file <path>] [--legacy-server <cmd>]
          [--desktop-bootstrap-secret-file <path>]
p0d version
p0d service install|uninstall|start|stop|status   # launchd (mac), systemd --user (linux), Task Scheduler/service (windows)
```

- `--home` is the same data dir the Node server uses today (e.g. `~/.p0code/userdata`).
- When it is ready to accept connections it writes JSON `{"pid":..,"port":..,"url":".."}` to `--ready-file`
  and answers `GET /healthz` with 200.
- `--legacy-server` is the command that starts the Node sidecar. Packaging fills it in. Unset means
  run with no sidecar (unported methods fail).
- `--desktop-bootstrap-secret-file` names the GUI's desktop secret (base64url text of at least 32
  bytes, mode 0600 on macOS/Linux). p0d reads it once at startup and refuses to start if it is
  missing, empty, too short or readable by others; rotating it means restarting p0d. With it, p0d
  signs the desktop in on `/oauth/token` without the sidecar (PROTOCOL.md §2.5, §6).

## Desktop split

- The desktop app's backend is `p0d` unless the user explicitly picks another mode. Installs that
  never chose (including ones that recorded the old `"embedded"` default) move to p0d on upgrade.
- The GUI bundles the p0d built from the same commit at `resources/p0d/`, next to the Node server,
  and starts `p0d serve --home <userdata> --port 0 --ready-file … --desktop-bootstrap-secret-file …
  --legacy-server "<electron> <server bin.mjs> --mode web --no-browser"` as its child. A p0d already
  answering `/healthz` at the URL in that ready file is attached instead; one the app started stops
  when the app quits, and the app restarts it if it exits. `p0d service …` is only used once the user
  has installed a p0d service themselves.
- The secret file holds a stable 64-hex secret (mode 0600, written then renamed) so a p0d left running
  by an earlier launch still accepts this launch's tokens. Only p0d reads it; the Node sidecar never
  receives it, so a desktop sign-in never wakes Node.
- The sidecar runs in web mode, so features that need the desktop's private channels to a
  desktop-mode server (fd 3–7: telemetry, the in-app browser host, app-update handoff) are not
  available through p0d until they move into Go.
- The Node server run directly by the app (`"embedded"`) is a deprecated escape hatch: a user picks it
  in Settings, or for one launch from the dialog shown when p0d can't start. The app never falls back
  to it on its own.
- Releases also ship p0d as its own archive, so the backend can run headless on servers.

## Database shrink

Measured on a real DB (`statev2.sqlite`, 605 MB): `projection_turn_items` 225 MB, `orchestration_events`
152 MB (62 MB of it is `turn-item.updated` snapshots), `projection_nodes` 65 MB, with heavy index
overhead. Payload JSON compresses about 4x with zstd -3. No auto_vacuum.
The schema stays shared: Go reads and writes the same DB, so schema changes go into the existing
migrations in `apps/server/src/persistence/Migrations`.
