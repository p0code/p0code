# p0deploy

A very small deploy tool built for coding agents. It builds a container image on this machine or on a build host, copies the image to your servers over `ssh`, and swaps it in behind Traefik once it is healthy. You don't need a registry, a control plane, Kubernetes or a web UI. A deploy host needs only Docker (or Podman), one Traefik container, and `sshd`.

p0deploy uses your own `ssh` binary, and gives itself a dedicated key once you run `p0deploy ssh setup <host>`. `~/.ssh/config`, your agent and your existing keys keep working, and you never copy keys to a server by hand.

## Quickstart

```sh
p0deploy ssh setup deploy@203.0.113.9                             # once per host: teaches p0deploy its own key
p0deploy init --host deploy@203.0.113.9 --domain app.example.com    # writes p0deploy.json from your Dockerfile
p0deploy server init deploy@203.0.113.9 --email ops@example.com     # once per host: installs Traefik + Let's Encrypt
p0deploy doctor                                                     # ssh, docker, zstd, traefik on every host
p0deploy up                                                         # build → copy → swap once healthy
p0deploy rollback                                                   # back to the previous image
```

## SSH access

`p0deploy ssh setup deploy@host` tries, in order:

1. The install's own key, at `<p0code data dir>/deploy/keys/p0deploy_ed25519` (mode `600`). If it already logs in, setup is done.
2. Your existing `ssh` (agent or `~/.ssh/config`). It appends the public key to the remote `~/.ssh/authorized_keys`, guarded by `grep -qxF`, and creates the directory and file with the usual `700`/`600` modes.
3. A password: `--password` prompts on a terminal (hidden), and agents set `P0DEPLOY_SSH_PASSWORD` because they cannot answer a prompt. The password goes only into a temporary `SSH_ASKPASS` helper and a `0600` temp file, never into argv, logs or the script; both files are deleted afterwards.

Setup connects use `StrictHostKeyChecking=accept-new`, so a new host key is pinned once. Every other command still runs with `BatchMode=yes` and never prompts.

If none of that works, setup tells you to pass `--password` or set `P0DEPLOY_SSH_PASSWORD`. For a fully manual fallback, `p0deploy ssh key` prints the public key's path and value so you can paste it into `~/.ssh/authorized_keys` yourself. Once the key exists, every command offers it with `ssh -i <path> -o IdentitiesOnly=yes`; `~/.ssh/config` aliases and other agent identities keep working, and installs without the key behave exactly as before.

The data directory follows the rest of p0code: `P0CODE_HOME`, then `HHHCODE_HOME` or `T3CODE_HOME`, else `~/.p0code`.

## How a deploy works

1. **Build.** The image is tagged `<app>:<git sha>`. A dirty tree gets `<sha>-dirty-<UTC timestamp>`, and a folder without git gets just the timestamp. With `build.host` (or `--build-host`), the build context goes to that host as a tar stream and is built in a temp dir there. `.dockerignore` is applied with `tar -X`, so `!` negations are not supported in that path.
2. **Copy.** If the target already has the image ID, the copy is skipped. Otherwise the image is sent as `docker save | zstd` (or gzip when either side lacks zstd) piped into `ssh target docker load`. When the image was built on a build host, it goes straight from the build host to the target if the build host can reach the target over ssh (`transfer: "auto"`). If not, it goes through this machine.
3. **Swap.** The new container starts as `<container>-next`. It has the same Traefik labels as the live one, so Traefik sends traffic to both. p0deploy then waits for it to be healthy. On success, the old container is stopped and kept as `<container>-prev`, with restart policy `no`, and `-next` is renamed to `<container>`. On failure, `-next` is removed and the old container keeps serving. You get exit code 3 and the new container's last log lines.
4. **Prune.** On each target, the newest `keepImages` tags are kept, plus any tag a container still uses.

`rollback` runs the same swap with the `-prev` container's image, or with `--to <tag>` from the kept tags. Rolling back twice rolls forward again.

Health is checked like this:

- `health.path`: fetched from the Traefik container at `http://<container>-next:<port><path>` over the `p0deploy` network. Your image doesn't need curl.
- `health.cmd`: becomes the container's Docker `HEALTHCHECK`. Traefik doesn't route to a container until it is healthy, so this gives a true zero-downtime swap. With Podman, healthchecks need systemd timers.
- A `HEALTHCHECK` in your image is also honored.
- With no health signal at all, the container only has to keep running for a short grace period.

Targets that publish host `ports` (for non-HTTP services) can't run two copies at once. For those, the old container is stopped first and restarted if the new one fails.

## Servers: `server init` and domains

```sh
p0deploy server init <ssh-target> [--mode public|tunnel|lan] [--email you@x.com] [--apps-domain apps.example.com] [--engine docker|podman]
p0deploy server status <ssh-target>
```

`server init` is idempotent. It creates the `p0deploy` network and the `p0deploy-acme` volume, pulls `traefik:v3`, and (re)creates the `p0deploy-traefik` container only when its settings or the image changed. Traefik reads routes from Docker labels through the Docker socket (`/run/podman/podman.sock` for Podman, which needs `podman.socket` enabled). There are no Traefik config files.

| mode     | Traefik listens on | TLS                                                                    |
| -------- | ------------------ | ---------------------------------------------------------------------- |
| `public` | `:80`, `:443`      | Let's Encrypt HTTP-01 (`--email` required); HTTP redirects to HTTPS    |
| `tunnel` | `127.0.0.1:80`     | Terminated upstream, e.g. Cloudflare Tunnel pointing at `localhost:80` |
| `lan`    | `:80`, `:443`      | Plain HTTP, plus HTTPS with Traefik's self-signed certificate          |

