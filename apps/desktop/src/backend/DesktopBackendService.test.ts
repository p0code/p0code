import { assert, describe, it } from "@effect/vitest";
import {
  DESKTOP_READINESS_CHALLENGE_PARAM,
  DESKTOP_READINESS_PROOF_PATH,
  desktopReadinessProof,
} from "@t3tools/shared/desktopReadinessProof";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopBackendService from "./DesktopBackendService.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

function makeProcessHandle(options: {
  readonly pid?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly running?: boolean;
  readonly onUnref?: () => void;
}): ChildProcessSpawner.ChildProcessHandle {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(options.pid ?? 4242),
    stdout: options.stdout ? Stream.make(encoder.encode(options.stdout)) : Stream.empty,
    stderr: options.stderr ? Stream.make(encoder.encode(options.stderr)) : Stream.empty,
    all: Stream.empty,
    exitCode: options.running
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(options.running ?? false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.sync(() => {
      options.onUnref?.();
      return Effect.void;
    }),
  });
}

describe("DesktopBackendService helpers", () => {
  it("runs p0d for every install that did not explicitly pick another backend", () => {
    assert.equal(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode, "local-service");
    for (const backendMode of ["embedded", "local-service", "remote"] as const) {
      assert.equal(
        DesktopBackendService.resolveEffectiveBackendMode({
          backendMode,
          backendModeConfiguredByUser: false,
        }),
        "local-service",
      );
    }
  });

  it.effect("adopts a local service that answers for this home", () =>
    Effect.gen(function* () {
      const modes: string[] = [];
      const driver = {
        kind: "legacy-node",
        binaryPath: "/app/server.mjs",
        desktopBootstrapSecret: "secret",
        unavailableReason: null,
        exited: Effect.never,
        status: Effect.succeed({
          running: true,
          installed: true,
          pid: 123,
          version: "1.0.0",
          url: new URL("http://127.0.0.1:3773"),
          binaryPath: "/app/server.mjs",
          managedByService: true,
          driverKind: "legacy-node" as const,
        }),
        ensureRunning: Effect.die("not used"),
        start: Effect.die("not used"),
        stop: Effect.die("not used"),
        restart: Effect.die("not used"),
      } satisfies DesktopBackendService.BackendServiceDriver;

      const reattached = yield* DesktopBackendService.adoptRunningLocalService({
        driver,
        settings: { backendMode: "embedded" },
        setMode: (mode) =>
          Effect.sync(() => {
            modes.push(mode);
            return true;
          }),
      });

      assert.isTrue(reattached);
      assert.deepEqual(modes, ["local-service"]);
    }),
  );

  it.effect("leaves the backend alone when no local service is ready", () =>
    Effect.gen(function* () {
      let changed = false;
      const driver = {
        kind: "legacy-node",
        binaryPath: "/app/server.mjs",
        desktopBootstrapSecret: "secret",
        unavailableReason: null,
        exited: Effect.never,
        status: Effect.succeed({
          running: false,
          installed: false,
          pid: null,
          version: null,
          url: null,
          binaryPath: "/app/server.mjs",
          managedByService: true,
          driverKind: "legacy-node" as const,
        }),
        ensureRunning: Effect.die("not used"),
        start: Effect.die("not used"),
        stop: Effect.die("not used"),
        restart: Effect.die("not used"),
      } satisfies DesktopBackendService.BackendServiceDriver;

      const reattached = yield* DesktopBackendService.adoptRunningLocalService({
        driver,
        settings: { backendMode: "embedded" },
        setMode: () =>
          Effect.sync(() => {
            changed = true;
            return true;
          }),
      });

      assert.isFalse(reattached);
      assert.isFalse(changed);
    }),
  );

  it("never overrides an explicit backend mode", () => {
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode({
        backendMode: "remote",
        backendModeConfiguredByUser: true,
      }),
      "remote",
    );
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode({
        backendMode: "embedded",
        backendModeConfiguredByUser: true,
      }),
      "embedded",
    );
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode({
        backendMode: "local-service",
        backendModeConfiguredByUser: true,
      }),
      "local-service",
    );
  });

  it("looks for the bundled p0d first, then the override, ~/.p0code/bin, the dev build and PATH", () => {
    const posixPath = { join: (...parts: string[]) => parts.join("/") };
    const candidates = DesktopBackendService.p0dBinaryCandidates({
      path: posixPath,
      platform: "darwin",
      arch: "arm64",
      isPackaged: false,
      resourcesPath: "/App/Contents/Resources",
      rootDir: "/repo",
      homeDirectory: "/Users/test",
      configuredBinaryPath: "/custom/bin/p0d",
      pathEnv: "/opt/homebrew/bin::/usr/local/bin",
    });

    assert.deepEqual(candidates, [
      "/App/Contents/Resources/p0d/p0d",
      "/custom/bin/p0d",
      "/Users/test/.p0code/bin/p0d",
      "/repo/apps/p0d/dist/darwin-arm64/p0d",
      "/opt/homebrew/bin/p0d",
      "/usr/local/bin/p0d",
    ]);
  });

  it("skips the repo's dev build when packaged", () => {
    const posixPath = { join: (...parts: string[]) => parts.join("/") };
    const candidates = DesktopBackendService.p0dBinaryCandidates({
      path: posixPath,
      platform: "linux",
      arch: "x64",
      isPackaged: true,
      resourcesPath: "/opt/p0code/resources",
      rootDir: "/repo",
      homeDirectory: "/home/test",
      configuredBinaryPath: null,
      pathEnv: undefined,
    });

    assert.deepEqual(candidates, ["/opt/p0code/resources/p0d/p0d", "/home/test/.p0code/bin/p0d"]);
  });

  it("uses p0d.exe and the Go target names on Windows", () => {
    const winPath = { join: (...parts: string[]) => parts.join("\\") };
    const candidates = DesktopBackendService.p0dBinaryCandidates({
      path: winPath,
      platform: "win32",
      arch: "x64",
      isPackaged: false,
      resourcesPath: "C:\\App\\resources",
      rootDir: "C:\\repo",
      homeDirectory: "C:\\Users\\test",
      configuredBinaryPath: null,
      pathEnv: "C:\\tools;C:\\bin",
    });

    assert.deepEqual(candidates, [
      "C:\\App\\resources\\p0d\\p0d.exe",
      "C:\\Users\\test\\.p0code\\bin\\p0d.exe",
      "C:\\repo\\apps\\p0d\\dist\\windows-amd64\\p0d.exe",
      "C:\\tools\\p0d.exe",
      "C:\\bin\\p0d.exe",
    ]);
  });

  it("starts p0d with the desktop secret file and a sidecar command that p0d can split", () => {
    const legacyServerCommand = DesktopBackendService.p0dLegacyServerCommand({
      executablePath: "/Applications/p0code.app/Contents/MacOS/p0code",
      isPackaged: true,
      compileCachePath: "/app/compile cache.cjs",
      entryPath: 'C:\\odd "dir"\\bin.mjs',
    });
    assert.equal(
      legacyServerCommand,
      '"/Applications/p0code.app/Contents/MacOS/p0code" "--title=p0code-backend" "--require" "/app/compile cache.cjs" "C:\\\\odd \\"dir\\"\\\\bin.mjs" "--mode" "web" "--no-browser"',
    );
    const secret = "ab".repeat(32);
    const args = DesktopBackendService.p0dServeArgs({
      home: "/home/test/.p0code/userdata",
      host: "127.0.0.1",
      port: 0,
      readyFilePath: "/home/test/.p0code/userdata/p0d-ready.json",
      desktopSecretFilePath: "/home/test/.p0code/userdata/secrets/desktop-bootstrap-secret",
      legacyServerCommand,
    });
    assert.deepEqual(args, [
      "serve",
      "--home",
      "/home/test/.p0code/userdata",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--ready-file",
      "/home/test/.p0code/userdata/p0d-ready.json",
      "--desktop-bootstrap-secret-file",
      "/home/test/.p0code/userdata/secrets/desktop-bootstrap-secret",
      "--legacy-server",
      legacyServerCommand,
    ]);
    assert.notInclude(args.join(" "), secret);
  });

  it("parses ready-file JSON and p0d service status in JSON or text formats", () => {
    const ready = DesktopBackendService.parseReadyFile(
      JSON.stringify({ pid: 9012, port: 3773, url: "http://127.0.0.1:3773/" }),
    );
    assert.deepEqual(ready, {
      pid: 9012,
      port: 3773,
      url: "http://127.0.0.1:3773",
      version: null,
    });

    const jsonStatus = DesktopBackendService.parseP0dServiceStatus(
      JSON.stringify({
        running: true,
        installed: true,
        pid: 4321,
        url: "http://127.0.0.1:3773",
        version: "0.2.0",
      }),
    );
    assert.equal(jsonStatus.running, true);
    assert.equal(jsonStatus.installed, true);
    assert.equal(jsonStatus.pid, 4321);
    assert.equal(jsonStatus.url, "http://127.0.0.1:3773");
    assert.equal(jsonStatus.version, "0.2.0");

    const textStatus = DesktopBackendService.parseP0dServiceStatus(
      "status: running\npid: 777\nurl: http://127.0.0.1:4111\n",
    );
    assert.equal(textStatus.running, true);
    assert.equal(textStatus.installed, true);
    assert.equal(textStatus.pid, 777);
    assert.equal(textStatus.url, "http://127.0.0.1:4111");

    const stoppedStatus = DesktopBackendService.parseP0dServiceStatus("service not installed");
    assert.equal(stoppedStatus.running, false);
    assert.equal(stoppedStatus.installed, false);

    assert.equal(DesktopBackendService.parseP0dVersion("p0d 0.3.1 (abc123)\n"), "0.3.1 (abc123)");
  });
});

