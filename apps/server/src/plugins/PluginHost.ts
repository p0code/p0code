import {
  type PluginInfo,
  type PluginInvokeInput,
  type PluginManifest,
  PluginOperationError,
  type PluginSetEnabledInput,
  type PluginSettings,
  type PluginsSnapshot,
} from "@t3tools/contracts";
import {
  type Plugin,
  PluginContext,
  type PluginRouteHandler,
  type PluginServices,
  type StartedPlugin,
} from "@t3tools/plugin-api";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";

/** How a running plugin reaches the server; the live binding lives in `bindings.ts`. */
export class PluginHostBindings extends Context.Service<
  PluginHostBindings,
  {
    readonly contextFor: (
      manifest: PluginManifest,
      reportStatus: (message: string | null) => Effect.Effect<void>,
    ) => Effect.Effect<PluginContext["Service"]>;
    /** Ends the sessions and pairing links a plugin minted. */
    readonly revokeIssued: (pluginId: string) => Effect.Effect<void>;
    readonly migrateLegacyData: (
      settings: ServerSettings.ServerSettingsService["Service"],
    ) => Effect.Effect<void>;
    readonly platform: Context.Context<Exclude<PluginServices, PluginContext>>;
  }
>()("t3/plugins/PluginHost/PluginHostBindings") {}

export class BundledPlugins extends Context.Service<BundledPlugins, ReadonlyArray<Plugin>>()(
  "t3/plugins/PluginHost/BundledPlugins",
) {}

/**
 * Late-bound reader for active plugin instructions so orchestration layers built before
 * `PluginHost` can still query running plugins on every turn without a layer cycle.
 */
export class PluginAgentInstructions extends Context.Service<
  PluginAgentInstructions,
  {
    readonly read: Effect.Effect<ReadonlyArray<string>>;
    readonly attach: (read: Effect.Effect<ReadonlyArray<string>>) => Effect.Effect<void>;
  }
>()("t3/plugins/PluginHost/PluginAgentInstructions") {}

export const layerAgentInstructions = Layer.effect(
  PluginAgentInstructions,
  Effect.gen(function* () {
    const reader = yield* Ref.make<Effect.Effect<ReadonlyArray<string>>>(Effect.succeed([]));
    return PluginAgentInstructions.of({
      read: Effect.flatten(Ref.get(reader)),
      attach: Effect.fn("PluginAgentInstructions.attach")(function* (next) {
        yield* Ref.set(reader, next);
      }),
    });
  }),
);

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly changes: Stream.Stream<PluginsSnapshot>;
    readonly setEnabled: (
      input: PluginSetEnabledInput,
    ) => Effect.Effect<PluginsSnapshot, PluginOperationError>;
    readonly invoke: (input: PluginInvokeInput) => Effect.Effect<unknown, PluginOperationError>;
    /** The handler a running plugin serves at `path`, if any. */
    readonly route: (path: string) => Effect.Effect<PluginRouteHandler | null>;
    /** Instruction blocks from running plugins that declared `agent:instructions`. */
    readonly agentInstructions: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/plugins/PluginHost") {}

const START_TIMEOUT = "30 seconds";
const STOP_TIMEOUT = "15 seconds";

interface Running {
  readonly plugin: Plugin;
  readonly scope: Scope.Closeable;
  readonly started: StartedPlugin;
}

const isEnabled = (settings: PluginSettings, id: string) =>
  Object.hasOwn(settings, id) && settings[id]?.enabled === true;

const failureMessage = (cause: Cause.Cause<{ readonly message: string }>) => {
  const failure = cause.reasons.find(Cause.isFailReason);
  return failure?.error.message ?? "The plugin stopped unexpectedly.";
};

