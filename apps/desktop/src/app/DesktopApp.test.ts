import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({
  installDesktopIpcHandlers: () => Effect.void,
}));
vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({ listen: Effect.void }));
vi.mock("./DesktopStartupRecovery.ts", () => ({ listen: Effect.void }));

import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopBackendService from "../backend/DesktopBackendService.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as LoopbackTunnel from "../preview/LoopbackTunnel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as AppleSpeech from "../speech/AppleSpeech.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";
import * as DesktopPrimaryPaste from "./DesktopPrimaryPaste.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

interface StubbedDesktop {
  readonly localEnvironmentEnabled: boolean;
  readonly environment: Partial<DesktopEnvironment.DesktopEnvironment["Service"]>;
  readonly fileSystem: Layer.Layer<FileSystem.FileSystem>;
  readonly record: (event: string) => Effect.Effect<void>;
  readonly windowStarted: Deferred.Deferred<void>;
  readonly registerLinuxUrlHandler: Effect.Effect<void>;
  readonly backends?: ReadonlyArray<{ readonly stop: () => Effect.Effect<void> }>;
  readonly flushRendererHistory?: Effect.Effect<void>;
  readonly tokenRequested?: Deferred.Deferred<void>;
  readonly activationStarted?: Deferred.Deferred<void>;
  readonly catalogRecovery?: DesktopConnectionCatalogStore.DesktopConnectionCatalogRecovery;
  readonly reattachedLocalEnvironment?: boolean;
  readonly messages?: Array<{
    readonly title?: string;
    readonly message: string;
    readonly detail?: string;
    readonly buttons?: ReadonlyArray<string>;
  }>;
  /** Buttons the user clicks in each message box, in order; the first button otherwise. */
  readonly messageResponses?: Array<number>;
  readonly backendService?: Partial<DesktopBackendService.DesktopBackendService["Service"]>;
}