describe("makeP0dServiceDriver", () => {
  it.effect("attaches to an already-running p0d without invoking install or start", () =>
    Effect.gen(function* () {
      const invokedCommands: string[] = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") {
          return Effect.die("expected StandardCommand");
        }
        const key = command.args.join(" ");
        invokedCommands.push(key);
        if (key === "version") {
          return Effect.succeed(makeProcessHandle({ stdout: "p0d 0.1.0\n" }));
        }
        if (key === "service status") {
          return Effect.succeed(
            makeProcessHandle({
              stdout: JSON.stringify({
                running: true,
                installed: true,
                pid: 8080,
                url: "http://127.0.0.1:3773",
              }),
            }),
          );
        }
        return Effect.die(`unexpected command: ${key}`);
      });

      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("ok", { status: request.url.endsWith("/healthz") ? 200 : 404 }),
          ),
        ),
      );

      const fileSystem = FileSystem.makeNoop({
        readFileString: () =>
          Effect.succeed(JSON.stringify({ pid: 8080, port: 3773, url: "http://127.0.0.1:3773" })),
      });

      const driver = DesktopBackendService.makeP0dServiceDriver({
        binaryPath: "/usr/local/bin/p0d",
        stateDir: "/tmp/p0code/userdata",
        readyFilePath: "/tmp/p0code/userdata/p0d-ready.json",
        legacyServerCommand: null,
        desktopSecretFilePath: "/tmp/p0code/userdata/secrets/desktop-bootstrap-secret",
        desktopBootstrapSecret: "ab".repeat(32),
        host: "127.0.0.1",
        defaultPort: 3773,
        fileSystem,
        spawner,
        httpClient,
        waitTimeout: Duration.seconds(2),
        pollInterval: Duration.millis(10),
      });

      const info = yield* driver.ensureRunning;
      assert.equal(info.running, true);
      assert.equal(info.pid, 8080);
      assert.equal(info.version, "0.1.0");
      assert.equal(info.url?.href, "http://127.0.0.1:3773/");
      assert.notInclude(invokedCommands, "service start");
      assert.isFalse(invokedCommands.some((cmd) => cmd.startsWith("service install")));
    }),
  );

  it.effect("installs and starts p0d service when stopped, then waits for /healthz", () =>
    Effect.gen(function* () {
      const invokedCommands: string[] = [];
      const runningRef = yield* Ref.make(false);
      const installedRef = yield* Ref.make(false);

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("expected StandardCommand");
          }
          const key = command.args.join(" ");
          invokedCommands.push(key);
          if (key === "version") {
            return makeProcessHandle({ stdout: "p0d 0.2.0\n" });
          }
          if (key === "service status") {
            const running = yield* Ref.get(runningRef);
            const installed = yield* Ref.get(installedRef);
            return makeProcessHandle({
              stdout: JSON.stringify({
                running,
                installed,
                pid: running ? 9999 : null,
                url: running ? "http://127.0.0.1:3773" : null,
              }),
            });
          }
          if (key.startsWith("service install")) {
            yield* Ref.set(installedRef, true);
            return makeProcessHandle({ exitCode: 0 });
          }
          if (key === "service start") {
            yield* Ref.set(runningRef, true);
            return makeProcessHandle({ exitCode: 0 });
          }
          if (key === "service stop") {
            yield* Ref.set(runningRef, false);
            return makeProcessHandle({ exitCode: 0 });
          }
          return yield* Effect.die(`unexpected command: ${key}`);
        }),
      );

      const httpClient = HttpClient.make((request) =>
        Ref.get(runningRef).pipe(
          Effect.map((running) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(running ? "ok" : "down", { status: running ? 200 : 503 }),
            ),
          ),
        ),
      );

      const fileSystem = FileSystem.makeNoop({});

      const driver = DesktopBackendService.makeP0dServiceDriver({
        binaryPath: "/usr/local/bin/p0d",
        stateDir: "/tmp/p0code/userdata",
        readyFilePath: "/tmp/p0code/userdata/p0d-ready.json",
        legacyServerCommand: "/electron /server/bin.mjs",
        desktopSecretFilePath: "/tmp/p0code/userdata/secrets/desktop-bootstrap-secret",
        desktopBootstrapSecret: "ab".repeat(32),
        host: "127.0.0.1",
        defaultPort: 3773,
        fileSystem,
        spawner,
        httpClient,
        waitTimeout: Duration.seconds(2),
        pollInterval: Duration.millis(10),
      });

      const info = yield* driver.ensureRunning;
      assert.equal(info.running, true);
      assert.equal(info.installed, true);
      assert.equal(info.pid, 9999);
      assert.equal(info.version, "0.2.0");
      assert.isTrue(
        invokedCommands.some(
          (cmd) =>
            cmd.includes("service install") &&
            cmd.includes(
              "--desktop-bootstrap-secret-file /tmp/p0code/userdata/secrets/desktop-bootstrap-secret",
            ) &&
            cmd.includes("--legacy-server /electron /server/bin.mjs"),
        ),
      );
      assert.include(invokedCommands, "service start");

      yield* driver.stop;
      assert.include(invokedCommands, "service stop");
      const afterStop = yield* driver.status;
      assert.equal(afterStop.running, false);
    }),
  );
});

