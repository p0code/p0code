// @effect-diagnostics nodeBuiltinImport:off -- Fixtures exercise actual on-disk bundles and symlink module resolution.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { PluginContext, type PluginServices, type Plugin } from "@t3tools/plugin-api";
import { type PluginManifest, WS_METHODS, AuthRelayConfigureScope } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ServerConfig, layerTest } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { requiredScopesForRpcCall } from "../auth/RpcAuthorization.ts";
import {
  BundledPlugins,
  PluginHost,
  PluginHostBindings,
  layer as hostLayer,
} from "./PluginHost.ts";
import { InstalledPlugins, layerWith } from "./loader.ts";
import {
  makeInstaller,
  hostPackagePaths,
  linkHostPackages,
  type BundleExpectation,
} from "./installer.ts";
import { readGithub } from "./installSources.ts";
import { readInstallRecord } from "./installRecords.ts";

const manifest = (
  version = "1.0.0",
  capabilities: PluginManifest["capabilities"] = ["http:routes"],
  id = "fixture",
): PluginManifest => ({
  id,
  version,
  name: id,
  description: "Installer fixture",
  unofficial: true,
  externalServices: [],
  capabilities,
  httpRoutes: ["/api/fixture/ping"],
});
const code = (value: PluginManifest) => `
import * as Effect from 'effect/Effect';
export default { manifest: ${JSON.stringify(value)}, start: Effect.succeed({
 invoke: (action, input) => Effect.succeed({ action, input, version: ${JSON.stringify(value.version)} }),
 routes: new Map([['/api/fixture/ping', () => Effect.succeed({ status: 200, body: ${JSON.stringify(value.version)} })]])
}) };
`;
const fixture = (stateDir: string, value: PluginManifest) =>
  Effect.promise(async () => {
    const dir = NodePath.join(stateDir, `fixture-${value.id}-${value.version}`);
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "manifest.json"), JSON.stringify(value));
    await NodeFSP.writeFile(NodePath.join(dir, "plugin.mjs"), code(value));
    return dir;
  });
