import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
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
  readonly onUnref?: () => void;
}): ChildProcessSpawner.ChildProcessHandle {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(options.pid ?? 4242),
    stdout: options.stdout ? Stream.make(encoder.encode(options.stdout)) : Stream.empty,
    stderr: options.stderr ? Stream.make(encoder.encode(options.stderr)) : Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
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
  it("defaults to local-service when p0d is packaged and user has not overridden mode", () => {
    const modePackaged = DesktopBackendService.resolveEffectiveBackendMode(
      {
        backendMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode,
        backendModeConfiguredByUser: false,
      },
      true,
    );
    const modeUnpackaged = DesktopBackendService.resolveEffectiveBackendMode(
      {
        backendMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode,
        backendModeConfiguredByUser: false,
      },
      false,
    );
    const modeExplicit = DesktopBackendService.resolveEffectiveBackendMode(
      {
        backendMode: "legacy-embedded",
        backendModeConfiguredByUser: true,
      },
      true,
    );

    assert.equal(modePackaged, "local-service");
    assert.equal(modeUnpackaged, "legacy-embedded");
    assert.equal(modeExplicit, "legacy-embedded");
  });

  it("orders p0d binary candidates with user override first, then packaged and dev paths", () => {
    const posixPath = { join: (...parts: string[]) => parts.join("/") };
    const candidates = DesktopBackendService.p0dBinaryCandidates({
      path: posixPath,
      platform: "darwin",
      arch: "arm64",
      isPackaged: false,
      resourcesPath: "/App/Contents/Resources",
      rootDir: "/repo",
      homeDirectory: "/Users/test",
      baseDir: "/Users/test/.p0code",
      appDataDirectory: "/Users/test/Library/Application Support",
      configuredBinaryPath: "/custom/bin/p0d",
    });

    assert.equal(candidates[0], "/custom/bin/p0d");
    assert.equal(candidates[1], "/App/Contents/Resources/p0d/p0d");
    assert.include(candidates, "/repo/apps/p0d/dist/darwin-arm64/p0d");
    assert.include(candidates, "/Users/test/.p0code/bin/p0d");
  });

  it("uses p0d.exe on Windows", () => {
    const winPath = { join: (...parts: string[]) => parts.join("\\") };
    const candidates = DesktopBackendService.p0dBinaryCandidates({
      path: winPath,
      platform: "win32",
      arch: "x64",
      isPackaged: false,
      resourcesPath: "C:\\App\\resources",
      rootDir: "C:\\repo",
      homeDirectory: "C:\\Users\\test",
      baseDir: "C:\\Users\\test\\.p0code",
      appDataDirectory: "C:\\Users\\test\\AppData\\Roaming",
      configuredBinaryPath: null,
    });

    assert.include(candidates, "C:\\App\\resources\\p0d\\p0d.exe");
    assert.include(candidates, "C:\\repo\\apps\\p0d\\dist\\windows-amd64\\p0d.exe");
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

describe("makeLegacyNodeServiceDriver", () => {
  it.effect("starts Node server detached and supports stop via PID file", () =>
    Effect.gen(function* () {
      const runningRef = yield* Ref.make(false);
      let unreffed = false;
      const killedPids: number[] = [];
      let readyFileContent: string | null = null;

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("expected StandardCommand");
          }
          assert.equal(command.options.detached, true);
          yield* Ref.set(runningRef, true);
          return makeProcessHandle({
            pid: 5511,
            onUnref: () => {
              unreffed = true;
            },
          });
        }),
      );

      const httpClient = HttpClient.make((request) =>
        Ref.get(runningRef).pipe(
          Effect.map((running) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: running ? 200 : 503 }),
            ),
          ),
        ),
      );

      const fileSystem = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        makeDirectory: () => Effect.void,
        writeFileString: (_path, content) =>
          Effect.sync(() => {
            readyFileContent = content;
          }),
        readFileString: () =>
          readyFileContent === null
            ? Effect.fail(new Error("missing") as never)
            : Effect.succeed(readyFileContent),
        remove: () =>
          Effect.sync(() => {
            readyFileContent = null;
          }),
      });

      const driver = DesktopBackendService.makeLegacyNodeServiceDriver({
        executablePath: "/electron",
        entryPath: "/app/apps/server/dist/bin.mjs",
        cwd: "/app",
        stateDir: "/tmp/p0code/userdata",
        baseDir: "/tmp/p0code",
        readyFilePath: "/tmp/p0code/userdata/p0d-legacy-service.json",
        host: "127.0.0.1",
        port: 3773,
        version: "0.1.11",
        fileSystem,
        spawner,
        httpClient,
        killProcess: (pid) =>
          Effect.sync(() => {
            killedPids.push(pid);
          }).pipe(Effect.andThen(Ref.set(runningRef, false))),
        waitTimeout: Duration.seconds(2),
        pollInterval: Duration.millis(10),
      });

      const started = yield* driver.ensureRunning;
      assert.equal(started.running, true);
      assert.equal(started.driverKind, "legacy-node");
      assert.equal(started.pid, 5511);
      assert.equal(unreffed, true);

      yield* driver.stop;
      assert.deepEqual(killedPids, [5511]);
    }),
  );
});

// Sync IPC handlers run their effect with runSync, so the regression test must too.
// oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- asserts the effect completes synchronously
const runLikeSyncIpc = <A>(effect: Effect.Effect<A>) => Effect.runSyncExit(effect);

describe("DesktopBackendService.layer", () => {
  it.effect("answers the backend mode synchronously for sync IPC handlers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const service = yield* DesktopBackendService.DesktopBackendService.pipe(
        Effect.provide(
          DesktopBackendService.layer.pipe(
            Layer.provide(
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
                DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
                NodeServices.layer,
                NodeHttpClient.layerUndici,
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(
        runLikeSyncIpc(service.resolveEffectiveMode),
        Exit.succeed("legacy-embedded"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