const P0D_HOME = "/tmp/p0code/userdata";
const P0D_READY_FILE = `${P0D_HOME}/p0d-ready.json`;
const P0D_SECRET = "ab".repeat(32);

/** A loopback where p0d answers /healthz on the port it wrote to its ready file. */
function makeP0dWorld() {
  const files = new Map<string, string>();
  const healthyPorts = new Set<number>();
  const fileSystem = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    makeDirectory: () => Effect.void,
    stat: () => Effect.fail(new Error("missing") as never),
    sink: () => Sink.drain,
    readFileString: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Effect.fail(new Error("missing") as never)
        : Effect.succeed(content);
    },
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  });
  const httpClient = HttpClient.make((request) => {
    const url = new URL(request.url);
    return healthyPorts.has(Number(url.port)) && url.pathname === "/healthz"
      ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok\n")))
      : Effect.fail(new Error("connection refused") as never);
  });
  const listen = (port: number, pid: number) => {
    files.set(P0D_READY_FILE, JSON.stringify({ pid, port, url: `http://127.0.0.1:${port}` }));
    healthyPorts.add(port);
  };
  return { files, fileSystem, httpClient, healthyPorts, listen };
}

const p0dChildDriverInput = {
  binaryPath: "/app/resources/p0d/p0d",
  home: P0D_HOME,
  readyFilePath: P0D_READY_FILE,
  desktopSecretFilePath: `${P0D_HOME}/secrets/desktop-bootstrap-secret`,
  desktopBootstrapSecret: P0D_SECRET,
  legacyServerCommand: '"/electron" "/app/apps/server/dist/bin.mjs" "--mode" "web"',
  host: "127.0.0.1",
  port: 0,
  cwd: "/app",
  env: Effect.succeed({ ELECTRON_RUN_AS_NODE: "1", T3CODE_CLI_PATH: "/home/test/.local/bin/p0" }),
  logFilePath: `${P0D_HOME}/logs/p0d.log`,
  path: {
    basename: (value: string) => value.split("/").at(-1) ?? "",
    dirname: (value: string) => value.split("/").slice(0, -1).join("/"),
  },
  waitTimeout: Duration.seconds(2),
  pollInterval: Duration.millis(10),
};

