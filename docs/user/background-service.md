# Running p0code in the background

On Linux, macOS, and Windows, p0code can run as a service for your user so you
do not need to keep a terminal open.

## Manage the service

Install the `p0` CLI first ([Install p0code](./install.md#command-line)), then
run these commands on the machine that will host p0code:

| Task                                  | Command                |
| ------------------------------------- | ---------------------- |
| Set up access from your other devices | `p0 up`                |
| See how your other devices reach it   | `p0 status`            |
| Install and start                     | `p0 service install`   |
| Inspect status and log location       | `p0 service status`    |
| Move to a newer release               | `p0 update`            |
| Restart                               | `p0 service restart`   |
| Stop and remove from startup          | `p0 service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `p0 service install` again repairs a service that `p0 service status`
reports as broken.

`p0 update` downloads the newest release on your channel and switches `p0`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `p0 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating p0code](./updating.md).

Pass an exact version (`p0 update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `p0 update` ask for confirmation before
installing one.

`p0 uninstall` removes the background service, the `p0` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.p0code/userdata` are kept, along with `service.env`
under T3 home. Pass `--yes` from a script.

## Local network access

A new service answers only on this machine. Other devices reach it over the
local network or a relay: choose the local network in `p0 up` (or run
`p0 up --lan`, which sets `T3CODE_LAN=true` in `service.env`), and link a relay
for a public HTTPS address with `p0 relay link https://relay-host --token
TOKEN` (see [Remote access](./remote-access.md#self-hosted-relay)). With the local
network on, the service listens on your local network and Tailscale addresses,
so the desktop and mobile apps on the same network connect directly instead of
through the relay. It still does not answer on public addresses unless a relay
or a reverse proxy fronts it. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. The hosted web app at app.t3.codes
needs an HTTPS address, such as the relay's public origin, because browsers
block plain HTTP from an HTTPS page.

A service installed before `T3CODE_LAN` existed keeps listening on the local
network. `p0 status` says so, and `p0 up --no-lan` turns it off. Any
`T3CODE_HOST` value replaces this setting.

## Configure the service environment

Put custom environment variables in `service.env` under the service's T3 home
directory, normally `~/.p0code/service.env`. This file survives service installation
and updates. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `P0CODE_HOME`, `T3CODE_HOME`,
`T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `p0 service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `p0 service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default T3 home, `chmod 600 ~/.p0code/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so p0code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

> Note: Signing out of T3 Connect does not stop or uninstall the background service.

## Keep the server responsive under memory pressure (Linux)

`p0 up` installs the service as part of setting up remote access, but the two
are managed separately. Unlinking the relay does not stop or uninstall the
service.

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
p0 service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `p0 service restart`. `p0 service status` reports whether
the protection is in place, and `p0 service protect --undo` removes it.

## Troubleshooting

Start with `p0 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

| Status                                 | Fix                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger-disabled`                      | Run `sudo loginctl enable-linger "$(id -un)"` (or `ssh -t your-server '...'`), then retry setup as your normal user. Never run T3 Code as root. |
| `linger-unavailable`                   | Check `loginctl show-user "$(id -un)" --property=Linger` and verify `systemd-logind`.                                                           |
| `user-manager-unavailable`             | Run `systemctl --user status` in a login session to verify systemd user support.                                                                |
| `service-disabled` / `service-stopped` | Check the log and `systemctl --user status t3code.service`, then run `t3 service install`.                                                      |
| `restart-pending`                      | Run `t3 service restart` to switch to the newly installed version.                                                                              |

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running p0code as root creates a separate installation. Without
administrator access, run `p0 serve` in a terminal and keep that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and, on Linux, `systemctl --user status t3code.service`, then use the repair command printed by p0code.           |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `p0 service restart`.                            |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `p0` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after linking a relay, see
[Remote access](./remote-access.md#self-hosted-relay).

## Reclaim database space

p0code removes internal history older than a day on its own while it runs;
your conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

When the desktop app or the background service runs p0code on that machine,
select **Reclaim** in Settings on web or desktop. p0code checks for free disk
space, then stops, repairs the database, and starts again. It is offline while
the repair runs, and running agents stop. If the repair fails, Settings shows
why.

In other cases, such as a server you started by hand, run `p0 doctor` on the
machine that hosts the environment. It reports the database size and the
space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use, and names the server
process that holds it when it can tell. While the repair runs, a server started
for the same data directory, for example by a desktop app connecting over SSH,
is refused until the repair ends. Use `--base-dir` for a different data
directory.

The repair's time grows with the size of the whole database, not only the
space it reclaims, and can exceed an hour on a large database or a slow disk;
`p0 doctor` shows each step as it runs. It rebuilds the database through a
temporary copy, so it needs free space of about twice the data still in use
(the database size minus the reclaimable space): once in the system temporary
directory (on Linux and macOS, `TMPDIR`, or `/var/tmp` when it is not set) and
once next to the database for its write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `p0 doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings. It does
not offer to delete it while any project or thread you have not deleted is
missing from the current database, so the old file stays available for
recovery.
