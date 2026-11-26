import { PluginId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";

/**
 * Where installed plugin code lives: `<stateDir>/installed-plugins/<id>/<version>/`, holding a
 * `manifest.json` and a prebuilt `plugin.mjs`. Deliberately a sibling of, never inside, the
 * per-plugin data directory (`<stateDir>/plugins/<id>`): code is disposable, plugin data is not,
 * and removing code must never risk removing data.
 */

export const isValidPluginId = Schema.is(PluginId);

/**
 * A version folder name. The first character must be alphanumeric, so names like `..`, `.staging`
 * or anything carrying a path separator can never point outside the plugin's own folder.
 */
const versionSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isValidVersionSegment = (segment: string): boolean =>
  segment !== "installed.json" && versionSegmentPattern.test(segment);

export const installedPluginsRoot = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "installed-plugins");

/** The folder holding one installed version, or undefined when `id` or `version` is not safe. */
export const installedPluginVersionDir = (
  path: Path.Path,
  stateDir: string,
  id: string,
  version: string,
): string | undefined =>
  isValidPluginId(id) && isValidVersionSegment(version)
    ? path.join(stateDir, "installed-plugins", id, version)
    : undefined;
