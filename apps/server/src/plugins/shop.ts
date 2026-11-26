// @effect-diagnostics nodeBuiltinImport:off globalFetch:off processEnvInEffect:off globalDate:off -- The shop owns its HTTP boundary, clock and checksum.
import {
  comparePluginVersions,
  PluginOperationError,
  type PluginInstallationResult,
  PluginShopCatalog,
  PluginShopEntry,
  PluginShopEntryResult,
  type PluginShopEntryState,
  type PluginShopInstallInput,
  type PluginShopList,
  type PluginShopListInput,
  type PluginShopUninstallInput,
  type PluginShopUpdateInput,
  type PluginShopVersion,
  selectPluginShopVersion,
} from "@t3tools/contracts";
import { PLUGIN_API_VERSION } from "@t3tools/plugin-api";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { download, readArchive, type Bundle } from "./installSources.ts";
import * as PluginInstallerModule from "./installer.ts";

const DEFAULT_PLUGIN_SHOP_URL = "https://p0code.github.io/plugins-shop/index.json";

/** Repos whose publisher badge reads "verified"; a reviewed owner list, not an audit. */
const VERIFIED_OWNERS = new Set(["p0code"]);
const OFFICIAL_OWNERS = new Set(["p0code", "jsserve-org"]);

const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(PluginShopCatalog));

type CatalogResponse = {
  readonly status: number;
  readonly etag: string | null;
  readonly body: string;
};

export interface ShopOptions {
  readonly catalogUrl?: string;
  /** Returns 304 with an empty body when the ETag still matches. */
  readonly fetchCatalog?: (url: string, etag: string | null) => Promise<CatalogResponse>;
  readonly downloadBundle?: (url: string) => Promise<Uint8Array>;
}