const runStubbedDesktop = (stub: StubbedDesktop) =>
  Effect.gen(function* () {
    const quitting = yield* Ref.make(false);
    const runApp = DesktopApp.program
      .pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
          resolveUserDataPath: Effect.succeed("/isolated/userdata"),
          configure: stub.record("identity"),
        } as DesktopAppIdentity.DesktopAppIdentity["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          setPath: () => Effect.void,
          whenReady: stub.record("ready"),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          showErrorBox: () => Effect.die("unexpected fatal startup error"),
          showMessageBox: (options: {
            title?: string;
            message: string;
            detail?: string;
            buttons?: ReadonlyArray<string>;
          }) =>
            Effect.sync(() => {
              stub.messages?.push(options);
              return { response: stub.messageResponses?.shift() ?? 0, checkboxChecked: false };
            }),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          platform: "linux",
          isDevelopment: false,
          isPackaged: true,
          homeDirectory: "/isolated",
          baseDir: "/isolated",
          stateDir: "/isolated/userdata",
          configuredBackendPort: Option.some(3773),
          defaultDesktopSettings: { serverExposureMode: "local-only" },
          ...stub.environment,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: "basic",
        }),
        Effect.provideService(DesktopShellEnvironment.DesktopShellEnvironment, {
          installIntoProcess: Effect.succeed(true),
          awaitDiscovery: Effect.succeed(true),
          awaitUserShellDiscovery: Effect.succeed(true),
          discoveryFinished: Effect.succeed(true),
          updates: Stream.empty,
        }),
        Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
          load: Effect.void,
          get: Effect.succeed({
            localEnvironmentEnabled: stub.localEnvironmentEnabled,
            serverExposureMode: "local-only",
          }),
        } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
        Effect.provideService(DesktopLifecycle.DesktopLifecycle, {
          register: Effect.void,
          relaunch: () => Effect.void,
        }),
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
          selectedStorageBackend: Effect.succeedNone,
        } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]),
        Effect.provideService(PreviewPasskeys.PreviewPasskeys, {
          configure: Effect.void,
        } as PreviewPasskeys.PreviewPasskeys["Service"]),
        Effect.provideService(DesktopApplicationMenu.DesktopApplicationMenu, {
          configure: stub.record("menu"),
        }),
        Effect.provideService(DesktopUpdates.DesktopUpdates, {
          configure: Effect.void,
        } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
        Effect.provideService(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, {
          register: stub.registerLinuxUrlHandler,
        }),
      )
      .pipe(
        Effect.provideService(ElectronProtocol.ElectronProtocol, {
          registerDesktopProtocol: () => Effect.void,
        } as unknown as ElectronProtocol.ElectronProtocol["Service"]),
        Effect.provideService(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
          load: () => Effect.void,
        } as unknown as DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"]),
        Effect.provideService(DesktopSnapShot.DesktopSnapShot, {
          initialize: Effect.void,
        } as DesktopSnapShot.DesktopSnapShot["Service"]),
        Effect.provideService(DesktopState.DesktopState, {
          quitting,
        } as DesktopState.DesktopState["Service"]),
        Effect.provideService(DesktopWindow.DesktopWindow, {
          ensureMain: stub
            .record("window")
            .pipe(Effect.andThen(Deferred.succeed(stub.windowStarted, undefined))),
          createMainIfBackendReady: stub
            .record("window")
            .pipe(Effect.andThen(Deferred.succeed(stub.windowStarted, undefined))),
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Effect.provideService(DesktopBackendPool.DesktopBackendPool, {
          primary: Effect.succeed({
            start: stub.record("backend"),
            currentConfig: Effect.succeedSome({ preflightFailure: Option.none() }),
          }),
          list: Effect.succeed(stub.backends ?? []),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
        Effect.provideService(DesktopServerExposure.DesktopServerExposure, {
          configureFromSettings: () => Effect.succeed({ mode: "local-only" }),
          backendConfig: Effect.succeed({ httpBaseUrl: new URL("http://127.0.0.1:3773") }),
        } as unknown as DesktopServerExposure.DesktopServerExposure["Service"]),
        Effect.provideService(DesktopWslBackend.DesktopWslBackend, {
          reconcile: Effect.void,
        } as DesktopWslBackend.DesktopWslBackend["Service"]),
        Effect.provideService(DesktopAppActivation.DesktopAppActivation, {
          start: stub.activationStarted
            ? Deferred.succeed(stub.activationStarted, undefined)
            : Effect.void,
        } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]),
        Effect.provideService(DesktopRendererHistory.DesktopRendererHistory, {
          shutdown: stub.flushRendererHistory ?? Effect.void,
        } as DesktopRendererHistory.DesktopRendererHistory["Service"]),
      );
    return yield* runApp.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BrowserImport.BrowserImport, {}),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
          Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
          DesktopBackendService.layerTest({
            reattachLocalEnvironment: Effect.succeed(stub.reattachedLocalEnvironment ?? false),
            ...stub.backendService,
          }),
          Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
          Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
          Layer.succeed(
            DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
            DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.of({
              get: Effect.succeedNone,
              read: Effect.succeed({ catalog: null, catalogError: null }),
              set: () => Effect.succeed(false),
              recovery:
                stub.catalogRecovery === undefined
                  ? Effect.succeedNone
                  : Effect.succeedSome(stub.catalogRecovery),
            }),
          ),
          Layer.mock(DesktopIpc.DesktopIpc, {}),
          Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
            getBearerToken: stub
              .record("token")
              .pipe(
                Effect.andThen(
                  stub.tokenRequested
                    ? Deferred.succeed(stub.tokenRequested, undefined)
                    : Effect.void,
                ),
                Effect.as("token"),
              ),
          }),
          Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {}),
          Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
          Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
          Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
          Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
          Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
          Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
          Layer.mock(ElectronMenu.ElectronMenu, {}),
          Layer.mock(ElectronShell.ElectronShell, {}),
          Layer.mock(ElectronTheme.ElectronTheme, {}),
          Layer.mock(ElectronWindow.ElectronWindow, {}),
          Layer.mock(MacPermissions.MacPermissions, {}),
          Layer.mock(AppleSpeech.AppleSpeech, {}),
          Layer.mock(LoopbackTunnel.LoopbackTunnel, {}),
          Layer.mock(PreviewManager.PreviewManager, {
            isBrowserPartition: () => {
              throw new Error("unexpected browser partition lookup");
            },
          }),
          stub.fileSystem,
          Layer.mock(NetService.NetService, {}),
          Path.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected HTTP request")),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