describe("makeP0dChildDriver", () => {
  it.effect("waits for an attached process to exit before restart can spawn", () =>
    Effect.gen(function* () {
      const world = makeP0dWorld();
      world.listen(41_000, 3131);
      const checked = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<boolean>();
      const driver = DesktopBackendService.makeP0dChildDriver({
        ...p0dChildDriverInput,
        fileSystem: world.fileSystem,
        httpClient: world.httpClient,
        child: yield* DesktopBackendService.makeP0dChildState(yield* Effect.scope),
        killProcess: () => Effect.void,
        processAlive: () =>
          Deferred.succeed(checked, undefined).pipe(Effect.andThen(Deferred.await(exited))),
        spawner: ChildProcessSpawner.make(() => Effect.die("must not spawn before exit")),
      });
      const stopped = yield* driver.stop.pipe(Effect.forkChild);
      assert.isTrue(
        yield* Effect.race(
          Fiber.join(stopped).pipe(Effect.as(false)),
          Deferred.await(checked).pipe(Effect.as(true)),
        ),
      );
      yield* Deferred.succeed(exited, false);
      yield* Fiber.join(stopped);
    }).pipe(Effect.scoped),
  );

  it.effect("attaches to a p0d already serving this home without starting another", () =>
    Effect.gen(function* () {
      const world = makeP0dWorld();
      world.listen(41_000, 3131);
      const driver = DesktopBackendService.makeP0dChildDriver({
        ...p0dChildDriverInput,
        fileSystem: world.fileSystem,
        spawner: ChildProcessSpawner.make(() => Effect.die("must attach, not spawn")),
        httpClient: world.httpClient,
        child: yield* DesktopBackendService.makeP0dChildState(yield* Effect.scope),
      });

      const info = yield* driver.ensureRunning;
      assert.equal(info.url?.href, "http://127.0.0.1:41000/");
      assert.equal(info.pid, 3131);
      assert.equal(driver.desktopBootstrapSecret, P0D_SECRET);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts p0d without handing the secret to it or its sidecar, then reports its exit",
    () =>
      Effect.gen(function* () {
        const world = makeP0dWorld();
        world.files.set(P0D_READY_FILE, JSON.stringify({ pid: 1, port: 40_999 }));
        const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const launches: Array<{
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly env: Record<string, unknown>;
          readonly extendEnv: boolean | undefined;
        }> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") {
              return yield* Effect.die("expected StandardCommand");
            }
            launches.push({
              command: command.command,
              args: command.args.map(String),
              env: (command.options.env ?? {}) as Record<string, unknown>,
              extendEnv: command.options.extendEnv,
            });
            world.listen(41_001, 5150);
            return ChildProcessSpawner.makeHandle({
              ...makeProcessHandle({ pid: 5150, running: true }),
              exitCode: Deferred.await(exitCode),
            });
          }),
        );
        const driver = DesktopBackendService.makeP0dChildDriver({
          ...p0dChildDriverInput,
          fileSystem: world.fileSystem,
          spawner,
          httpClient: world.httpClient,
          child: yield* DesktopBackendService.makeP0dChildState(yield* Effect.scope),
        });

        const info = yield* driver.ensureRunning;
        assert.equal(info.url?.href, "http://127.0.0.1:41001/");
        assert.equal(launches.length, 1);
        const launch = launches[0]!;
        assert.equal(launch.command, p0dChildDriverInput.binaryPath);
        assert.deepEqual(launch.args, [...DesktopBackendService.p0dServeArgs(p0dChildDriverInput)]);
        assert.equal(launch.extendEnv, true);
        assert.notInclude(JSON.stringify(launch), P0D_SECRET);
        assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");

        const exited = yield* Effect.forkChild(driver.exited);
        world.healthyPorts.clear();
        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(2));
        assert.include(yield* Fiber.join(exited), "p0d exited with code 2.");
      }).pipe(Effect.scoped),
  );

  it.effect("fails with p0d's own output when it exits before it is ready", () =>
    Effect.gen(function* () {
      const world = makeP0dWorld();
      const encoder = new TextEncoder();
      const driver = DesktopBackendService.makeP0dChildDriver({
        ...p0dChildDriverInput,
        fileSystem: world.fileSystem,
        spawner: ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeProcessHandle({ exitCode: 1 }),
              all: Stream.make(encoder.encode("p0d: desktop bootstrap secret: file is empty\n")),
            }),
          ),
        ),
        httpClient: world.httpClient,
        child: yield* DesktopBackendService.makeP0dChildState(yield* Effect.scope),
      });

      const error = yield* driver.ensureRunning.pipe(Effect.flip);
      assert.include(error.message, "p0d exited with code 1.");
      assert.include(error.message, "desktop bootstrap secret: file is empty");
    }).pipe(Effect.scoped),
  );

  it.effect("explains why a home p0d's sidecar cannot share is refused", () =>
    Effect.gen(function* () {
      const world = makeP0dWorld();
      const driver = DesktopBackendService.makeP0dChildDriver({
        ...p0dChildDriverInput,
        home: "/home/test/.p0code/dev",
        fileSystem: world.fileSystem,
        spawner: ChildProcessSpawner.make(() => Effect.die("must not spawn")),
        httpClient: world.httpClient,
        child: yield* DesktopBackendService.makeP0dChildState(yield* Effect.scope),
      });

      const error = yield* driver.ensureRunning.pipe(Effect.flip);
      assert.include(error.message, "/home/test/.p0code/dev");
      assert.include(error.message, "legacy Node backend");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unavailable p0d with the same reason everywhere", () =>
    Effect.gen(function* () {
      const driver = DesktopBackendService.makeUnavailableP0dDriver("p0d is missing.");
      assert.equal(driver.unavailableReason, "p0d is missing.");
      assert.equal((yield* driver.ensureRunning.pipe(Effect.flip)).message, "p0d is missing.");
      assert.equal((yield* driver.status).running, false);
    }),
  );
});

