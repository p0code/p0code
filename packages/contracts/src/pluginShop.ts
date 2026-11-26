import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginVersion } from "./pluginInstallation.ts";
import { PluginCapability, PluginId } from "./plugins.ts";

/** Bumped when a shop field changes meaning or is removed. */
const PLUGIN_SHOP_SCHEMA_VERSION = 2;

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One installable release of a shop plugin. `sha256` covers the archive at `bundleUrl`. */
export const PluginShopVersion = Schema.Struct({
  version: PluginVersion,
  bundleUrl: HttpsUrl,
  sha256: Sha256,
  /** The plugin API it targets. Absent means the API the host ships. */
  apiVersion: Schema.optionalKey(Schema.Int),
  capabilities: Schema.Array(PluginCapability),
  sizeBytes: NonNegativeInt,
  publishedAt: Schema.String,
  releaseNotesUrl: Schema.optionalKey(HttpsUrl),
});
export type PluginShopVersion = typeof PluginShopVersion.Type;

/**
 * Catalog metadata only. The host downloads the bundle, checks `sha256` and the manifest, and
 * asks for capability consent before any code runs; `verified` says the repo is p0code-owned,
 * not that anyone audited the code.
 */
export const PluginShopEntry = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  longDescription: Schema.optionalKey(Schema.String),
  author: Schema.Struct({
    name: TrimmedNonEmptyString,
    url: Schema.optionalKey(HttpsUrl),
  }),
  repoUrl: HttpsUrl,
  homepage: Schema.optionalKey(HttpsUrl),
  license: TrimmedNonEmptyString,
  categories: Schema.Array(TrimmedNonEmptyString),
  tags: Schema.Array(TrimmedNonEmptyString),
  iconUrl: Schema.optionalKey(HttpsUrl),
  screenshotUrls: Schema.Array(HttpsUrl),
  latestVersion: TrimmedNonEmptyString,
  versions: Schema.Array(PluginShopVersion),
  source: Schema.Literals(["official", "community"]),
  verified: Schema.Boolean,
});
export type PluginShopEntry = typeof PluginShopEntry.Type;

/** The file at the catalog URL, e.g. https://p0code.github.io/plugins-shop/index.json. */
export const PluginShopCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(PLUGIN_SHOP_SCHEMA_VERSION),
  generatedAt: Schema.String,
  plugins: Schema.Array(PluginShopEntry),
});
export type PluginShopCatalog = typeof PluginShopCatalog.Type;

export const PluginShopListInput = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  category: Schema.optionalKey(TrimmedNonEmptyString),
  installedOnly: Schema.optionalKey(Schema.Boolean),
});
export type PluginShopListInput = typeof PluginShopListInput.Type;

export const PluginShopEntryState = Schema.Struct({
  entry: PluginShopEntry,
  /** Best compatible release, or null when every release targets another API version. */
  selectedVersion: Schema.NullOr(PluginShopVersion),
  installedVersion: Schema.NullOr(Schema.String),
  installed: Schema.Boolean,
  active: Schema.Boolean,
  updateAvailable: Schema.Boolean,
  compatible: Schema.Boolean,
});
export type PluginShopEntryState = typeof PluginShopEntryState.Type;

export const PluginShopList = Schema.Struct({
  entries: Schema.Array(PluginShopEntryState),
  categories: Schema.Array(Schema.String),
  fetchedAt: Schema.NullOr(Schema.String),
  /** True when the last fetch failed and these entries came from the previous catalog. */
  stale: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  skippedEntries: NonNegativeInt,
});
export type PluginShopList = typeof PluginShopList.Type;

export const PluginShopEntryInput = Schema.Struct({ id: PluginId });
export type PluginShopEntryInput = typeof PluginShopEntryInput.Type;

export const PluginShopEntryResult = Schema.Struct({
  entry: Schema.NullOr(PluginShopEntryState),
  fetchedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type PluginShopEntryResult = typeof PluginShopEntryResult.Type;

export const PluginShopInstallInput = Schema.Struct({
  id: PluginId,
  version: Schema.optionalKey(PluginVersion),
});
export type PluginShopInstallInput = typeof PluginShopInstallInput.Type;

export const PluginShopUpdateInput = Schema.Struct({ id: PluginId });
export type PluginShopUpdateInput = typeof PluginShopUpdateInput.Type;

export const PluginShopUninstallInput = Schema.Struct({ id: PluginId, purgeData: Schema.Boolean });
export type PluginShopUninstallInput = typeof PluginShopUninstallInput.Type;

const versionParts = (version: string) => {
  const [main = "", ...pre] = version.replace(/^v/, "").split("-");
  const numbers = main.split(".").map((part) => Number.parseInt(part, 10));
  return {
    numbers: numbers.map((value) => (Number.isSafeInteger(value) ? value : 0)),
    prerelease: pre.flatMap((part) => part.split(".")),
  };
};

/** Orders dotted versions; `1.0.0` sorts above `1.0.0-beta`. */
export function comparePluginVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const one = a.prerelease[index];
    const two = b.prerelease[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numericOne = Number(one);
    const numericTwo = Number(two);
    if (Number.isSafeInteger(numericOne) && Number.isSafeInteger(numericTwo)) {
      if (numericOne !== numericTwo) return numericOne - numericTwo;
    } else if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

function isPluginShopVersionCompatible(version: PluginShopVersion, apiVersion: number): boolean {
  return version.apiVersion === undefined || version.apiVersion === apiVersion;
}

/** The newest release the host can run, independent of what is installed. */
export function selectPluginShopVersion(
  entry: PluginShopEntry,
  apiVersion: number,
): PluginShopVersion | null {
  let selected: PluginShopVersion | null = null;
  for (const version of entry.versions) {
    if (!isPluginShopVersionCompatible(version, apiVersion)) continue;
    if (selected === null || comparePluginVersions(version.version, selected.version) > 0)
      selected = version;
  }
  return selected;
}