it.effect.each([false, true])(
  "stops backends together before flushing history and cancels Linux registration, stop defect=%s",
  (stopDefect) =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const registrationStopped = yield* Deferred.make<void>();
      const windowStarted = yield* Deferred.make<void>();
      const firstStopStarted = yield* Deferred.make<void>();
      const secondStopStarted = yield* Deferred.make<void>();
      const releaseStops = yield* Deferred.make<void>();
      const historyStarted = yield* Deferred.make<void>();
      const releaseHistory = yield* Deferred.make<void>();
      const tokenRequested = yield* Deferred.make<void>();
      const events: string[] = [];
      const app = yield* runStubbedDesktop({
        localEnvironmentEnabled: true,
        environment: {},
        fileSystem: FileSystem.layerNoop({}),
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        windowStarted,
        tokenRequested,
        registerLinuxUrlHandler: Deferred.succeed(registrationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRegistration)),
          Effect.ensuring(Deferred.succeed(registrationStopped, undefined)),
        ),
        backends: [
          {
            stop: () =>
              Deferred.succeed(firstStopStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStops)),
                Effect.andThen(stopDefect ? Effect.die("stop defect") : Effect.void),
              ),
          },
          {
            stop: () =>
              Deferred.succeed(secondStopStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStops)),
              ),
          },
        ],
        flushRendererHistory: Deferred.succeed(historyStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseHistory)),
          Effect.asVoid,
        ),
      });
      yield* Deferred.await(registrationStarted);
      yield* Deferred.await(windowStarted);
      yield* Deferred.await(tokenRequested);
      // The backend spawns before menus, and its token is minted without waiting for the renderer.
      assert.deepEqual(
        events.filter((event) => event !== "token"),
        ["identity", "ready", "identity", "backend", "menu", "window"],
      );
      assert.isAbove(events.indexOf("token"), events.indexOf("backend"));
      assert.isFalse(yield* Deferred.isDone(registrationStopped));
      const shutdown = yield* DesktopShutdown.DesktopShutdown;
      yield* shutdown.request;
      yield* Deferred.await(firstStopStarted);
      yield* Deferred.await(secondStopStarted);
      assert.isFalse(yield* Deferred.isDone(historyStarted));
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseStops, undefined);
      yield* Deferred.await(historyStarted);
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseHistory, undefined);
      const result = yield* Fiber.await(app);
      assert.equal(Exit.isFailure(result), stopDefect);
      assert.isTrue(yield* shutdown.isComplete);
      assert.isTrue(yield* Deferred.isDone(registrationStopped));
    }).pipe(Effect.provide(DesktopShutdown.layer)),
);

