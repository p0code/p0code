import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  containerLabels,
  contextTarArgv,
  directTransferScript,
  healthScript,
  localBuildArgv,
  onHost,
  remoteBuildScript,
  resolveDomains,
  runScript,
  saveScript,
  loadScript,
  specOf,
  tagsToPrune,
  traefikRunArgv,
  type ProxyInfo,
} from "./commands.ts";
import { Target } from "./config.ts";

const makeTarget = Schema.decodeUnknownSync(Target);
const web = makeTarget({
  name: "prod",
  host: "deploy@example.com",
  domains: ["web.example.com", "www.example.com"],
  port: 3000,
  health: { path: "/healthz", timeoutSeconds: 30, intervalSeconds: 2 },
});
const publicProxy: ProxyInfo = { mode: "public", appsDomain: null };

describe("host commands", () => {
  it("runs scripts through ssh in batch mode, or sh locally", () => {
    assert.deepEqual(onHost({ kind: "ssh", address: "deploy@example.com" }, "docker ps"), [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "deploy@example.com",
      "docker ps",
    ]);
    assert.deepEqual(onHost({ kind: "local" }, "docker ps"), ["sh", "-c", "docker ps"]);
  });

  it("builds locally with platform and build args", () => {
    assert.deepEqual(
      localBuildArgv({
        engine: "docker",
        image: "web:abc123",
        dockerfile: "/proj/Dockerfile",
        context: "/proj",
        args: { NODE_ENV: "production" },
        platform: "linux/amd64",
      }),
      [
        "docker",
        "build",
        "-t",
        "web:abc123",
        "-f",
        "/proj/Dockerfile",
        "--platform",
        "linux/amd64",
        "--build-arg",
        "NODE_ENV=production",
        "/proj",
      ],
    );
  });

  it("streams the context to a build host and builds in a temp dir", () => {
    assert.deepEqual(contextTarArgv("/proj", "/proj/.dockerignore"), [
      "env",
      "COPYFILE_DISABLE=1",
      "tar",
      "-c",
      "--exclude=.git",
      "-X",
      "/proj/.dockerignore",
      "-C",
      "/proj",
      ".",
    ]);
    assert.strictEqual(
      remoteBuildScript({
        engine: "podman",
        image: "web:abc",
        dockerfile: "docker/App file",
        args: {},
      }),
      [
        "set -e",
        "d=$(mktemp -d)",
        `trap 'rm -rf "$d"' EXIT`,
        'tar -x -C "$d"',
        `cd "$d" && podman build -t web:abc -f 'docker/App file' .`,
      ].join("\n"),
    );
  });

  it("compresses image transfers and nests the target ssh for direct copies", () => {
    assert.strictEqual(
      saveScript("docker", "web:abc", "zstd"),
      "(set -o pipefail) 2>/dev/null && set -o pipefail; docker save web:abc | zstd -q -c -T0",
    );
    assert.strictEqual(
      loadScript("docker", "gzip"),
      "(set -o pipefail) 2>/dev/null && set -o pipefail; gzip -d -c | docker load",
    );
    assert.strictEqual(
      directTransferScript("docker", "web:abc", "zstd", "deploy@target"),
      "(set -o pipefail) 2>/dev/null && set -o pipefail; docker save web:abc | zstd -q -c -T0 | " +
        "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 deploy@target " +
        `'(set -o pipefail) 2>/dev/null && set -o pipefail; zstd -q -d -c | docker load'`,
    );
  });
});

describe("routing labels", () => {
  it("routes the domains over HTTPS with Let's Encrypt in public mode", () => {
    assert.deepEqual(
      containerLabels({
        app: "web",
        target: web,
        container: "web",
        domains: web.domains,
        proxy: publicProxy,
      }),
      [
        "p0deploy.app=web",
        "p0deploy.target=prod",
        "p0deploy.domains=web.example.com,www.example.com",
        "traefik.enable=true",
        "traefik.docker.network=p0deploy",
        "traefik.http.routers.web.rule=Host(`web.example.com`) || Host(`www.example.com`)",
        "traefik.http.routers.web.entrypoints=websecure",
        "traefik.http.routers.web.service=web",
        "traefik.http.routers.web.tls=true",
        "traefik.http.routers.web.tls.certresolver=letsencrypt",
        "traefik.http.services.web.loadbalancer.server.port=3000",
        "traefik.http.services.web.loadbalancer.healthcheck.path=/healthz",
        "traefik.http.services.web.loadbalancer.healthcheck.interval=2s",
      ],
    );
  });

  it("serves plain HTTP behind a tunnel and both HTTP and self-signed HTTPS on a LAN", () => {
    const target = makeTarget({ name: "prod", host: "h", port: 8080 });
    const tunnel = containerLabels({
      app: "api",
      target,
      container: "api.v2",
      domains: ["api.example.com"],
      proxy: { mode: "tunnel", appsDomain: null },
    });
    assert.includeMembers(
      [...tunnel],
      [
        "traefik.http.routers.api-v2.entrypoints=web",
        "traefik.http.services.api-v2.loadbalancer.server.port=8080",
      ],
    );
    assert.notInclude(tunnel.join("\n"), "tls");

    const lan = containerLabels({
      app: "api",
      target,
      container: "api",
      domains: ["api.lan"],
      proxy: { mode: "lan", appsDomain: null },
    });
    assert.includeMembers(
      [...lan],
      [
        "traefik.http.routers.api.entrypoints=web",
        "traefik.http.routers.api-tls.entrypoints=websecure",
        "traefik.http.routers.api-tls.service=api",
        "traefik.http.routers.api-tls.tls=true",
      ],
    );
    assert.notInclude(lan.join("\n"), "certresolver");
  });

  it("falls back to the server's apps domain, and skips routing without a proxy", () => {
    const target = makeTarget({ name: "prod", host: "h", port: 3000 });
    assert.deepEqual(
      resolveDomains(target, "blog", { mode: "public", appsDomain: "*.apps.example.com" }),
      ["blog.apps.example.com"],
    );
    assert.deepEqual(resolveDomains(target, "blog", null), []);
    assert.deepEqual(
      containerLabels({ app: "blog", target, container: "blog", domains: [], proxy: null }),
      ["p0deploy.app=blog", "p0deploy.target=prod"],
    );
  });
});

