// @effect-diagnostics nodeBuiltinImport:off -- Fixtures build real archives and read the installer's on-disk records.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { PluginContext, type PluginServices, type Plugin } from "@t3tools/plugin-api";
import type { PluginManifest, PluginShopCatalog } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { ServerConfig, layerTest } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { BundledPlugins, PluginHostBindings, layer as hostLayer } from "./PluginHost.ts";
import { makeInstaller, PluginInstaller } from "./installer.ts";
import { readInstallRecord } from "./installRecords.ts";
import { makeShop, type ShopOptions } from "./shop.ts";

const manifest = (
  version: string,
  capabilities: PluginManifest["capabilities"] = ["network:outbound"],
  id = "shop-fixture",
): PluginManifest => ({
  id,
  version,
  name: id,
  description: "Shop fixture",
  unofficial: true,
  externalServices: [],
  capabilities,
  httpRoutes: [],
});
const code = (value: PluginManifest) => `
import * as Effect from 'effect/Effect';
export default { manifest: ${JSON.stringify(value)}, start: Effect.succeed({}) };
`;

/** A stored tar.gz the installer's archive reader accepts without extra dependencies. */
const bundle = (value: PluginManifest) => {
  const files: Array<[string, Buffer]> = [
    ["manifest.json", Buffer.from(JSON.stringify(value))],
    ["plugin.mjs", Buffer.from(code(value))],
  ];
  const chunks: Buffer[] = [];
  for (const [name, data] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return NodeZlib.gzipSync(Buffer.concat(chunks));
};

const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const shopVersion = (value: PluginManifest, bytes: Uint8Array, sha256 = sha(bytes)) => ({
  version: value.version,
  bundleUrl: `https://github.com/p0code/shop-fixture/releases/download/v${value.version}/plugin.tgz`,
  sha256,
  capabilities: value.capabilities,
  sizeBytes: bytes.length,
  publishedAt: "2026-11-27T00:00:00.000Z",
});

const shopEntry = (
  value: PluginManifest,
  versions: ReadonlyArray<ReturnType<typeof shopVersion>>,
  extra: Partial<PluginShopCatalog["plugins"][number]> = {},
) => ({
  id: value.id,
  name: "Shop fixture",
  description: "A fixture from the shop.",
  longDescription: "The long description.",
  author: { name: "p0code" },
  repoUrl: `https://github.com/p0code/${value.id}`,
  license: "MIT",
  categories: ["productivity"],
  tags: ["fixture"],
  screenshotUrls: [],
  latestVersion: versions.at(-1)!.version,
  versions,
  source: "official" as const,
  verified: true,
  ...extra,
});

const catalog = (plugins: PluginShopCatalog["plugins"]): PluginShopCatalog => ({
  schemaVersion: 2,
  generatedAt: "2026-11-27T00:00:00.000Z",
  plugins,
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
      contextFor: () =>
        Effect.succeed(
          PluginContext.of({
            pluginId: "shop-fixture",
            dataDir: "/unused",
            reportStatus: () => Effect.void,
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
      PlatformCrypto.layer,
      FetchHttpClient.layer,
      Layer.succeed(PtyAdapter.PtyAdapter, { spawn: () => Effect.die("unused") }),
    ),
  ),
);
const bundled: Plugin = {
  manifest: manifest("1.0.0", [], "bundled"),
  start: Effect.die("unused"),
};
const testLayer = hostLayer.pipe(
  Layer.provide(Layer.succeed(BundledPlugins, { plugins: [bundled], failures: [] })),
  Layer.provide(bindings),
  Layer.provideMerge(
    Layer.mergeAll(
      layerTest(process.cwd(), { prefix: "p0-shop-" }),
      ServerSettingsService.layerTest(),
      secretLayer,
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer))),
  ),
);

const openShop = (installer: PluginInstaller["Service"], options: ShopOptions) =>
  makeShop(options).pipe(Effect.provideService(PluginInstaller, PluginInstaller.of(installer)));

const catalogFetch = (value: PluginShopCatalog) => async () => ({
  status: 200,
  etag: '"fixture"',
  body: JSON.stringify(value),
});

describe("plugin shop", () => {
  it.layer(testLayer)((it) => {
    it.effect("installs a catalog release through the real installer", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const installer = yield* makeInstaller();
        const value = manifest("1.0.0");
        const bytes = bundle(value);
        const shop = yield* openShop(installer, {
          catalogUrl: "https://shop.test/index.json",
          fetchCatalog: catalogFetch(catalog([shopEntry(value, [shopVersion(value, bytes)])])),
          downloadBundle: async () => bytes,
        });
        const list = yield* shop.list({});
        assert.equal(list.error, null);
        assert.equal(list.entries[0]?.installed, false);
        const staged = yield* shop.install({ id: value.id });
        assert.equal(staged.record.stagedVersion, "1.0.0");
        assert.equal(staged.record.activeVersion, null);
        assert.deepEqual(staged.record.versions[0]?.source, { kind: "catalog", id: value.id });
        yield* installer.consent({
          id: value.id,
          version: "1.0.0",
          capabilities: value.capabilities,
        });
        const after = yield* shop.list({});
        assert.equal(after.entries[0]?.installed, true);
        assert.equal(after.entries[0]?.installedVersion, "1.0.0");
        assert.equal(
          (yield* Effect.promise(() => readInstallRecord(stateDir, value.id)))?.activeVersion,
          "1.0.0",
        );
        yield* shop.uninstall({ id: value.id, purgeData: true });
        assert.deepEqual((yield* installer.list).installations[0]?.versions, []);
      }),
    );
    it.effect("refuses a checksum mismatch before writing anything", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const installer = yield* makeInstaller();
        const value = manifest("1.0.0", ["network:outbound"], "checksum-fixture");
        const bytes = bundle(value);
        const shop = yield* openShop(installer, {
          fetchCatalog: catalogFetch(
            catalog([shopEntry(value, [shopVersion(value, bytes, "b".repeat(64))])]),
          ),
          downloadBundle: async () => bytes,
        });
        assert.include(
          (yield* shop.install({ id: value.id }).pipe(Effect.flip)).message,
          "checksum",
        );
        assert.isNull(yield* Effect.promise(() => readInstallRecord(stateDir, value.id)));
      }),
    );
    it.effect("refuses a manifest whose capabilities differ from the entry", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const installer = yield* makeInstaller();
        const value = manifest("1.0.0", [], "capability-fixture");
        const bytes = bundle(value);
        const declared = {
          ...shopVersion(value, bytes),
          capabilities: ["network:outbound"] as PluginManifest["capabilities"],
        };
        const shop = yield* openShop(installer, {
          fetchCatalog: catalogFetch(catalog([shopEntry(value, [declared])])),
          downloadBundle: async () => bytes,
        });
        assert.include(
          (yield* shop.install({ id: value.id }).pipe(Effect.flip)).message,
          "capabilities do not match",
        );
        assert.isNull(yield* Effect.promise(() => readInstallRecord(stateDir, value.id)));
      }),
    );
    it.effect("detects updates and filters by search, category and installed", () =>
      Effect.gen(function* () {
        const installer = yield* makeInstaller();
        const one = manifest("1.0.0", ["network:outbound"], "update-fixture");
        const two = manifest("2.0.0", ["network:outbound"], "update-fixture");
        const other = manifest("0.1.0", [], "other-fixture");
        const oneBytes = bundle(one);
        const twoBytes = bundle(two);
        const otherBytes = bundle(other);
        let current = catalog([
          shopEntry(one, [shopVersion(one, oneBytes)]),
          shopEntry(other, [shopVersion(other, otherBytes)], {
            name: "Other thing",
            description: "A different plugin.",
            categories: ["developer"],
          }),
        ]);
        const shop = yield* openShop(installer, {
          fetchCatalog: async () => ({
            status: 200,
            etag: '"fixture"',
            body: JSON.stringify(current),
          }),
          downloadBundle: async (url) => (url.includes("other-fixture") ? otherBytes : twoBytes),
        });
        const search = yield* shop.list({ search: "other" });
        assert.deepEqual(
          search.entries.map((state) => state.entry.id),
          ["other-fixture"],
        );
        assert.deepEqual(
          (yield* shop.list({ category: "developer" })).entries.map((state) => state.entry.id),
          ["other-fixture"],
        );
        // Install the older release, then publish a newer one and expect an update badge.
        const firstShop = yield* openShop(installer, {
          fetchCatalog: catalogFetch(catalog([shopEntry(one, [shopVersion(one, oneBytes)])])),
          downloadBundle: async () => oneBytes,
        });
        yield* firstShop.install({ id: one.id });
        yield* installer.consent({
          id: one.id,
          version: "1.0.0",
          capabilities: one.capabilities,
        });
        current = catalog([
          shopEntry(one, [shopVersion(one, oneBytes), shopVersion(two, twoBytes)]),
          shopEntry(other, [shopVersion(other, otherBytes)], {
            name: "Other thing",
            description: "A different plugin.",
            categories: ["developer"],
          }),
        ]);
        yield* shop.refresh();
        const updated = yield* shop.list({ installedOnly: true });
        assert.deepEqual(
          updated.entries.map((state) => state.entry.id),
          ["update-fixture"],
        );
        assert.equal(updated.entries[0]?.updateAvailable, true);
        const staged = yield* shop.update({ id: one.id });
        assert.equal(staged.record.stagedVersion, "2.0.0");
        assert.include(
          (yield* shop.update({ id: one.id }).pipe(Effect.flip)).message,
          "already installed",
        );
      }),
    );
    it.effect("shows a readable error when the catalog is offline and keeps a stale cache", () =>
      Effect.gen(function* () {
        const installer = yield* makeInstaller();
        const value = manifest("1.0.0", [], "offline-fixture");
        const bytes = bundle(value);
        let offline = true;
        const shop = yield* openShop(installer, {
          fetchCatalog: async () => {
            if (offline) throw new Error("getaddrinfo ENOTFOUND");
            return {
              status: 200,
              etag: '"fixture"',
              body: JSON.stringify(catalog([shopEntry(value, [shopVersion(value, bytes)])])),
            };
          },
          downloadBundle: async () => bytes,
        });
        const cold = yield* shop.list({});
        assert.equal(cold.entries.length, 0);
        assert.include(cold.error ?? "", "could not be reached");
        offline = false;
        assert.equal((yield* shop.list({})).entries.length, 1);
        offline = true;
        const stale = yield* shop.refresh();
        assert.equal(stale.entries.length, 1);
        assert.equal(stale.stale, true);
        assert.include(stale.error ?? "", "could not be reached");
      }),
    );
    it.effect("skips entries that claim a publisher they do not have", () =>
      Effect.gen(function* () {
        const installer = yield* makeInstaller();
        const value = manifest("1.0.0", [], "unverified-fixture");
        const bytes = bundle(value);
        const shop = yield* openShop(installer, {
          fetchCatalog: catalogFetch(
            catalog([
              shopEntry(value, [shopVersion(value, bytes)], {
                verified: true,
                repoUrl: "https://github.com/not-p0code/unverified-fixture",
              }),
            ]),
          ),
          downloadBundle: async () => bytes,
        });
        const list = yield* shop.list({});
        assert.equal(list.entries.length, 0);
        assert.equal(list.skippedEntries, 1);
      }),
    );
  });
});