it.effect("explains a recovered connection catalog and reconnects this machine", () =>
  Effect.gen(function* () {
    const windowStarted = yield* Deferred.make<void>();
    const messages: Array<{ title?: string; message: string; detail?: string }> = [];
    const app = yield* runStubbedDesktop({
      localEnvironmentEnabled: true,
      environment: {},
      fileSystem: FileSystem.layerNoop({}),
      record: () => Effect.void,
      windowStarted,
      registerLinuxUrlHandler: Effect.void,
      reattachedLocalEnvironment: true,
      catalogRecovery: {
        reason: "decrypt-catalog",
        catalogPath: "/isolated/userdata/connection-catalog.json",
        keptPath: "/isolated/userdata/connection-catalog.json.broken-1760000000000",
      },
      messages,
    });
    yield* Deferred.await(windowStarted);
    yield* (yield* DesktopShutdown.DesktopShutdown).request;
    yield* Fiber.join(app);

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.title, "Saved connections couldn't be read");
    assert.include(messages[0]?.message ?? "", "Your projects and threads are untouched.");
    assert.include(messages[0]?.detail ?? "", "connection-catalog.json.broken-1760000000000");
    assert.include(messages[0]?.detail ?? "", "signature changed between versions");
    assert.include(messages[0]?.detail ?? "", "reconnected automatically");
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);

it.effect(
  "points a stale p0 launcher at the updated AppImage and accepts p0 <dir> with Local environment off",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "p0-desktop-app-" });
      const launcher = DesktopCliShim.launcherPath({
        path,
        baseDir,
        platform: "linux",
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const removedAppImage = path.join(baseDir, "T3-Code-0.1.6-x86_64.AppImage");
      const updatedAppImage = path.join(baseDir, "T3-Code-0.1.7-x86_64.AppImage");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(
        launcher,
        DesktopCliShim.renderCliShim({
          target: { kind: "appimage", appImage: removedAppImage, executableName: "t3code" },
          shimPath: launcher,
          t3Home: baseDir,
        }),
      );
      yield* fs.writeFileString(updatedAppImage, "", { mode: 0o755 });
      const windowStarted = yield* Deferred.make<void>();
      const activationStarted = yield* Deferred.make<void>();

      const app = yield* runStubbedDesktop({
        localEnvironmentEnabled: false,
        activationStarted,
        environment: {
          path,
          baseDir,
          serverRoot: path.join(baseDir, "resources", "app.asar"),
          appImagePath: Option.some(updatedAppImage),
        },
        fileSystem: Layer.succeed(FileSystem.FileSystem, fs),
        record: () => Effect.void,
        windowStarted,
        registerLinuxUrlHandler: Effect.void,
      });
      yield* Deferred.await(windowStarted);
      yield* (yield* DesktopShutdown.DesktopShutdown).request;
      yield* Fiber.join(app);

      const content = yield* fs.readFileString(launcher);
      assert.include(
        content,
        `app='${updatedAppImage}'`,
        "startup left the p0 launcher pointing at the removed AppImage",
      );
      assert.isTrue(
        yield* Deferred.isDone(activationStarted),
        "startup left the p0 <dir> control socket closed",
      );
    }).pipe(Effect.provide(Layer.mergeAll(DesktopShutdown.layer, NodeServices.layer))),
);

it.effect.each([
  { button: 0, expected: ["prepare", "prepare", "backend"] },
  { button: 1, expected: ["prepare", "legacy", "backend"] },
])(
  "shows a p0d start failure instead of falling back, then follows the user's choice (button $button)",
  ({ button, expected }) =>
    Effect.gen(function* () {
      const windowStarted = yield* Deferred.make<void>();
      const messages: NonNullable<StubbedDesktop["messages"]> = [];
      const events: string[] = [];
      const failures = ["p0d exited with code 1.\n\np0d: listen tcp: address already in use"];
      const app = yield* runStubbedDesktop({
        localEnvironmentEnabled: true,
        environment: {},
        fileSystem: FileSystem.layerNoop({}),
        record: (event) =>
          Effect.sync(() => {
            if (event === "backend") events.push(event);
          }),
        windowStarted,
        registerLinuxUrlHandler: Effect.void,
        messages,
        messageResponses: [button],
        backendService: {
          resolveEffectiveMode: Effect.succeed("local-service"),
          prepareSelectedBackend: Effect.sync(() => {
            events.push("prepare");
            return { mode: "local-service" as const, failure: failures.shift() ?? null };
          }),
          useLegacyBackendForThisLaunch: Effect.sync(() => {
            events.push("legacy");
          }),
        },
      });
      yield* Deferred.await(windowStarted);
      yield* (yield* DesktopShutdown.DesktopShutdown).request;
      yield* Fiber.join(app);

      assert.deepEqual(events, expected);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.message, "p0d, the p0code backend, couldn't start.");
      assert.include(messages[0]?.detail ?? "", "address already in use");
      assert.deepEqual(messages[0]?.buttons, [
        "Retry",
        "Use legacy Node backend this once",
        "Quit",
      ]);
    }).pipe(Effect.provide(DesktopShutdown.layer)),
);