const make = Effect.gen(function* () {
  const plugins = yield* BundledPlugins;
  const bindings = yield* PluginHostBindings;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const platform = bindings.platform;
  const lock = yield* Semaphore.make(1);
  const running = new Map<string, Running>();
  const infos = new Map<string, PluginInfo>(
    plugins.map((plugin) => [
      plugin.manifest.id,
      { manifest: plugin.manifest, enabled: false, state: "disabled", message: null },
    ]),
  );
  const snapshotRef = yield* SubscriptionRef.make<PluginsSnapshot>({
    plugins: [...infos.values()],
  });
  const publish = Effect.suspend(() =>
    SubscriptionRef.set(snapshotRef, { plugins: [...infos.values()] }),
  );
  const updateInfo = (id: string, update: Partial<PluginInfo>) =>
    Effect.suspend(() => {
      const current = infos.get(id);
      if (current === undefined) return Effect.void;
      infos.set(id, { ...current, ...update });
      return publish;
    });

  const holdsDeviceAccess = (plugin: Plugin) =>
    plugin.manifest.capabilities.includes("auth:issue-device-credentials");

  const start = Effect.fn("PluginHost.start")(function* (plugin: Plugin) {
    const id = plugin.manifest.id;
    yield* updateInfo(id, { enabled: true, state: "starting", message: null });
    if (
      plugin.manifest.httpRoutes.length > 0 &&
      !plugin.manifest.capabilities.includes("http:routes")
    ) {
      return yield* updateInfo(id, {
        state: "failed",
        message: "Plugin routes require the http:routes capability.",
      });
    }
    const scope = yield* Scope.make();
    const context = yield* bindings.contextFor(plugin.manifest, (message) =>
      Effect.suspend(() =>
        running.has(id) || infos.get(id)?.state === "starting"
          ? updateInfo(id, { message })
          : Effect.void,
      ),
    );
    const exit = yield* plugin.start.pipe(
      // Innermost, so the plugin's finalizers land in its own scope and not one `platform` carries.
      Scope.provide(scope),
      Effect.provideService(PluginContext, context),
      Effect.provideContext(platform),
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.die(new Error("The plugin did not start in time.")),
      }),
      Effect.exit,
    );
    if (Exit.isFailure(exit)) {
      yield* Scope.close(scope, exit).pipe(Effect.timeout(STOP_TIMEOUT), Effect.ignore);
      yield* Effect.logWarning("Plugin failed to start", { plugin: id, cause: exit.cause });
      return yield* updateInfo(id, { state: "failed", message: failureMessage(exit.cause) });
    }
    running.set(id, { plugin, scope, started: exit.value });
    yield* updateInfo(id, { state: "running" });
  });

  const stop = Effect.fn("PluginHost.stop")(function* (plugin: Plugin) {
    const id = plugin.manifest.id;
    const current = running.get(id);
    running.delete(id);
    if (current !== undefined) {
      yield* Scope.close(current.scope, Exit.void).pipe(
        Effect.timeout(STOP_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("Plugin did not stop cleanly", { plugin: id, cause }),
        ),
      );
    }
    // Sessions outlive the plugin's scope, so the host ends them even if the plugin forgot.
    if (holdsDeviceAccess(plugin)) yield* bindings.revokeIssued(id);
    yield* updateInfo(id, { enabled: false, state: "disabled", message: null });
  });

  const reconcile = (settings: PluginSettings) =>
    lock.withPermits(1)(
      Effect.forEach(
        plugins,
        (plugin) => {
          const wanted = isEnabled(settings, plugin.manifest.id);
          const isRunning = running.has(plugin.manifest.id);
          const failed = infos.get(plugin.manifest.id)?.state === "failed";
          if (wanted && !isRunning && !failed) return start(plugin);
          if (!wanted && (isRunning || failed)) return stop(plugin);
          return Effect.void;
        },
        { discard: true },
      ),
    );

  const pluginById = (pluginId: string) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === pluginId);
    return plugin === undefined
      ? Effect.fail(new PluginOperationError({ pluginId, message: "Unknown plugin." }))
      : Effect.succeed(plugin);
  };

  const setEnabled: PluginHost["Service"]["setEnabled"] = Effect.fn("PluginHost.setEnabled")(
    function* (input) {
      const plugin = yield* pluginById(input.pluginId);
      const settings = yield* settingsService
        .updateSettings({ plugins: { [plugin.manifest.id]: { enabled: input.enabled } } })
        .pipe(
          Effect.mapError(
            (error) =>
              new PluginOperationError({ pluginId: input.pluginId, message: error.message }),
          ),
        );
      // Turning a failed plugin back on is how someone retries it.
      if (input.enabled && infos.get(plugin.manifest.id)?.state === "failed") {
        yield* lock.withPermits(1)(stop(plugin));
      }
      yield* reconcile(settings.plugins);
      return yield* SubscriptionRef.get(snapshotRef);
    },
  );

  const invoke: PluginHost["Service"]["invoke"] = Effect.fn("PluginHost.invoke")(function* (input) {
    const current = running.get(input.pluginId);
    if (current === undefined) {
      return yield* new PluginOperationError({
        pluginId: input.pluginId,
        message: "Turn the plugin on first.",
      });
    }
    return yield* current.started
      .invoke(input.action, input.input)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new PluginOperationError({ pluginId: input.pluginId, message: failureMessage(cause) }),
          ),
        ),
      );
  });

  const route: PluginHost["Service"]["route"] = (path) =>
    Effect.sync(() => {
      for (const { plugin, started } of running.values()) {
        if (!plugin.manifest.capabilities.includes("http:routes")) continue;
        if (!plugin.manifest.httpRoutes.includes(path)) continue;
        const handler = started.routes.get(path);
        if (handler !== undefined) return handler;
      }
      return null;
    });

  const agentInstructions: PluginHost["Service"]["agentInstructions"] = Effect.gen(function* () {
    const blocks: Array<string> = [];
    for (const plugin of plugins) {
      if (!plugin.manifest.capabilities.includes("agent:instructions")) continue;
      const reader = running.get(plugin.manifest.id)?.started.agentInstructions;
      if (reader === undefined) continue;
      const text = yield* reader.pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("Plugin agentInstructions failed", {
            plugin: plugin.manifest.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (typeof text === "string" && text.trim().length > 0) {
        blocks.push(text);
      }
    }
    return blocks;
  });

  const instructionsSlot = yield* Effect.serviceOption(PluginAgentInstructions);
  if (Option.isSome(instructionsSlot)) {
    yield* instructionsSlot.value.attach(agentInstructions);
    yield* Effect.addFinalizer(() => instructionsSlot.value.attach(Effect.succeed([])));
  }

  yield* bindings.migrateLegacyData(settingsService);

  // A plugin turned off while the server was down may have left sessions behind.
  const initial = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.plugins),
    Effect.orElseSucceed((): PluginSettings => ({})),
  );
  yield* Effect.forEach(
    plugins.filter(
      (plugin) => holdsDeviceAccess(plugin) && !isEnabled(initial, plugin.manifest.id),
    ),
    (plugin) => bindings.revokeIssued(plugin.manifest.id),
    { discard: true },
  );
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(
      Effect.forEach(
        plugins.filter((plugin) => running.has(plugin.manifest.id)),
        (plugin) => {
          const current = running.get(plugin.manifest.id);
          running.delete(plugin.manifest.id);
          return current === undefined
            ? Effect.void
            : Scope.close(current.scope, Exit.void).pipe(
                Effect.timeout(STOP_TIMEOUT),
                Effect.ignore,
              );
        },
        { discard: true },
      ),
    ),
  );
  // Re-read on every change: an emitted snapshot can predate a write this host just made.
  yield* settingsService.streamChanges.pipe(
    Stream.runForEach(() =>
      settingsService.getSettings.pipe(
        Effect.flatMap((settings) => reconcile(settings.plugins)),
        Effect.ignore,
      ),
    ),
    Effect.forkScoped,
  );
  yield* reconcile(initial).pipe(Effect.forkScoped);

  return PluginHost.of({
    changes: SubscriptionRef.changes(snapshotRef),
    setEnabled,
    invoke,
    route,
    agentInstructions,
  });
});

export const layer = Layer.effect(PluginHost, make);