const secretLayer = Layer.sync(ServerSecretStore, () => {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    list: (prefix) =>
      Effect.sync(() => [...values.keys()].filter((name) => name.startsWith(prefix))),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  });
});
const bindings = Layer.effect(
  PluginHostBindings,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Exclude<PluginServices, PluginContext>>();
    return PluginHostBindings.of({
      platform,
      revokeIssued: () => Effect.void,
      migrateLegacyData: () => Effect.void,
      contextFor: (value, reportStatus) =>
        Effect.succeed(
          PluginContext.of({
            pluginId: value.id,
            dataDir: "/unused",
            reportStatus,
            storage: {
              get: () => Effect.succeedNone,
              set: () => Effect.void,
              remove: () => Effect.void,
            },
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
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      FetchHttpClient.layer,
      Layer.succeed(PtyAdapter.PtyAdapter, { spawn: () => Effect.die("unused") }),
    ),
  ),
);
const bundled: Plugin = { manifest: manifest("1.0.0", [], "bundled"), start: Effect.die("unused") };
const deps = Layer.mergeAll(
  layerTest(process.cwd(), { prefix: "p0-installer-" }),
  ServerSettingsService.layerTest(),
  secretLayer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
const testLayer = hostLayer.pipe(
  Layer.provide(Layer.succeed(BundledPlugins, { plugins: [bundled], failures: [] })),
  Layer.provide(bindings),
  Layer.provideMerge(deps),
);

describe("plugin installer", () => {
  it.layer(testLayer)((it) => {
    it.effect("stages GitHub downloads without importing executable code before consent", () =>
      Effect.gen(function* () {
        const value = manifest("1.0.0", ["network:outbound"], "github-fixture");
        const installer = yield* makeInstaller({
          github: (source) =>
            readGithub(source, async (url) => {
              if (url.startsWith("https://api.github.com/"))
                return new TextEncoder().encode(
                  JSON.stringify({
                    assets: [
                      {
                        name: "plugin.mjs",
                        browser_download_url:
                          "https://github.com/owner/repo/releases/download/v1/plugin.mjs",
                      },
                      {
                        name: "manifest.json",
                        browser_download_url:
                          "https://github.com/owner/repo/releases/download/v1/manifest.json",
                      },
                    ],
                  }),
                );
              return new TextEncoder().encode(
                url.endsWith("manifest.json")
                  ? JSON.stringify(value)
                  : "throw new Error('must never execute before consent');",
              );
            }),
        });
        const staged = yield* installer.install({ source: "owner/repo@v1" });
        assert.equal(staged.record.activeVersion, null);
        assert.equal(staged.record.stagedVersion, "1.0.0");
        assert.equal(staged.record.versions[0]?.source.kind, "github");
        assert.equal(
          (yield* installer.list).stagedManifests.some((item) => item.id === value.id),
          true,
        );
      }),
    );
    it.effect("installs, consents, invokes, updates, rolls back and retains or purges data", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const host = yield* PluginHost;
        const installer = yield* makeInstaller();
        const secrets = yield* ServerSecretStore;
        const v1 = manifest();
        const source = yield* fixture(stateDir, v1);
        const staged = yield* installer.install({ source });
        assert.equal(staged.record.activeVersion, null);
        assert.equal(staged.record.stagedVersion, "1.0.0");
        assert.equal(
          (yield* host.snapshot).plugins.some((plugin) => plugin.manifest.id === "fixture"),
          false,
        );
        assert.isNull(yield* host.route("/api/fixture/ping"));
        assert.isTrue(
          (yield* installer
            .consent({ id: "fixture", version: "1.0.0", capabilities: [] })
            .pipe(Effect.flip)).message.includes("Consent"),
        );
        yield* installer.consent({
          id: "fixture",
          version: "1.0.0",
          capabilities: v1.capabilities,
        });
        yield* host.setEnabled({ pluginId: "fixture", enabled: true });
        assert.deepEqual(yield* host.invoke({ pluginId: "fixture", action: "echo", input: 42 }), {
          action: "echo",
          input: 42,
          version: "1.0.0",
        });
        const route = yield* host.route("/api/fixture/ping");
        assert.isNotNull(route);
        assert.deepEqual(yield* route!(null), { status: 200, body: "1.0.0" });
        const v2 = manifest("2.0.0", ["http:routes", "network:outbound"]);
        const update = yield* installer.update({
          id: "fixture",
          source: yield* fixture(stateDir, v2),
        });
        assert.equal(update.record.activeVersion, "1.0.0");
        assert.equal(update.record.stagedVersion, "2.0.0");
        assert.deepEqual(yield* host.invoke({ pluginId: "fixture", action: "echo", input: null }), {
          action: "echo",
          input: null,
          version: "1.0.0",
        });
        yield* installer.consent({
          id: "fixture",
          version: "2.0.0",
          capabilities: v2.capabilities,
        });
        assert.equal(
          (yield* host.snapshot).plugins.find((plugin) => plugin.manifest.id === "fixture")
            ?.enabled,
          false,
        );
        yield* host.setEnabled({ pluginId: "fixture", enabled: true });
        assert.deepEqual(yield* host.invoke({ pluginId: "fixture", action: "echo", input: 2 }), {
          action: "echo",
          input: 2,
          version: "2.0.0",
        });
        const rollback = yield* installer.rollback({ id: "fixture" });
        assert.equal(rollback.record.activeVersion, "1.0.0");
        yield* host.setEnabled({ pluginId: "fixture", enabled: true });
        assert.deepEqual(yield* host.invoke({ pluginId: "fixture", action: "echo", input: 1 }), {
          action: "echo",
          input: 1,
          version: "1.0.0",
        });
        const loaded = yield* InstalledPlugins.pipe(Effect.provide(layerWith([])));
        assert.equal(loaded.plugins[0]?.manifest.version, "1.0.0");
        const dataDir = NodePath.join(stateDir, "plugins", "fixture");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dataDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(dataDir, "state"), "keep");
        });
        yield* secrets.set("plugin-fixture-token", new Uint8Array([1]));
        yield* secrets.set("plugin-other-token", new Uint8Array([2]));
        yield* installer.remove({ id: "fixture", purgeData: false });
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dataDir, "state"), "utf8")),
          "keep",
        );
        assert.isTrue(Option.isSome(yield* secrets.get("plugin-fixture-token")));
        assert.isNull(yield* host.route("/api/fixture/ping"));
        const removed = yield* installer.remove({ id: "fixture", purgeData: true });
        assert.isNotNull(removed.record.removedDataAt);
        assert.isTrue(Option.isNone(yield* secrets.get("plugin-fixture-token")));
        assert.isTrue(Option.isSome(yield* secrets.get("plugin-other-token")));
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(dataDir).then(
              () => true,
              () => false,
            ),
          ),
        );
        assert.deepEqual((yield* installer.list).installations[0]?.versions, []);
      }),
    );
    it.effect(
      "refuses shop metadata drift, bundled ids and incompatible manifests before writing code",
      () =>
        Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig;
          const value = manifest("3.0.0", [], "catalog-fixture");
          const bundle = {
            manifest: JSON.stringify(value),
            code: new TextEncoder().encode(code(value)),
          };
          const installer = yield* makeInstaller();
          const stage = (expected: BundleExpectation) =>
            installer
              .installBundle({
                bundle,
                origin: { kind: "catalog", id: value.id },
                expected,
              })
              .pipe(Effect.flip);
          assert.include(
            (yield* stage({
              id: value.id,
              version: value.version,
              capabilities: ["network:outbound"],
            })).message,
            "capabilities do not match",
          );
          assert.include(
            (yield* stage({ id: value.id, version: "9.9.9" })).message,
            "version does not match",
          );
          assert.include(
            (yield* stage({ id: "another-plugin", version: value.version })).message,
            "id does not match",
          );
          assert.isNull(yield* Effect.promise(() => readInstallRecord(stateDir, value.id)));
          const source = yield* fixture(stateDir, manifest("1.0.0", [], "bundled"));
          assert.include(
            (yield* installer.install({ source }).pipe(Effect.flip)).message,
            "built into",
          );
          const bad = { ...manifest("9.0.0", [], "incompatible"), apiVersion: 999 };
          assert.include(
            (yield* installer.install({ source: yield* fixture(stateDir, bad) }).pipe(Effect.flip))
              .message,
            "Incompatible",
          );
        }),
    );
    it.effect(
      "keeps even zero-capability stages inactive and rolls back a corrupted active bundle at boot",
      () =>
        Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig;
          const installer = yield* makeInstaller();
          const value = { ...manifest("1.0.0", [], "record-fixture"), httpRoutes: [] };
          yield* installer.install({ source: yield* fixture(stateDir, value) });
          const pending = yield* InstalledPlugins.pipe(Effect.provide(layerWith([])));
          assert.isFalse(pending.plugins.some((plugin) => plugin.manifest.id === value.id));
          assert.deepEqual(
            (yield* installer.list).stagedManifests.find((item) => item.id === value.id)
              ?.capabilities,
            [],
          );
          yield* installer.consent({ id: value.id, version: value.version, capabilities: [] });
          const next = { ...value, version: "2.0.0" };
          yield* installer.update({ id: value.id, source: yield* fixture(stateDir, next) });
          const staged = yield* InstalledPlugins.pipe(Effect.provide(layerWith([])));
          assert.equal(
            staged.plugins.find((plugin) => plugin.manifest.id === value.id)?.manifest.version,
            "1.0.0",
          );
          yield* installer.consent({ id: value.id, version: next.version, capabilities: [] });
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(stateDir, "installed-plugins", value.id, next.version, "plugin.mjs"),
              "throw new Error('never import a modified bundle');",
            ),
          );
          const recovered = yield* InstalledPlugins.pipe(Effect.provide(layerWith([])));
          assert.equal(
            recovered.plugins.find((plugin) => plugin.manifest.id === value.id)?.manifest.version,
            "1.0.0",
          );
          assert.equal(
            (yield* Effect.promise(() => readInstallRecord(stateDir, value.id)))?.activeVersion,
            "1.0.0",
          );
          yield* installer.remove({ id: value.id, purgeData: true });
        }),
    );
    it.effect("links externals to the host package instead of installing a second dependency", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        yield* Effect.promise(async () => {
          const target = NodePath.join(stateDir, "stub-host-package");
          const dir = NodePath.join(stateDir, "stub-plugin");
          await NodeFSP.mkdir(target);
          await NodeFSP.writeFile(
            NodePath.join(target, "package.json"),
            JSON.stringify({ name: "@t3tools/stub", type: "module", exports: "./index.mjs" }),
          );
          await NodeFSP.writeFile(
            NodePath.join(target, "index.mjs"),
            "export const identity = {};\n",
          );
          await linkHostPackages(dir, { "@t3tools/stub": target });
          await NodeFSP.writeFile(
            NodePath.join(dir, "plugin.mjs"),
            "export { identity } from '@t3tools/stub';\n",
          );
          const host: { identity: unknown } = await import(
            NodeURL.pathToFileURL(NodePath.join(target, "index.mjs")).href
          );
          const plugin: { identity: unknown } = await import(
            NodeURL.pathToFileURL(NodePath.join(dir, "plugin.mjs")).href
          );
          assert.strictEqual(plugin.identity, host.identity);
          assert.equal(
            await NodeFSP.realpath(NodePath.join(dir, "node_modules", "@t3tools/stub")),
            target,
          );
          assert.isString(hostPackagePaths().effect);
        });
      }),
    );
  });
  it("requires administrative scope for every installer RPC", () => {
    for (const method of [
      WS_METHODS.pluginsInstalledList,
      WS_METHODS.pluginsShopList,
      WS_METHODS.pluginsShopEntry,
      WS_METHODS.pluginsShopRefresh,
      WS_METHODS.pluginsShopInstall,
      WS_METHODS.pluginsShopUpdate,
      WS_METHODS.pluginsShopUninstall,
      WS_METHODS.pluginsInstall,
      WS_METHODS.pluginsConsent,
      WS_METHODS.pluginsUpdate,
      WS_METHODS.pluginsRemove,
      WS_METHODS.pluginsRollback,
    ])
      assert.deepEqual(requiredScopesForRpcCall(method, {}), [AuthRelayConfigureScope]);
  });
});
