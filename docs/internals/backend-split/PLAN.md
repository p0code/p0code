# Backend split: GUI apps + native `hhhd` backend

Goal: on macOS, Linux and Windows the desktop **GUI** (Electron) and the **backend** ship and run
as separate things. The backend becomes a small native Go binary (`hhhd`) that uses far less disk,
CPU and RAM than the Node server, and the SQLite database gets smaller.

## Why Go

Go builds one static binary per OS/arch, cross-compiles from one machine, compiles fast, and has
good libraries for the hard parts here (process/PTY handling, WebSockets, SQLite). Rust would save
a little more memory but costs much more time to port ~320k lines. Expect roughly 20–40 MB RSS for
the daemon instead of a few hundred MB for Node.

## Strategy: port piece by piece behind a proxy

Rewriting everything at once is not realistic. So:

1. `apps/hhhd` (Go module) is **the backend the GUI, web and mobile clients talk to**. It serves the
   same HTTP routes and the same WebSocket RPC wire protocol (`effect/rpc`, `RpcSerialization.layerJson`)
   as `apps/server`, so clients do not change.
2. Every RPC method / HTTP route that `hhhd` has ported is handled in Go. Every other one is
   **forwarded** to a legacy Node sidecar (`apps/server`). `hhhd` starts the sidecar only when
   something needs it, on loopback, with an internal token, and stops it after it sits idle.
3. Domains move from the sidecar into Go one at a time (see `rpc-inventory.md`). When the last one
   moves, the sidecar and Node runtime are dropped from the backend package.

## `hhhd` CLI contract (GUI and packaging depend on this; keep it stable)

```
hhhd serve --home <dir> [--host 127.0.0.1] [--port 0] [--ready-file <path>] [--legacy-server <cmd>]
hhhd version
hhhd service install|uninstall|start|stop|status   # launchd (mac), systemd --user (linux), Task Scheduler/service (windows)
```

- `--home` is the same data dir the Node server uses today (e.g. `~/.hhh/userdata`).
- When it is ready to accept connections it writes JSON `{"pid":..,"port":..,"url":".."}` to `--ready-file`
  and answers `GET /healthz` with 200.
- `--legacy-server` is the command that starts the Node sidecar. Packaging fills it in. Unset means
  run with no sidecar (unported methods fail).

## Desktop split

- The GUI app no longer starts the Node server itself. It connects to a backend URL: by default the
  local `hhhd` (which it can install, start and repair as a user service), or any remote/self-hosted one.
- Releases ship separate artifacts per OS: `HHHCode` (GUI) and `hhhd` (backend, plus the legacy sidecar
  until the port is done). The backend can also run headless on servers.

## Database shrink

Measured on a real DB (`statev2.sqlite`, 605 MB): `projection_turn_items` 225 MB, `orchestration_events`
152 MB (62 MB of it is `turn-item.updated` snapshots), `projection_nodes` 65 MB, with heavy index
overhead. Payload JSON compresses about 4x with zstd -3. No auto_vacuum.
The schema stays shared: Go reads and writes the same DB, so schema changes go into the existing
migrations in `apps/server/src/persistence/Migrations`.
