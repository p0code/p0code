import { assert, describe, it } from "@effect/vitest";
import {
  DESKTOP_READINESS_CHALLENGE_PARAM,
  DESKTOP_READINESS_PROOF_PATH,
  desktopReadinessProof,
} from "@t3tools/shared/desktopReadinessProof";
import * as NetService from "@t3tools/shared/Net";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
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
  it("defaults to local-service whenever a p0d binary resolves", () => {
    const autoSettings = {
      backendMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode,
      backendModeConfiguredByUser: false,
    };

    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode(autoSettings, true),
      "local-service",
    );
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode(autoSettings, false),
      "embedded",
    );
  });

  it.effect("adopts a local service that answers for this home", () =>
    Effect.gen(function* () {
      const modes: string[] = [];
      const driver = {
        kind: "legacy-node",
        binaryPath: "/app/server.mjs",
        desktopBootstrapSecret: "secret",
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
      DesktopBackendService.resolveEffectiveBackendMode(
        { backendMode: "remote", backendModeConfiguredByUser: true },
        true,
      ),
      "remote",
    );
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode(
        { backendMode: "remote", backendModeConfiguredByUser: true },
        false,
      ),
      "remote",
    );
    assert.equal(
      DesktopBackendService.resolveEffectiveBackendMode(
        { backendMode: "embedded", backendModeConfiguredByUser: true },
        true,
      ),
      "embedded",
    );
  });

  it("only considers the explicit override and the packaged p0d", () => {
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
    assert.deepEqual(candidates, ["/custom/bin/p0d", "/App/Contents/Resources/p0d/p0d"]);
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
    assert.equal(candidates.length, 1);
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
      ),
    ),
  );

describe("DesktopBackendService.layer", () => {
  it.effect("answers the backend mode synchronously for sync IPC handlers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const service = yield* DesktopBackendService.DesktopBackendService.pipe(
        Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)),
      );
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("embedded"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes an explicit p0d override before starting the backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(`${baseDir}/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${baseDir}/bin/p0d`, "#!/bin/sh\nexit 0\n");
      yield* fileSystem.chmod(`${baseDir}/bin/p0d`, 0o700);
      const service = yield* DesktopBackendService.DesktopBackendService.pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "embedded",
            backendModeConfiguredByUser: false,
            backendBinaryPath: `${baseDir}/bin/p0d`,
          }),
        ),
      );
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("local-service"));
      yield* fileSystem.remove(`${baseDir}/bin/p0d`);
      assert.equal((yield* service.prepareSelectedBackend).mode, "embedded");
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("embedded"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores an unrelated home/bin p0d", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(`${baseDir}/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${baseDir}/bin/p0d`, "#!/bin/sh\nexit 0\n");
      const service = yield* DesktopBackendService.DesktopBackendService.pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "embedded",
            backendModeConfiguredByUser: false,
          }),
        ),
      );
      assert.deepEqual(runLikeSyncIpc(service.resolveEffectiveMode), Exit.succeed("embedded"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the in-app backend when the local service cannot start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const { result, settings } = yield* Effect.gen(function* () {
        const service = yield* DesktopBackendService.DesktopBackendService;
        const result = yield* service.prepareSelectedBackend;
        const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
        return { result, settings };
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "local-service",
            backendModeConfiguredByUser: true,
          }),
        ),
      );
      // No server bundle in this environment, so the service can never come up.
      assert.equal(result.mode, "embedded");
      assert.include(result.fallbackReason ?? "", "Legacy server bundle not found");
      assert.equal(settings.backendMode, "embedded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses remote mode, which has no credential to sign the desktop in", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const result = yield* Effect.gen(function* () {
        return yield* (yield* DesktopBackendService.DesktopBackendService).prepareSelectedBackend;
      }).pipe(
        Effect.provide(
          layerService(baseDir, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            backendMode: "remote",
            backendModeConfiguredByUser: true,
            backendRemoteUrl: "http://127.0.0.1:1",
          }),
        ),
      );
      assert.equal(result.mode, "embedded");
      assert.isNotNull(result.fallbackReason);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps embedded without touching any service", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      const result = yield* Effect.gen(function* () {
        return yield* (yield* DesktopBackendService.DesktopBackendService).prepareSelectedBackend;
      }).pipe(Effect.provide(layerService(baseDir, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS)));
      assert.deepEqual(result, { mode: "embedded", fallbackReason: null });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