describe("container scripts", () => {
  it("joins the proxy network and sends forwarded secrets only on stdin", () => {
    const target = makeTarget({
      name: "prod",
      host: "h",
      port: 3000,
      envFile: "/srv/web/.env",
      forwardEnv: ["API_KEY"],
      volumes: ["web-data:/data"],
      health: { cmd: "wget -qO- localhost:3000/healthz" },
    });
    const script = runScript({
      engine: "docker",
      name: "web-next",
      image: "web:abc",
      target,
      network: "p0deploy",
      labels: ["p0deploy.app=web"],
      forwardedEnv: true,
    });
    assert.strictEqual(
      script,
      [
        "set -e",
        "umask 077",
        "f=$(mktemp)",
        `trap 'rm -f "$f"' EXIT`,
        'cat > "$f"',
        "docker run -d --name web-next --restart unless-stopped --network p0deploy -v web-data:/data " +
          "--env-file /srv/web/.env --label p0deploy.app=web " +
          `--health-cmd 'wget -qO- localhost:3000/healthz' --health-interval 2s --health-retries 3 ` +
          '--env-file "$f" web:abc',
      ].join("\n"),
    );
  });

  it("health-checks the new container from the Traefik container", () => {
    assert.strictEqual(
      healthScript({ engine: "docker", container: "web-next", health: web.health, port: 3000 }),
      [
        "n=0",
        "while :; do",
        `  s=$(docker container inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' web-next 2>/dev/null)`,
        '  case "$s" in',
        `    "true healthy"|"true ") if docker exec p0deploy-traefik wget -q -O /dev/null -T 5 http://web-next:3000/healthz >/dev/null 2>&1; then exit 0; fi ;;`,
        '    "true "*) ;;',
        "    *) exit 1 ;;",
        "  esac",
        "  n=$((n+1))",
        '  [ "$n" -ge 15 ] && exit 1',
        "  sleep 2",
        "done",
      ].join("\n"),
    );
    assert.match(
      healthScript({ engine: "docker", container: "web-next", health: undefined, port: undefined }),
      /^sleep 2\n/u,
    );
  });

  it("prunes only old tags that no container uses", () => {
    assert.deepEqual(tagsToPrune(["e", "d", "<none>", "c", "b", "a"], 2, new Set(["b"])), [
      "c",
      "a",
    ]);
  });
});

describe("traefik", () => {
  it("runs Traefik with ACME in public mode", () => {
    const argv = traefikRunArgv({
      engine: "docker",
      mode: "public",
      email: "ops@example.com",
      appsDomain: "apps.example.com",
      image: "traefik:v3",
    });
    assert.deepEqual(argv, [
      "docker",
      "run",
      "-d",
      "--name",
      "p0deploy-traefik",
      "--restart",
      "unless-stopped",
      "--network",
      "p0deploy",
      "-p",
      "80:80",
      "-p",
      "443:443",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      "-v",
      "p0deploy-acme:/acme",
      "--label",
      "p0deploy.mode=public",
      "--label",
      "p0deploy.apps-domain=apps.example.com",
      "--label",
      `p0deploy.spec=${specOf(argv)}`,
      "traefik:v3",
      "--providers.docker=true",
      "--providers.docker.exposedbydefault=false",
      "--providers.docker.network=p0deploy",
      "--entrypoints.web.address=:80",
      "--entrypoints.websecure.address=:443",
      "--entrypoints.web.http.redirections.entrypoint.to=websecure",
      "--entrypoints.web.http.redirections.entrypoint.scheme=https",
      "--certificatesresolvers.letsencrypt.acme.email=ops@example.com",
      "--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
      "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
    ]);
    assert.match(specOf(argv), /^[0-9a-f]{8}$/u);
  });

  it("binds plain HTTP to loopback in tunnel mode and uses the podman socket", () => {
    const argv = traefikRunArgv({
      engine: "podman",
      mode: "tunnel",
      email: null,
      appsDomain: null,
      image: "traefik:v3",
    });
    assert.includeMembers(
      [...argv],
      [
        "127.0.0.1:80:80",
        "/run/podman/podman.sock:/var/run/docker.sock:ro",
        "--entrypoints.web.forwardedheaders.insecure=true",
      ],
    );
    assert.notInclude(argv.join(" "), "443");
    assert.notInclude(argv.join(" "), "acme.email");
  });
});
