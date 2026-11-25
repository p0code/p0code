import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginContext, type PluginServices } from "@t3tools/plugin-api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { InstalledPlugins, layerWith } from "./loader.ts";
import {
  BundledPlugins,
  layer as pluginHostLayer,
  PluginHost,
  PluginHostBindings,
} from "./PluginHost.ts";
import * as PluginRegistry from "./registry.ts";

// Fixture plugins import the host's own copy of effect, like the installer's externals make
// real installs do; the URL is resolved from this repo so the fixture has nothing to install.
const effectUrl = import.meta.resolve("effect/Effect");

type SettingsOverrides = NonNullable<
  Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0]
>;

interface FixtureContext {
  readonly stateDir: string;
  readonly path: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
}

const manifestObject = (
  id: string,
  version: string,
  capabilities: ReadonlyArray<string> = [],
  apiVersion?: number,
) => ({
  id,
  name: id,
  description: "Fixture plugin.",
  version,
  unofficial: false,
  externalServices: [],
  capabilities,
  httpRoutes: [],
  ...(apiVersion === undefined ? {} : { apiVersion }),
});

const pluginCode = (manifest: Record<string, unknown>) => `
import * as Effect from ${JSON.stringify(effectUrl)};
export default {
  manifest: ${JSON.stringify(manifest)},
  start: Effect.succeed({
    invoke: (action, input) => Effect.succeed(action + ":" + JSON.stringify(input ?? null)),
    routes: new Map(),
  }),
};
`;

const writeVersion = Effect.fn("loaderTest.writeVersion")(function* (
  context: FixtureContext,
  input: {
    readonly id: string;
    readonly version: string;
    readonly capabilities?: ReadonlyArray<string>;
    readonly apiVersion?: number;
    /** Raw manifest.json text, for installs that ship a broken one. */
    readonly manifest?: string;
    /** Raw plugin.mjs text, for installs that ship broken code. */
    readonly code?: string;
  },
) {
  const dir = context.path.join(context.stateDir, "installed-plugins", input.id, input.version);
  yield* context.fileSystem.makeDirectory(dir, { recursive: true });
  const manifest =
    input.manifest ??
    JSON.stringify(
      manifestObject(input.id, input.version, input.capabilities ?? [], input.apiVersion),
    );
  yield* context.fileSystem.writeFileString(context.path.join(dir, "manifest.json"), manifest);
  // A raw manifest means the test is exercising a broken file; the loader never reaches the code.
  if (input.code !== undefined) {
    yield* context.fileSystem.writeFileString(context.path.join(dir, "plugin.mjs"), input.code);
  } else if (input.manifest === undefined) {
    yield* context.fileSystem.writeFileString(
      context.path.join(dir, "plugin.mjs"),
      pluginCode(
        manifestObject(input.id, input.version, input.capabilities ?? [], input.apiVersion),
      ),
    );
  }
});

type FixturePlan = (context: FixtureContext) => Effect.Effect<void, PlatformError.PlatformError>;

const makeConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-loader-" });

const depsLayer = (overrides: SettingsOverrides = {}) =>
  Layer.mergeAll(makeConfigLayer(), ServerSettings.ServerSettingsService.layerTest(overrides)).pipe(
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );

/** Writes the fixture plugins; tests run it while their layers build, before the loader scans. */
const writeFixtures = (plan: FixturePlan) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* plan({ stateDir: config.stateDir, path, fileSystem });
  });

const loaderLayerFor = (
  plan: FixturePlan,
  overrides: SettingsOverrides = {},
  bundledIds: ReadonlyArray<string> = [],
) => {
  const deps = depsLayer(overrides);
  return layerWith(bundledIds).pipe(
    Layer.provide(Layer.effectDiscard(writeFixtures(plan)).pipe(Layer.provide(deps))),
    Layer.provide(deps),
  );
};

const stubPtyLayer = Layer.succeed(
  PtyAdapter.PtyAdapter,
  PtyAdapter.PtyAdapter.of({ spawn: () => Effect.die("unused") }),
);