const fetchCatalog: NonNullable<ShopOptions["fetchCatalog"]> = async (url, etag) => {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "p0code-plugin-shop",
      ...(etag ? { "if-none-match": etag } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.status === 304 ? "" : await response.text();
  if (response.status !== 304 && !response.ok)
    throw new Error(`The plugin shop answered HTTP ${response.status}.`);
  return { status: response.status, etag: response.headers.get("etag"), body };
};

interface Cache {
  readonly catalog: PluginShopCatalog;
  readonly etag: string | null;
  readonly fetchedAt: string;
  readonly cachedAt: number;
}

const CACHE_TTL_MS = 10 * 60_000;

const githubOwner = (repoUrl: string): string | null => {
  const url = new URL(repoUrl);
  if (url.hostname !== "github.com") return null;
  return url.pathname.split("/").filter(Boolean)[0] ?? null;
};

/** Problems that make a single entry unsafe to show, even in a well-formed catalog. */
const entryProblems = (entry: PluginShopEntry): string[] => {
  const problems: string[] = [];
  const versions = entry.versions.map((version) => version.version);
  if (new Set(versions).size !== versions.length) problems.push("repeats a version");
  if (!versions.includes(entry.latestVersion))
    problems.push("latestVersion is not one of its versions");
  const highest = [...versions].sort(comparePluginVersions).at(-1);
  if (highest !== undefined && comparePluginVersions(highest, entry.latestVersion) !== 0)
    problems.push("latestVersion is not its newest version");
  const owner = githubOwner(entry.repoUrl);
  if (owner === null) problems.push("repoUrl is not a GitHub repository");
  if (entry.source === "official" && !OFFICIAL_OWNERS.has(owner ?? ""))
    problems.push("claims official from a repo p0code does not own");
  if (entry.verified && !VERIFIED_OWNERS.has(owner ?? ""))
    problems.push("claims verification from a repo p0code does not own");
  return problems;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error.";

const offlineMessage = (error: unknown): string =>
  `The plugin shop could not be reached (${messageOf(error)}). Check the server's internet connection, then Refresh.`;

export const makeShop = Effect.fn("PluginShop.make")(function* (options: ShopOptions = {}) {
  const installer = yield* PluginInstallerModule.PluginInstaller;
  const catalogUrl =
    options.catalogUrl ?? process.env.P0CODE_PLUGIN_SHOP_URL ?? DEFAULT_PLUGIN_SHOP_URL;
  const fetchCatalogJson = options.fetchCatalog ?? fetchCatalog;
  const downloadBundle =
    options.downloadBundle ??
    ((url: string) =>
      download(url).catch(() => {
        throw new Error("The plugin bundle download failed. Check the release and retry.");
      }));
  let cache: Cache | null = null;
  let inflight: Promise<Cache> | null = null;

  type LoadOutcome =
    | { readonly ok: true; readonly cache: Cache }
    | { readonly ok: false; readonly error: string };

  const attempt = async (force: boolean, fetchedAt: string): Promise<LoadOutcome> => {
    try {
      return { ok: true, cache: await load(force, fetchedAt) };
    } catch (error) {
      return { ok: false, error: offlineMessage(error) };
    }
  };

  const load = async (force: boolean, fetchedAt: string): Promise<Cache> => {
    if (cache !== null && !force && Date.now() - cache.cachedAt < CACHE_TTL_MS) return cache;
    if (inflight !== null) return inflight;
    inflight = (async () => {
      const response = await fetchCatalogJson(catalogUrl, cache?.etag ?? null);
      if (response.status === 304) {
        if (cache === null) throw new Error("The catalog answered 304 without a cached copy.");
        const revalidated = { ...cache, cachedAt: Date.now() };
        cache = revalidated;
        return revalidated;
      }
      let catalog: PluginShopCatalog;
      try {
        catalog = decodeCatalog(response.body);
      } catch {
        throw new Error(
          "The plugin shop returned a catalog this version cannot read. Update p0code or ask the shop to publish schemaVersion 2.",
        );
      }
      const next: Cache = {
        catalog,
        etag: response.etag,
        fetchedAt,
        cachedAt: Date.now(),
      };
      cache = next;
      return next;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const states = (
    catalog: PluginShopCatalog,
    installed: ReadonlyArray<{
      readonly id: string;
      readonly activeVersion: string | null;
      readonly stagedVersion: string | null;
    }>,
  ) => {
    const byId = new Map(installed.map((record) => [record.id, record]));
    const entries: PluginShopEntryState[] = [];
    let skippedEntries = 0;
    for (const entry of catalog.plugins) {
      if (entryProblems(entry).length > 0) {
        skippedEntries += 1;
        continue;
      }
      const selected = selectPluginShopVersion(entry, PLUGIN_API_VERSION);
      const record = byId.get(entry.id);
      const installedVersion = record?.activeVersion ?? record?.stagedVersion ?? null;
      entries.push({
        entry,
        selectedVersion: selected,
        installedVersion,
        installed: record !== undefined && installedVersion !== null,
        active: record !== undefined && record.activeVersion === selected?.version,
        updateAvailable:
          selected !== null &&
          installedVersion !== null &&
          comparePluginVersions(selected.version, installedVersion) > 0,
        compatible: selected !== null,
      });
    }
    return { entries, skippedEntries };
  };

  const installedRecords = Effect.fn("PluginShop.installedRecords")(function* (): Effect.fn.Return<
    ReadonlyArray<{
      readonly id: string;
      readonly activeVersion: string | null;
      readonly stagedVersion: string | null;
    }>,
    never
  > {
    const listed = yield* installer.list.pipe(Effect.orElseSucceed(() => null));
    return listed?.installations ?? [];
  });

  const list = Effect.fn("PluginShop.list")(function* (
    input: PluginShopListInput,
    force = false,
  ): Effect.fn.Return<PluginShopList, never> {
    const installations = yield* installedRecords();
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* Effect.promise(() => attempt(force, fetchedAt));
    // Keep showing the previous catalog, with the failure beside it, rather than an empty shop.
    const loaded: Cache | null = outcome.ok ? outcome.cache : cache;
    const error: string | null = outcome.ok ? null : outcome.error;
    if (loaded === null)
      return {
        entries: [] as PluginShopEntryState[],
        categories: [] as string[],
        fetchedAt: null,
        stale: false,
        error,
        skippedEntries: 0,
      } satisfies PluginShopList;
    const computed = states(loaded.catalog, installations);
    const categories = [
      ...new Set(computed.entries.flatMap((state) => state.entry.categories)),
    ].sort();
    const search = input.search?.trim().toLowerCase() ?? "";
    const entries = computed.entries.filter((state) => {
      if (input.installedOnly && !state.installed) return false;
      if (input.category && !state.entry.categories.includes(input.category)) return false;
      if (!search) return true;
      return [
        state.entry.id,
        state.entry.name,
        state.entry.description,
        state.entry.longDescription ?? "",
        state.entry.author.name,
        ...state.entry.categories,
        ...state.entry.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
    return {
      entries,
      categories,
      fetchedAt: loaded.fetchedAt,
      stale: error !== null,
      error,
      skippedEntries: computed.skippedEntries,
    } satisfies PluginShopList;
  });

  const entry = Effect.fn("PluginShop.entry")(function* (
    id: string,
  ): Effect.fn.Return<PluginShopEntryResult, never> {
    const installations = yield* installedRecords();
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* Effect.promise(() => attempt(false, fetchedAt));
    if (!outcome.ok)
      return { entry: null, fetchedAt: cache?.fetchedAt ?? null, error: outcome.error };
    const loaded = outcome.cache;
    const found = loaded.catalog.plugins.find((plugin) => plugin.id === id);
    if (!found) return { entry: null, fetchedAt: loaded.fetchedAt, error: null };
    const computed = states({ ...loaded.catalog, plugins: [found] }, installations);
    const state = computed.entries[0];
    if (!state)
      return {
        entry: null,
        fetchedAt: loaded.fetchedAt,
        error: "This shop entry failed p0code's catalog checks.",
      };
    return { entry: state, fetchedAt: loaded.fetchedAt, error: null };
  });

  const requireEntry = Effect.fn("PluginShop.requireEntry")(function* (id: string) {
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* Effect.promise(() => attempt(false, fetchedAt));
    if (!outcome.ok)
      return yield* new PluginOperationError({ pluginId: id, message: outcome.error });
    const loaded = outcome.cache;
    const found = loaded.catalog.plugins.find((plugin) => plugin.id === id);
    if (!found)
      return yield* new PluginOperationError({
        pluginId: id,
        message: "This plugin is not in the shop catalog.",
      });
    const problems = entryProblems(found);
    if (problems.length > 0)
      return yield* new PluginOperationError({
        pluginId: id,
        message: `This shop entry is invalid: ${problems.join(", ")}.`,
      });
    return found;
  });

  const stage = Effect.fn("PluginShop.stage")(function* (
    shopEntry: PluginShopEntry,
    version: PluginShopVersion,
  ) {
    const id = shopEntry.id;
    const bytes = yield* Effect.tryPromise({
      try: () => downloadBundle(version.bundleUrl),
      catch: (error) => new PluginOperationError({ pluginId: id, message: messageOf(error) }),
    });
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== version.sha256)
      return yield* new PluginOperationError({
        pluginId: id,
        message: "Plugin bundle checksum mismatch. This version was not installed.",
      });
    const name = new URL(version.bundleUrl).pathname.split("/").at(-1) ?? "plugin.zip";
    const bundle: Bundle = yield* Effect.tryPromise({
      try: () => readArchive(bytes, name),
      catch: (error) => new PluginOperationError({ pluginId: id, message: messageOf(error) }),
    });
    return yield* installer.installBundle({
      bundle,
      origin: { kind: "catalog", id },
      expected: {
        id,
        version: version.version,
        capabilities: version.capabilities,
        ...(version.apiVersion === undefined ? {} : { apiVersion: version.apiVersion }),
      },
    });
  });

  const install = Effect.fn("PluginShop.install")(function* (
    input: PluginShopInstallInput,
  ): Effect.fn.Return<PluginInstallationResult, PluginOperationError> {
    const shopEntry = yield* requireEntry(input.id);
    const version =
      input.version === undefined
        ? selectPluginShopVersion(shopEntry, PLUGIN_API_VERSION)
        : (shopEntry.versions.find((item) => item.version === input.version) ?? null);
    if (version === null)
      return yield* new PluginOperationError({
        pluginId: input.id,
        message:
          input.version === undefined
            ? "No release of this plugin works with this p0code version. Update p0code or ask the author for a compatible release."
            : "That version is not in the shop catalog.",
      });
    if (version.apiVersion !== undefined && version.apiVersion !== PLUGIN_API_VERSION)
      return yield* new PluginOperationError({
        pluginId: input.id,
        message: "This release needs a different plugin API. Update p0code or the plugin.",
      });
    return yield* stage(shopEntry, version);
  });

  const update = Effect.fn("PluginShop.update")(function* (
    input: PluginShopUpdateInput,
  ): Effect.fn.Return<PluginInstallationResult, PluginOperationError> {
    const shopEntry = yield* requireEntry(input.id);
    const selected = selectPluginShopVersion(shopEntry, PLUGIN_API_VERSION);
    if (selected === null)
      return yield* new PluginOperationError({
        pluginId: input.id,
        message: "No release of this plugin works with this p0code version.",
      });
    const record = (yield* installedRecords()).find((item) => item.id === input.id);
    const installed = record?.activeVersion ?? record?.stagedVersion ?? null;
    if (installed !== null && comparePluginVersions(selected.version, installed) <= 0)
      return yield* new PluginOperationError({
        pluginId: input.id,
        message: "This plugin is already up to date.",
      });
    return yield* stage(shopEntry, selected);
  });

  const uninstall = Effect.fn("PluginShop.uninstall")(function* (input: PluginShopUninstallInput) {
    return yield* installer.remove(input);
  });

  return {
    list: (input: PluginShopListInput) => list(input, false),
    refresh: () => list({}, true),
    entry: (input: { readonly id: string }) => entry(input.id),
    install,
    update,
    uninstall,
    catalogUrl,
  };
});

export class PluginShop extends Context.Service<
  PluginShop,
  Effect.Success<ReturnType<typeof makeShop>>
>()("p0/plugins/shop/PluginShop") {}

export const layer = Layer.effect(PluginShop, makeShop()).pipe(
  Layer.provide(PluginInstallerModule.layer),
);
