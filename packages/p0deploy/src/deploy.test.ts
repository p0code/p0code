import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { onHost, type Argv } from "./commands.ts";
import { parseConfig, type LoadedConfig } from "./config.ts";
import { push, rollback, swap, up } from "./deploy.ts";
import { serverInit } from "./server.ts";
import { Shell, type ExecResult } from "./shell.ts";

interface Call {
  readonly argv: Argv;
  readonly stdin?: string;
  readonly piped?: boolean;
}

/** Answers each command by the first rule whose pattern occurs in its script; everything else succeeds silently. */
const fakeShell = (rules: ReadonlyArray<readonly [string, Partial<ExecResult>]>) => {
  const calls: Array<Call> = [];
  const answer = (argv: Argv): ExecResult => {
    const script = argv.join(" ");
    const rule = rules.find(([pattern]) => script.includes(pattern));
    return { exitCode: 0, stdout: "", stderr: "", ...rule?.[1] };
  };
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      exec: (argv, options) =>
        Effect.sync(() => {
          calls.push(options?.stdin === undefined ? { argv } : { argv, stdin: options.stdin });
          return answer(argv);
        }),
      pipe: (stages) =>
        Effect.sync(() =>
          stages.map((argv) => {
            calls.push({ argv, piped: true });
            return answer(argv);
          }),
        ),
      note: () => Effect.void,
    }),
  );
  /** The remote script of each call, which is the last argv entry for both ssh and `sh -c`. */
  const scripts = () => calls.map((call) => call.argv.at(-1) ?? "");
  return { calls, scripts, layer };
};

const loadedConfig = (value: unknown) =>
  Effect.map(parseConfig(JSON.stringify(value), "/proj/p0deploy.json"), (config): LoadedConfig => ({
    path: "/proj/p0deploy.json",
    config,
    contextDir: "/proj",
    dockerfilePath: "/proj/Dockerfile",
  }));

const webConfig = (target: Record<string, unknown> = {}) =>
  loadedConfig({
    app: "web",
    targets: [
      {
        name: "prod",
        host: "deploy@example.com",
        domains: ["web.example.com"],
        port: 3000,
        health: { path: "/healthz" },
        ...target,
      },
    ],
  });

const PROXY = [
  'Labels "p0deploy.mode"',
  { stdout: "public||abcd1234|sha256:t|running\n" },
] as const;
const RUNNING_OLD = [
  "for n in web;",
  { stdout: "/web|web:old|running|2026-11-24T00:00:00Z\n" },
] as const;

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

const indexOf = (scripts: ReadonlyArray<string>, pattern: string) =>
  scripts.findIndex((script) => script.includes(pattern));
const lastIndexOf = (scripts: ReadonlyArray<string>, pattern: string) =>
  scripts.findLastIndex((script) => script.includes(pattern));