const stubBindings = Layer.effect(
  PluginHostBindings,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Exclude<PluginServices, PluginContext>>();
    return PluginHostBindings.of({
      platform,
      revokeIssued: () => Effect.void,
      migrateLegacyData: () => Effect.void,
      contextFor: (manifest, reportStatus) =>
        Effect.succeed(
          PluginContext.of({
            pluginId: manifest.id,
            dataDir: "/nonexistent",
            storage: {
              get: () => Effect.succeedNone,
              set: () => Effect.void,
              remove: () => Effect.void,
            },
            reportStatus,
            environment: {
              environmentId: Effect.die("unused"),
              descriptor: Effect.die("unused"),
              localOrigin: Effect.die("unused"),
            },
            deviceAccess: { issueCredential: () => Effect.die("unused"), revokeAll: Effect.void },
            agentActivity: {
              changes: Stream.empty,
              read: () => Effect.succeed(null),
              activeThreadIds: Effect.succeed([]),
            },
            dataBackup: {
              snapshot: Effect.die("unused"),
              stageRestore: () => Effect.die("unused"),
              pendingRestore: Effect.die("unused"),
              cancelRestore: Effect.die("unused"),
            },
            usage: { dailyTotals: () => Effect.die("unused") },
          }),
        ),
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer, stubPtyLayer),
  ),
);

/** The real registry and host over a throwaway state dir, with bindings that lend nothing. */
const hostLayerFor = (plan: FixturePlan, overrides: SettingsOverrides = {}) => {
  const deps = depsLayer(overrides);
  return pluginHostLayer.pipe(
    Layer.provide(
      PluginRegistry.layer.pipe(
        Layer.provide(Layer.effectDiscard(writeFixtures(plan)).pipe(Layer.provide(deps))),
        Layer.provide(deps),
      ),
    ),
    Layer.provide(stubBindings),
    Layer.provideMerge(deps),
  );
};

const registryLayerFor = (plan: FixturePlan) => {
  const deps = depsLayer();
  return PluginRegistry.layer.pipe(
    Layer.provide(Layer.effectDiscard(writeFixtures(plan)).pipe(Layer.provide(deps))),
    Layer.provide(deps),
  );
};

const snapshotOf = (id: string) =>
  PluginHost.pipe(
    Effect.flatMap((host) => host.changes.pipe(Stream.take(1), Stream.runHead)),
    Effect.map((snapshot) =>
      Option.getOrThrow(snapshot).plugins.find((plugin) => plugin.manifest.id === id),
    ),
  );

const one =
  (id: string, version: string, rest: Partial<Parameters<typeof writeVersion>[1]> = {}) =>
  (context: FixtureContext) =>
    writeVersion(context, { id, version, ...rest });