Each target lists its `domains`. Containers join the `p0deploy` network and get labels like these:

```
traefik.enable=true
traefik.http.routers.<container>.rule=Host(`app.example.com`) || Host(`www.example.com`)
traefik.http.routers.<container>.entrypoints=websecure
traefik.http.routers.<container>.tls.certresolver=letsencrypt
traefik.http.services.<container>.loadbalancer.server.port=<port>
```

If a target has no `domains` and the server was set up with `--apps-domain apps.example.com` (`*.apps.example.com` also works), the app is served at `<container>.apps.example.com`. Point a wildcard DNS record at the host. Each name still gets its own HTTP-01 certificate. If there are no domains and no apps domain, the container runs without a route.

## Config reference (`p0deploy.json`)

```jsonc
{
  "app": "web", // image name: web:<tag>
  "engine": "docker", // or "podman"
  "build": {
    "context": ".", // relative to this file
    "dockerfile": "Dockerfile", // relative to context
    "args": { "NODE_ENV": "production" }, // visible in image history: no secrets
    "platform": "linux/amd64", // optional, e.g. building on Apple silicon
    "host": "builder", // optional build host; default: this machine
  },
  "keepImages": 3, // tags kept per target for rollback --to
  "server": { "mode": "public", "email": "ops@example.com", "appsDomain": "apps.example.com" }, // server init defaults
  "targets": [
    {
      "name": "prod",
      "host": "deploy@203.0.113.9", // anything `ssh` accepts, or "local"
      "container": "web", // default: app
      "domains": ["web.example.com"],
      "port": 3000, // port the app listens on in the container
      "envFile": "/srv/web/.env", // read on the target by docker --env-file
      "forwardEnv": ["DATABASE_URL"], // copied from this process's env at deploy time
      "volumes": ["web-data:/data"],
      "ports": [], // host port mappings, for non-HTTP services only
      "restart": "unless-stopped",
      "health": { "path": "/healthz", "cmd": "…", "timeoutSeconds": 60, "intervalSeconds": 2 },
      "transfer": "auto", // auto | direct | relay (build host → target path)
    },
  ],
}
```

Unknown keys are rejected, so typos fail loudly with exit code 2.

**Secrets** never go in this file or in argv. Use `envFile` (a file that already exists on the target) or `forwardEnv` (variable names). Forwarded values travel only on ssh's stdin into a `0600` temp file that is deleted after `docker run`. Like any container env, they are still visible to people who can run `docker inspect` on the host.

## For agents

Every command accepts `--json` and prints exactly one JSON document on stdout. Progress and build output go to stderr only in human mode.

```jsonc
{ "ok": true,  "command": "up", "data": { "build": {…}, "targets": [{ "target": "prod", "image": "web:3f2a…", "previousImage": "web:9c1d…", "urls": ["https://web.example.com"], "transfer": { "mode": "direct", "codec": "zstd", … }, … }] } }
{ "ok": false, "command": "up", "error": { "code": "HEALTH_CHECK_FAILED", "message": "…kept web:9c1d… running", "exitCode": 3, "target": "prod", "output": "<last log lines>" } }
```

| exit | meaning                                                         | error codes                                                                                                                 |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                            |                                                                                                                             |
| 1    | something failed (ssh, docker, missing image, doctor checks)    | `COMMAND_FAILED`, `IMAGE_NOT_FOUND`, `NOTHING_TO_ROLLBACK`, `SERVER_NOT_INITIALIZED`                                        |
| 2    | fix the config or the invocation                                | `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `CONFIG_EXISTS`, `NO_DOCKERFILE`, `TARGET_NOT_FOUND`, `ENV_MISSING`, CLI usage errors |
| 3    | the new version never became healthy; the old one is still live | `HEALTH_CHECK_FAILED`                                                                                                       |

A typical loop:

```sh
p0deploy doctor --json                    # data.ok false → read data.checks[].detail
p0deploy up --json                        # exit 3 → read error.output, fix the code, run up again
p0deploy status --json                    # data[].current.image, data[].urls, data[].images (kept tags)
p0deploy logs --target prod --tail 200 --json
p0deploy rollback --json                  # or: rollback --to <tag from status>
```

ssh always runs with `BatchMode=yes`, so it never waits for a password or host-key prompt. `p0deploy ssh setup` records a new host key once; ordinary commands never prompt.

## Library

The CLI is a thin layer over a typed Effect API (`@t3tools/p0deploy`), which a server plugin can call directly:

```ts
import * as P0Deploy from "@t3tools/p0deploy";

const program = Effect.gen(function* () {
  const loaded = yield* P0Deploy.loadConfig("/repo/p0deploy.json");
  return yield* P0Deploy.up(loaded, { buildHost: settings.defaultBuildHost }); // UpResult, fails with DeployError
}).pipe(Effect.provide(P0Deploy.layerShell({ verbose: false })));
// layerShell needs a ChildProcessSpawner, FileSystem and Path (NodeServices.layer provides all three);
// loadConfig/build need FileSystem + Path.
```

The other entry points are `build`, `push`, `swap`, `rollback`, `status`, `logs`, `doctor`, `initConfig`, `serverInit`, `serverStatus`, `sshSetup`, `sshKey` and `bootstrapSsh`. `DeployError.code` and `exitCodeFor(code)` match the CLI.