describe("swap", () => {
  it.effect("keeps the old container serving until the new one is healthy", () =>
    Effect.gen(function* () {
      const shell = fakeShell([PROXY, RUNNING_OLD]);
      const loaded = yield* webConfig();
      const target = loaded.config.targets[0]!;
      const result = yield* swap(loaded, target, "web:new").pipe(
        Effect.provide(shell.layer),
        withEnv({}),
      );
      const scripts = shell.scripts();
      const run = indexOf(scripts, "docker run -d --name web-next");
      const health = indexOf(scripts, "wget -q -O /dev/null -T 5 http://web-next:3000/healthz");
      const stop = indexOf(scripts, "docker stop web");
      assert.isAbove(run, -1);
      assert.isAbove(health, run);
      assert.isAbove(stop, health, "old container must stop only after the new one is healthy");
      assert.include(scripts[run] ?? "", "--network p0deploy");
      assert.include(scripts[run] ?? "", "'traefik.http.routers.web.rule=Host(`web.example.com`)'");
      assert.isBelow(
        indexOf(scripts, "docker rename web web-prev"),
        indexOf(scripts, "docker rename web-next web"),
      );
      assert.deepEqual(result.urls, ["https://web.example.com"]);
      assert.strictEqual(result.previousImage, "web:old");
      assert.isFalse(result.stoppedOldFirst);
    }),
  );

  it.effect("removes an unhealthy new container and never touches the old one", () =>
    Effect.gen(function* () {
      const shell = fakeShell([
        PROXY,
        RUNNING_OLD,
        ["while :; do", { exitCode: 1 }],
        ["docker logs", { stdout: "Error: DATABASE_URL is not set\n" }],
      ]);
      const loaded = yield* webConfig();
      const error = yield* Effect.flip(
        swap(loaded, loaded.config.targets[0]!, "web:new").pipe(
          Effect.provide(shell.layer),
          withEnv({}),
        ),
      );
      assert.strictEqual(error.code, "HEALTH_CHECK_FAILED");
      assert.include(error.message, "kept web:old running");
      assert.include(error.output ?? "", "DATABASE_URL is not set");
      const scripts = shell.scripts();
      assert.isAbove(
        lastIndexOf(scripts, "docker rm -f web-next"),
        indexOf(scripts, "while :; do"),
      );
      assert.strictEqual(indexOf(scripts, "docker stop web"), -1);
      assert.strictEqual(indexOf(scripts, "docker rename"), -1);
    }),
  );

  it.effect(
    "stops the old container first when it publishes ports, and restarts it on failure",
    () =>
      Effect.gen(function* () {
        const shell = fakeShell([PROXY, RUNNING_OLD, ["while :; do", { exitCode: 1 }]]);
        const loaded = yield* webConfig({ ports: ["2222:22"] });
        const error = yield* Effect.flip(
          swap(loaded, loaded.config.targets[0]!, "web:new").pipe(
            Effect.provide(shell.layer),
            withEnv({}),
          ),
        );
        assert.strictEqual(error.code, "HEALTH_CHECK_FAILED");
        const scripts = shell.scripts();
        assert.isBelow(indexOf(scripts, "docker stop web"), indexOf(scripts, "docker run"));
        assert.isAbove(
          indexOf(scripts, "docker start web"),
          lastIndexOf(scripts, "docker rm -f web-next"),
        );
      }),
  );

  it.effect("passes forwarded secrets on stdin only, and refuses to start without them", () =>
    Effect.gen(function* () {
      const loaded = yield* webConfig({ forwardEnv: ["API_KEY"] });
      const target = loaded.config.targets[0]!;

      const shell = fakeShell([PROXY]);
      yield* swap(loaded, target, "web:new").pipe(
        Effect.provide(shell.layer),
        withEnv({ API_KEY: "s3cret" }),
      );
      const run = shell.calls.find((call) => call.argv.join(" ").includes("docker run"));
      assert.strictEqual(run?.stdin, "API_KEY=s3cret\n");
      for (const call of shell.calls) assert.notInclude(call.argv.join(" "), "s3cret");

      const missing = fakeShell([PROXY]);
      const error = yield* Effect.flip(
        swap(loaded, target, "web:new").pipe(Effect.provide(missing.layer), withEnv({})),
      );
      assert.strictEqual(error.code, "ENV_MISSING");
      assert.lengthOf(missing.calls, 0);
    }),
  );

  it.effect("asks for `server init` when a routed target's host has no Traefik", () =>
    Effect.gen(function* () {
      const shell = fakeShell([]);
      const loaded = yield* webConfig();
      const error = yield* Effect.flip(
        swap(loaded, loaded.config.targets[0]!, "web:new").pipe(
          Effect.provide(shell.layer),
          withEnv({}),
        ),
      );
      assert.strictEqual(error.code, "SERVER_NOT_INITIALIZED");
      assert.include(error.message, "p0deploy server init deploy@example.com");
    }),
  );
});

describe("rollback", () => {
  it.effect("swaps back to the previous container's image", () =>
    Effect.gen(function* () {
      const shell = fakeShell([
        PROXY,
        ["for n in web-prev;", { stdout: "/web-prev|web:old|exited|2026-11-24T00:00:00Z\n" }],
        ["for n in web;", { stdout: "/web|web:new|running|2026-11-25T00:00:00Z\n" }],
      ]);
      const loaded = yield* webConfig();
      const result = yield* rollback(loaded, loaded.config.targets[0]!).pipe(
        Effect.provide(shell.layer),
        withEnv({}),
      );
      assert.strictEqual(result.image, "web:old");
      assert.strictEqual(result.previousImage, "web:new");
      assert.isAbove(indexOf(shell.scripts(), "docker run -d --name web-next"), -1);
      assert.include(shell.scripts().join("\n"), " web:old");
    }),
  );

  it.effect("fails clearly when there is nothing to roll back to", () =>
    Effect.gen(function* () {
      const shell = fakeShell([PROXY]);
      const loaded = yield* webConfig();
      const error = yield* Effect.flip(
        rollback(loaded, loaded.config.targets[0]!).pipe(Effect.provide(shell.layer), withEnv({})),
      );
      assert.strictEqual(error.code, "NOTHING_TO_ROLLBACK");
    }),
  );
});