describe("readOrCreateDesktopSecretFile", () => {
  it.effect("writes a private secret once and keeps it across launches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "p0d-secret-" });
      const secretPath = path.join(dir, "userdata", "secrets", "desktop-bootstrap-secret");

      const first = yield* DesktopBackendService.readOrCreateDesktopSecretFile({
        fileSystem,
        path,
        random,
        secretPath,
      });
      assert.match(first, /^[0-9a-f]{64}$/);
      assert.equal((yield* fileSystem.readFileString(secretPath)).trim(), first);
      const posix = (yield* HostProcess.Platform) !== "win32";
      if (posix) {
        assert.equal((yield* fileSystem.stat(secretPath)).mode & 0o777, 0o600);
        // p0d refuses a secret others can read, so a widened mode is repaired, not rotated.
        yield* fileSystem.chmod(secretPath, 0o644);
      }
      const second = yield* DesktopBackendService.readOrCreateDesktopSecretFile({
        fileSystem,
        path,
        random,
        secretPath,
      });
      assert.equal(second, first);
      if (posix) {
        assert.equal((yield* fileSystem.stat(secretPath)).mode & 0o777, 0o600);
      }
      assert.isFalse(yield* fileSystem.exists(`${secretPath}.tmp`));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

const SERVICE_SECRETS: DesktopBackendService.LocalServiceSecrets = {
  bootstrapSecret: "b0".repeat(32),
  readinessSecret: "c0".repeat(32),
};

/** Loopback ports: one held by another app (stock T3 Code), others by servers this test spawns. */
function makeLoopbackWorld(mac: Mac.Mac["Service"]) {
  const servers = new Map<number, { readonly readinessSecret: string | null }>([
    [3773, { readinessSecret: null }],
  ]);
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const server = servers.get(Number(url.port));
      if (server === undefined) {
        return yield* Effect.fail(new Error("connection refused") as never);
      }
      if (url.pathname !== DESKTOP_READINESS_PROOF_PATH) {
        // The foreign server is healthy too, which is how it used to get adopted.
        return HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }));
      }
      if (server.readinessSecret === null) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
      }
      const proof = yield* desktopReadinessProof(
        server.readinessSecret,
        Option.getOrElse(
          UrlParams.getFirst(request.urlParams, DESKTOP_READINESS_CHALLENGE_PARAM),
          () => "",
        ),
      ).pipe(Effect.provideService(Mac.Mac, mac));
      return HttpClientResponse.fromWeb(request, new Response(proof, { status: 200 }));
    }),
  );
  return { servers, httpClient };
}

