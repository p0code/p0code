import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  comparePluginVersions,
  PluginShopCatalog,
  selectPluginShopVersion,
  type PluginShopEntry,
} from "./pluginShop.ts";

const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(PluginShopCatalog));

const version = (value: string, apiVersion?: number): PluginShopEntry["versions"][number] => ({
  version: value,
  bundleUrl: `https://github.com/p0code/example/releases/download/v${value}/plugin.zip`,
  sha256: "a".repeat(64),
  ...(apiVersion === undefined ? {} : { apiVersion }),
  capabilities: ["network:outbound"],
  sizeBytes: 1024,
  publishedAt: "2026-11-27T00:00:00.000Z",
});

const entry = (
  versions: PluginShopEntry["versions"],
  latestVersion = versions.at(-1)!.version,
): PluginShopEntry => ({
  id: "example-plugin",
  name: "Example plugin",
  description: "An example.",
  author: { name: "p0code" },
  repoUrl: "https://github.com/p0code/example",
  license: "MIT",
  categories: ["productivity"],
  tags: ["example"],
  screenshotUrls: [],
  latestVersion,
  versions,
  source: "official",
  verified: true,
});

describe("plugin shop contracts", () => {
  it("decodes a catalog and rejects entries without a bundle checksum", () => {
    const catalog = {
      schemaVersion: 2,
      generatedAt: "2026-11-27T00:00:00.000Z",
      plugins: [entry([version("1.0.0")])],
    };
    expect(decodeCatalog(JSON.stringify(catalog)).plugins[0]?.id).toBe("example-plugin");
    expect(() =>
      decodeCatalog(
        JSON.stringify({
          ...catalog,
          plugins: [
            { ...entry([version("1.0.0")]), versions: [{ ...version("1.0.0"), sha256: "nope" }] },
          ],
        }),
      ),
    ).toThrow();
    expect(() => decodeCatalog(JSON.stringify({ ...catalog, schemaVersion: 1 }))).toThrow();
  });

  it("selects the newest release the host API can run", () => {
    const plugin = entry(
      [version("1.0.0"), version("1.2.0"), version("2.0.0", 99), version("1.1.0", 1)],
      "2.0.0",
    );
    expect(selectPluginShopVersion(plugin, 1)?.version).toBe("1.2.0");
    expect(selectPluginShopVersion(plugin, 99)?.version).toBe("2.0.0");
    expect(selectPluginShopVersion(entry([version("2.0.0", 99)], "2.0.0"), 1)).toBeNull();
  });

  it("orders pre-releases below their release", () => {
    expect(comparePluginVersions("1.10.0", "1.9.2")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(comparePluginVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});