describe("image transfer", () => {
  const buildHostConfig = (transfer: string) =>
    loadedConfig({
      app: "web",
      build: { host: "builder" },
      targets: [{ name: "prod", host: "deploy@example.com", transfer }],
    });

  it.effect("skips the copy when the target already has the image id", () =>
    Effect.gen(function* () {
      const shell = fakeShell([["image inspect --format '{{.Id}}'", { stdout: "sha256:aaa\n" }]]);
      const loaded = yield* buildHostConfig("auto");
      const [result] = yield* push(loaded, { tag: "v1" }).pipe(
        Effect.provide([shell.layer, NodeServices.layer]),
      );
      assert.strictEqual(result?.mode, "skipped");
      assert.include(shell.scripts().join("\n"), "docker tag sha256:aaa web:v1");
      assert.isFalse(shell.calls.some((call) => call.piped));
    }),
  );

  it.effect("relays build host → this machine → target when direct ssh is off", () =>
    Effect.gen(function* () {
      const shell = fakeShell([
        ["docker image inspect --format '{{.Id}}' web:v1", { stdout: "sha256:aaa\n" }],
        ["docker image inspect --format '{{.Id}}' sha256:aaa", { exitCode: 1 }],
        ["command -v zstd", { stdout: "zstd\n" }],
      ]);
      const loaded = yield* buildHostConfig("relay");
      const [result] = yield* push(loaded, { tag: "v1" }).pipe(
        Effect.provide([shell.layer, NodeServices.layer]),
      );
      assert.strictEqual(result?.mode, "relay");
      assert.strictEqual(result?.codec, "zstd");
      const piped = shell.calls.filter((call) => call.piped).map((call) => call.argv);
      assert.deepEqual(piped, [
        onHost(
          { kind: "ssh", address: "builder" },
          "(set -o pipefail) 2>/dev/null && set -o pipefail; docker save web:v1 | zstd -q -c -T0",
        ),
        onHost(
          { kind: "ssh", address: "deploy@example.com" },
          "(set -o pipefail) 2>/dev/null && set -o pipefail; zstd -q -d -c | docker load",
        ),
      ]);
    }),
  );

  it.effect("copies straight from the build host when it can reach the target", () =>
    Effect.gen(function* () {
      const shell = fakeShell([
        ["docker image inspect --format '{{.Id}}' web:v1", { stdout: "sha256:aaa\n" }],
        ["docker image inspect --format '{{.Id}}' sha256:aaa", { exitCode: 1 }],
      ]);
      const loaded = yield* buildHostConfig("auto");
      const [result] = yield* push(loaded, { tag: "v1" }).pipe(
        Effect.provide([shell.layer, NodeServices.layer]),
      );
      assert.strictEqual(result?.mode, "direct");
      assert.strictEqual(result?.codec, "gzip");
      const direct = shell.calls.find((call) => call.argv.join(" ").includes("docker save"));
      assert.strictEqual(direct?.argv[direct.argv.length - 2], "builder");
      assert.include(direct?.argv.at(-1) ?? "", "| ssh -o BatchMode=yes");
    }),
  );
});

describe("up", () => {
  it.effect("builds on the machine it runs on unless a build host is given", () =>
    Effect.gen(function* () {
      const loaded = yield* webConfig();
      const local = fakeShell([PROXY]);
      yield* up(loaded, { tag: "v1" }).pipe(Effect.provide(local.layer), withEnv({}));
      assert.strictEqual(local.calls[0]?.argv[0], "docker");
      assert.deepEqual(local.calls[0]?.argv.slice(0, 4), ["docker", "build", "-t", "web:v1"]);

      const remote = fakeShell([PROXY]);
      yield* up(loaded, { tag: "v1", buildHost: "builder" }).pipe(
        Effect.provide(remote.layer),
        withEnv({}),
      );
      const [tar, build] = remote.calls.filter((call) => call.piped);
      assert.strictEqual(tar?.argv[2], "tar");
      assert.strictEqual(build?.argv.at(-2), "builder");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("server init", () => {
  const init = (rules: ReadonlyArray<readonly [string, Partial<ExecResult>]>) => {
    const shell = fakeShell(rules);
    return serverInit({
      host: "deploy@example.com",
      mode: "public",
      email: "ops@example.com",
    }).pipe(
      Effect.provide(shell.layer),
      Effect.map((result) => ({ result, scripts: shell.scripts() })),
    );
  };

  it.effect("creates Traefik on a fresh host", () =>
    Effect.gen(function* () {
      const { result, scripts } = yield* init([
        ["image inspect --format '{{.Id}}' traefik:v3", { stdout: "sha256:t\n" }],
      ]);
      assert.strictEqual(result.action, "created");
      assert.include(scripts[0] ?? "", "docker network create p0deploy");
      assert.include(scripts.at(-1) ?? "", "docker run -d --name p0deploy-traefik");
    }),
  );

  it.effect("leaves a running Traefik alone when settings and image are unchanged", () =>
    Effect.gen(function* () {
      const first = yield* init([
        ["image inspect --format '{{.Id}}' traefik:v3", { stdout: "sha256:t\n" }],
      ]);
      const spec = /p0deploy\.spec=([0-9a-f]+)/u.exec(first.scripts.at(-1) ?? "")?.[1];
      const { result, scripts } = yield* init([
        ["image inspect --format '{{.Id}}' traefik:v3", { stdout: "sha256:t\n" }],
        ["p0deploy-traefik 2>/dev/null", { stdout: `public||${spec}|sha256:t|running\n` }],
      ]);
      assert.strictEqual(result.action, "unchanged");
      assert.strictEqual(indexOf(scripts, "docker run"), -1);
    }),
  );

  it.effect("needs an email for Let's Encrypt in public mode", () =>
    Effect.gen(function* () {
      const shell = fakeShell([]);
      const error = yield* Effect.flip(
        serverInit({ host: "h", mode: "public" }).pipe(Effect.provide(shell.layer)),
      );
      assert.strictEqual(error.code, "CONFIG_INVALID");
      assert.lengthOf(shell.calls, 0);
    }),
  );
});