function makeMemoryFileSystem() {
  const files = new Map<string, string>();
  const fileSystem = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    makeDirectory: () => Effect.void,
    writeFileString: (path, content) =>
      Effect.sync(() => {
        files.set(path, content);
      }),
    readFileString: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Effect.fail(new Error("missing") as never)
        : Effect.succeed(content);
    },
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  });
  return { files, fileSystem };
}

const legacyDriverInput = {
  executablePath: "/electron",
  entryPath: "/app/apps/server/dist/bin.mjs",
  cwd: "/app",
  stateDir: "/tmp/p0code/userdata",
  baseDir: "/tmp/p0code",
  readyFilePath: "/tmp/p0code/userdata/p0d-legacy-service.json",
  host: "127.0.0.1",
  preferredPort: 3773,
  version: "0.1.11",
  secrets: SERVICE_SECRETS,
  pickPort: (preferred: number) => Effect.succeed(preferred === 3773 ? 51234 : preferred),
  waitTimeout: Duration.seconds(2),
  pollInterval: Duration.millis(10),
};

describe("makeLegacyNodeServiceDriver", () => {
  it.effect("does not adopt another app's server on the default port", () =>
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const random = yield* SecureRandom.SecureRandom;
      const world = makeLoopbackWorld(mac);
      const { fileSystem } = makeMemoryFileSystem();
      const driver = DesktopBackendService.makeLegacyNodeServiceDriver({
        ...legacyDriverInput,
        fileSystem,
        spawner: ChildProcessSpawner.make(() => Effect.die("status must not spawn")),
        httpClient: world.httpClient,
        mac,
        random,
      });

      const status = yield* driver.status;
      assert.equal(status.running, false);
      assert.equal(status.url, null);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("starts its own signed-in service beside a foreign server, then reattaches", () =>
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const random = yield* SecureRandom.SecureRandom;
      const world = makeLoopbackWorld(mac);
      const { fileSystem } = makeMemoryFileSystem();
      let unreffed = false;
      const spawned: Array<{
        readonly args: ReadonlyArray<string>;
        readonly bootstrap: Record<string, unknown>;
        readonly env: Record<string, string | undefined>;
      }> = [];
      const killedPids: number[] = [];

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("expected StandardCommand");
          }
          assert.equal(command.options.detached, true);
          const stdin = command.options.stdin;
          const bootstrapText = Stream.isStream(stdin)
            ? yield* stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie)
            : "";
          const bootstrap = JSON.parse(bootstrapText) as Record<string, unknown>;
          const args = command.args.map(String);
          spawned.push({
            args,
            bootstrap,
            env: (command.options.env ?? {}) as Record<string, string | undefined>,
          });
          const port = Number(args[args.indexOf("--port") + 1]);
          world.servers.set(port, { readinessSecret: String(bootstrap.desktopReadinessSecret) });
          return makeProcessHandle({
            pid: 5511,
            running: true,
            onUnref: () => {
              unreffed = true;
            },
          });
        }),
      );

      const makeDriver = () =>
        DesktopBackendService.makeLegacyNodeServiceDriver({
          ...legacyDriverInput,
          fileSystem,
          spawner,
          httpClient: world.httpClient,
          mac,
          random,
          killProcess: (pid) =>
            Effect.sync(() => {
              killedPids.push(pid);
            }),
        });
      const driver = makeDriver();

      const started = yield* driver.ensureRunning;
      assert.equal(started.running, true);
      assert.equal(started.pid, 5511);
      assert.equal(started.url?.href, "http://127.0.0.1:51234/");
      assert.equal(driver.desktopBootstrapSecret, SERVICE_SECRETS.bootstrapSecret);
      assert.equal(unreffed, true);
      assert.equal(spawned.length, 1);
      const launch = spawned[0]!;
      assert.equal(launch.args[0], "--title=p0code-backend");
      assert.deepEqual(launch.args.slice(2, 5), ["--mode", "web", "--no-browser"]);
      assert.includeMembers([...launch.args], ["--bootstrap-fd", "0", "--port", "51234"]);
      assert.equal(launch.bootstrap.desktopBootstrapSecret, SERVICE_SECRETS.bootstrapSecret);
      assert.equal(launch.bootstrap.desktopReadinessSecret, SERVICE_SECRETS.readinessSecret);
      assert.equal(launch.env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "false");

      // A relaunched GUI finds the same service through the ready file and its proof.
      const reattached = yield* makeDriver().ensureRunning;
      assert.equal(reattached.url?.href, "http://127.0.0.1:51234/");
      assert.equal(spawned.length, 1);

      yield* driver.stop;
      assert.deepEqual(killedPids, [5511]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("fails fast and keeps nothing when the service exits during startup", () =>
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const random = yield* SecureRandom.SecureRandom;
      const world = makeLoopbackWorld(mac);
      const { files, fileSystem } = makeMemoryFileSystem();
      let unreffed = false;
      const driver = DesktopBackendService.makeLegacyNodeServiceDriver({
        ...legacyDriverInput,
        waitTimeout: Duration.minutes(5),
        fileSystem,
        spawner: ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcessHandle({
              exitCode: 78,
              onUnref: () => {
                unreffed = true;
              },
            }),
          ),
        ),
        httpClient: world.httpClient,
        mac,
        random,
      });

      const error = yield* driver.ensureRunning.pipe(Effect.flip);
      assert.include(error.message, "exited with code 78");
      assert.equal(unreffed, false);
      assert.equal(files.has(legacyDriverInput.readyFilePath), false);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