describe("plugin loader", () => {
  it.effect("loads a fixture plugin from the state folder", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.id),
        ["fixture"],
      );
      assert.strictEqual(installed.plugins[0]?.origin, "installed");
      assert.strictEqual(installed.plugins[0]?.manifest.version, "1.0.0");
      assert.deepStrictEqual(installed.failures, []);
    }).pipe(Effect.provide(loaderLayerFor(one("fixture", "1.0.0")))),
  );

  it.effect("keeps a plugin whose code throws from breaking the others", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.id),
        ["survivor"],
      );
      assert.strictEqual(installed.failures.length, 1);
      assert.strictEqual(installed.failures[0]?.manifest.id, "thrower");
      assert.include(installed.failures[0]?.message, "boom at import");
    }).pipe(
      Effect.provide(
        loaderLayerFor((context) =>
          Effect.gen(function* () {
            yield* writeVersion(context, {
              id: "thrower",
              version: "1.0.0",
              code: 'throw new Error("boom at import");\n',
            });
            yield* writeVersion(context, { id: "survivor", version: "1.0.0" });
          }),
        ),
      ),
    ),
  );

  it.effect("refuses a manifest it cannot read", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(installed.plugins, []);
      assert.strictEqual(installed.failures.length, 1);
      assert.strictEqual(installed.failures[0]?.manifest.id, "unreadable");
      assert.strictEqual(installed.failures[0]?.manifest.version, "1.0.0");
      assert.include(installed.failures[0]?.message, "manifest.json could not be read");
    }).pipe(Effect.provide(loaderLayerFor(one("unreadable", "1.0.0", { manifest: "{ not json" })))),
  );

  it.effect("refuses a version that needs a newer plugin API", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(installed.plugins, []);
      assert.strictEqual(installed.failures[0]?.manifest.id, "from-the-future");
      assert.include(installed.failures[0]?.message, "plugin API v99");
      assert.include(installed.failures[0]?.message, "Update p0code or the plugin");
    }).pipe(Effect.provide(loaderLayerFor(one("from-the-future", "1.0.0", { apiVersion: 99 })))),
  );

  it.effect("falls back to the previous version when the newest one does not load", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.version),
        ["1.0.0"],
      );
      assert.deepStrictEqual(installed.failures, []);
    }).pipe(
      Effect.provide(
        loaderLayerFor((context) =>
          Effect.gen(function* () {
            yield* writeVersion(context, {
              id: "fixture",
              version: "2.0.0",
              code: 'throw new Error("broken update");\n',
            });
            yield* writeVersion(context, { id: "fixture", version: "1.0.0" });
          }),
        ),
      ),
    ),
  );

  it.effect("falls back past a version that needs a newer plugin API", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.version),
        ["1.0.0"],
      );
      assert.deepStrictEqual(installed.failures, []);
    }).pipe(
      Effect.provide(
        loaderLayerFor((context) =>
          Effect.gen(function* () {
            yield* writeVersion(context, {
              id: "fixture",
              version: "2.0.0",
              apiVersion: 99,
            });
            yield* writeVersion(context, { id: "fixture", version: "1.0.0" });
          }),
        ),
      ),
    ),
  );

  it.effect("keeps a version inactive until its new capability is consented to", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.version),
        ["1.0.0"],
      );
      assert.deepStrictEqual(installed.failures, []);
    }).pipe(
      Effect.provide(
        loaderLayerFor((context) =>
          Effect.gen(function* () {
            yield* writeVersion(context, {
              id: "fixture",
              version: "2.0.0",
              capabilities: ["network:outbound"],
            });
            yield* writeVersion(context, { id: "fixture", version: "1.0.0" });
          }),
        ),
      ),
    ),
  );

  it.effect("runs the newest version once its capability is consented to", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(
        installed.plugins.map((plugin) => plugin.manifest.version),
        ["2.0.0"],
      );
    }).pipe(
      Effect.provide(
        loaderLayerFor(
          (context) =>
            Effect.gen(function* () {
              yield* writeVersion(context, {
                id: "fixture",
                version: "2.0.0",
                capabilities: ["network:outbound"],
              });
              yield* writeVersion(context, { id: "fixture", version: "1.0.0" });
            }),
          {
            plugins: { fixture: { enabled: false, consentedCapabilities: ["network:outbound"] } },
          },
        ),
      ),
    ),
  );

  it.effect("refuses an installed copy of a plugin that is built in", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(installed.plugins, []);
      assert.deepStrictEqual(installed.failures, []);
    }).pipe(Effect.provide(loaderLayerFor(one("built-in", "9.9.9"), {}, ["built-in"]))),
  );

  it.effect("reports an install without its plugin.mjs as failed", () =>
    Effect.gen(function* () {
      const installed = yield* InstalledPlugins;
      assert.deepStrictEqual(installed.plugins, []);
      assert.strictEqual(installed.failures[0]?.manifest.id, "half-installed");
      assert.include(installed.failures[0]?.message, "plugin.mjs is missing");
    }).pipe(
      Effect.provide(
        loaderLayerFor(
          one("half-installed", "1.0.0", {
            manifest: JSON.stringify(manifestObject("half-installed", "1.0.0")),
          }),
        ),
      ),
    ),
  );

  it.effect("runs an installed plugin once it is enabled, and unloads it when it is disabled", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      const before = yield* snapshotOf("fixture");
      assert.strictEqual(before?.state, "disabled");
      assert.strictEqual(before?.origin, "installed");

      yield* host.setEnabled({ pluginId: "fixture", enabled: true });
      const running = yield* snapshotOf("fixture");
      assert.strictEqual(running?.state, "running");
      assert.strictEqual(
        yield* host.invoke({ pluginId: "fixture", action: "ping", input: { hello: 1 } }),
        'ping:{"hello":1}',
      );

      yield* host.setEnabled({ pluginId: "fixture", enabled: false });
      assert.strictEqual((yield* snapshotOf("fixture"))?.state, "disabled");
    }).pipe(Effect.provide(hostLayerFor(one("fixture", "1.0.0")))),
  );

  it.effect("keeps serving the bundled plugins alongside installed ones", () =>
    Effect.gen(function* () {
      const hosted = yield* BundledPlugins;
      const ids = hosted.plugins.map((plugin) => plugin.manifest.id);
      assert.include(ids, "t3-connect-bridge");
      assert.include(ids, "obsidian-shared-memory");
      assert.include(ids, "fixture");
      assert.deepStrictEqual(hosted.failures, []);
    }).pipe(Effect.provide(registryLayerFor(one("fixture", "1.0.0")))),
  );
});
