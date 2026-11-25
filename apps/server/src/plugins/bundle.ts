// @effect-diagnostics nodeBuiltinImport:off -- Dynamic ESM imports need file URLs; hash exact bundle bytes before importing.
import { PluginManifest } from "@t3tools/contracts";
import type { Plugin } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

export const importInstalledBundle = async (
  dir: string,
  manifest: PluginManifest,
  expectedSha256?: string,
): Promise<Plugin> => {
  const file = NodePath.join(dir, "plugin.mjs");
  const sha256 = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(file))
    .digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256)
    throw new Error("Installed bundle checksum mismatch.");
  const module: { default?: unknown } = await import(
    `${NodeURL.pathToFileURL(file).href}?v=${manifest.version}&sha256=${sha256}`
  );
  const exported = module.default;
  if (
    typeof exported !== "object" ||
    exported === null ||
    !("manifest" in exported) ||
    !("start" in exported) ||
    !Effect.isEffect(exported.start as Plugin["start"])
  )
    throw new Error("The default export must be a plugin.");
  const declared = decodeManifest(exported.manifest);
  if (!NodeUtil.isDeepStrictEqual(declared, manifest))
    throw new Error("Bundle and manifest.json disagree.");
  return { manifest, start: exported.start as Plugin["start"], origin: "installed" };
};