// Sync IPC handlers run their effect with runSync, so the regression test must too.
// oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- asserts the effect completes synchronously
const runLikeSyncIpc = <A>(effect: Effect.Effect<A>) => Effect.runSyncExit(effect);

const layerService = (baseDir: string, settings: DesktopAppSettings.DesktopSettings) =>
  DesktopBackendService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: baseDir,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              DesktopConfig.layerTest({ T3CODE_HOME: baseDir }),
            ),
          ),
        ),
        DesktopAppSettings.layerTest(settings),
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        NodeHttpClient.layerUndici,
        // The host's PATH must not decide which p0d these tests find.
        Layer.succeed(HostProcess.Environment, { PATH: "" }),
      ),
    ),
  );

const FAILING_P0D = "#!/bin/sh\necho 'p0d: listen tcp: address already in use' >&2\nexit 1\n";

describe("DesktopBackendService.layer", () => {
  it.effect("answers the backend mode synchronously for sync IPC handlers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const service = yield* DesktopBackendService.DesktopBackendService.pipe(
        Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)),
      );
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("local-service"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says where it looked when no p0d binary exists, without falling back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const { result, status } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.prepareSelectedBackend;
        const status = yield* service.getStatus({
          embeddedReady: false,
          embeddedDesiredRunning: false,
          embeddedPid: null,
          embeddedUrl: null,
        });
        return { result, status };
      }).pipe(Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)));
      assert.equal(result.mode, "local-service");
      assert.include(result.failure ?? "", "couldn't find its p0d backend");
      assert.include(result.failure ?? "", "/missing/resources/p0d/p0d");
      assert.include(result.failure ?? "", `${baseDir}/.p0code/bin/p0d`);
      assert.equal(status.driverKind, "p0d");
      assert.equal(status.error, result.failure);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a p0d installed in ~/.p0code/bin", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const p0dPath = `${baseDir}/.p0code/bin/p0d`;
      yield* fileSystem.makeDirectory(`${baseDir}/.p0code/bin`, { recursive: true });
      yield* fileSystem.writeFileString(p0dPath, FAILING_P0D, { mode: 0o755 });
      const binary = yield* Effect.gen(function* () {
        return yield* (yield* DesktopBackendService.DesktopBackendService).findP0dBinary;
      }).pipe(Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)));
      assert.deepEqual(binary, Option.some(p0dPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an explicit legacy Node choice even when p0d resolves", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const p0dPath = `${baseDir}/custom-p0d`;
      yield* fileSystem.writeFileString(p0dPath, FAILING_P0D, { mode: 0o755 });
      const { service, result } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.prepareSelectedBackend;
        return { service, result };
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "embedded",
            backendModeConfiguredByUser: true,
            backendBinaryPath: p0dPath,
          }),
        ),
      );
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("embedded"));
      assert.deepEqual(result, { mode: "embedded", failure: null });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports p0d's own error and keeps p0d as the saved choice when it fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const p0dPath = `${baseDir}/custom-p0d`;
      yield* fileSystem.writeFileString(p0dPath, FAILING_P0D, { mode: 0o755 });
      const { result, settings, secretMode } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.prepareSelectedBackend;
        const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
        const secretMode = (yield* fileSystem.stat(
          `${baseDir}/userdata/secrets/desktop-bootstrap-secret`,
        )).mode;
        return { result, settings, secretMode };
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendBinaryPath: p0dPath,
          }),
        ),
      );
      assert.equal(result.mode, "local-service");
      assert.include(result.failure ?? "", "p0d exited with code 1.");
      assert.include(result.failure ?? "", "address already in use");
      assert.equal(secretMode & 0o777, 0o600);
      assert.equal(settings.backendMode, "local-service");
      assert.isFalse(settings.backendModeConfiguredByUser);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the legacy Node backend for this launch only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const { mode, settings } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        yield* service.useLegacyBackendForThisLaunch;
        const mode = yield* service.resolveEffectiveMode;
        const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
        return { mode, settings };
      }).pipe(Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)));
      assert.equal(mode, "embedded");
      assert.equal(settings.backendMode, "local-service");
      assert.isFalse(settings.backendModeConfiguredByUser);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to save p0d when it cannot start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const p0dPath = `${baseDir}/custom-p0d`;
      yield* fileSystem.writeFileString(p0dPath, FAILING_P0D, { mode: 0o755 });
      const { result, settings } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.updateConfig({ mode: "local-service" });
        const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
        return { result, settings };
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "embedded",
            backendModeConfiguredByUser: true,
            backendBinaryPath: p0dPath,
          }),
        ),
      );
      assert.isFalse(result.changed);
      assert.include(result.error ?? "", "p0d exited with code 1.");
      assert.equal(settings.backendMode, "embedded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses remote mode without rewriting the stored choice", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const { result, settings } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.updateConfig({ mode: "remote" });
        const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
        return { result, settings };
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "embedded",
            backendModeConfiguredByUser: true,
          }),
        ),
      );
      assert.isFalse(result.changed);
      assert.include(result.error ?? "", "experimental");
      assert.equal(settings.backendMode, "embedded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports remote mode as unsupported rather than reachable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const status = yield* Effect.gen(function* () {
        return yield* (yield* DesktopBackendService.DesktopBackendService).getStatus({
          embeddedReady: false,
          embeddedDesiredRunning: false,
          embeddedPid: null,
          embeddedUrl: null,
        });
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "remote",
            backendModeConfiguredByUser: true,
            backendRemoteUrl: "http://127.0.0.1:3773",
          }),
        ),
      );
      assert.equal(status.mode, "remote");
      assert.isFalse(status.running);
      assert.include(status.error ?? "", "experimental");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
