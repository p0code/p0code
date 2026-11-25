import { type PluginCapability, PluginManifest, type PluginSettings } from "@t3tools/contracts";
import { PLUGIN_API_VERSION, type Plugin } from "@t3tools/plugin-api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  installedPluginVersionDir,
  installedPluginsRoot,
  isValidPluginId,
  isValidVersionSegment,
} from "./installedPaths.ts";

/**
 * One installed plugin the loader could not run, and why. It is surfaced in the plugin list as
 * failed so a broken install stays visible; nothing on disk is touched or removed.
 */
export interface FailedInstallation {
  readonly manifest: PluginManifest;
  readonly message: string;
}

export class InstalledPlugins extends Context.Service<
  InstalledPlugins,
  {
    /** Installed plugins whose code loaded. The host still only runs the enabled ones. */
    readonly plugins: ReadonlyArray<Plugin>;
    readonly failures: ReadonlyArray<FailedInstallation>;
  }
>()("p0/plugins/loader/InstalledPlugins") {}

const decodeManifestText = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const describeCause = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

/** Newest first: numeric when both versions are plain `1.2.3` shapes, otherwise by text. */
const compareVersions = (a: string, b: string): number => {
  const numeric = (version: string) => version.split(".").every((part) => /^\d+$/u.test(part));
  if (!numeric(a) || !numeric(b)) return b.localeCompare(a);
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** A stand-in manifest for an install whose manifest.json is unreadable, so it can still be listed. */
const unreadableManifest = (id: string, version: string | undefined): PluginManifest => ({
  id,
  name: id,
  description: "The manifest could not be read.",
  version: version ?? "0.0.0",
  unofficial: true,
  externalServices: [],
  capabilities: [],
  httpRoutes: [],
});

/**
 * Loads the plugins a person installed into `<stateDir>/installed-plugins/`, one folder per
 * version. A broken install is logged and surfaced as failed without blocking the others. Of
 * each plugin the newest consented version runs; if it does not load, the previous one does.
 * `bundledIds` refuses an installed copy of a plugin this build ships.
 */
export const layerWith = (bundledIds: ReadonlyArray<string>) =>
  Layer.effect(
    InstalledPlugins,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = yield* ServerSettings.ServerSettingsService;

      const readManifest = (dir: string) =>
        fileSystem
          .readFileString(path.join(dir, "manifest.json"))
          .pipe(Effect.flatMap(decodeManifestText), Effect.mapError(describeCause));

      const importPlugin = Effect.fn("plugins.loader.import")(function* (
        id: string,
        version: string,
        manifest: PluginManifest,
      ) {
        const dir = installedPluginVersionDir(path, config.stateDir, id, version);
        if (dir === undefined) {
          return yield* Effect.fail("The install folder name is not safe.");
        }
        const file = path.join(dir, "plugin.mjs");
        if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.fail("plugin.mjs is missing.");
        }
        // The version is the cache-buster: Node keeps a module by its URL, so re-importing a
        // version loads fresh code. The folder-name pattern keeps the query free of `?` and `/`.
        const module = yield* Effect.tryPromise({
          try: () => import(`${NodeURL.pathToFileURL(file).href}?v=${version}`),
          catch: (cause) => `plugin.mjs failed to load: ${describeCause(cause)}`,
        });
        const exported = (module as { default?: unknown }).default;
        if (
          typeof exported !== "object" ||
          exported === null ||
          !("manifest" in exported) ||
          !("start" in exported)
        ) {
          return yield* Effect.fail(
            "The default export is not a plugin. Export what definePlugin(…) returned.",
          );
        }
        const exportedManifest = (exported as { manifest?: unknown }).manifest;
        if (
          typeof exportedManifest !== "object" ||
          exportedManifest === null ||
          (exportedManifest as { id?: unknown }).id !== id
        ) {
          return yield* Effect.fail("manifest.json and plugin.mjs disagree about the plugin id.");
        }
        return {
          manifest,
          origin: "installed" as const,
          start: (exported as { start: Plugin["start"] }).start,
        } satisfies Plugin;
      });

      /** Scans one plugin folder. Loaded plugins come back; failures land in `failures`. */
      const scanPlugin = Effect.fn("plugins.loader.scan")(function* (
        id: string,
        consentedCapabilities: ReadonlyArray<PluginCapability>,
        failures: Array<FailedInstallation>,
      ) {
        const versions = (yield* fileSystem
          .readDirectory(path.join(installedPluginsRoot(path, config.stateDir), id))
          .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
          .filter(isValidVersionSegment)
          .sort((a, b) => compareVersions(b, a));
        if (versions.length === 0) {
          yield* Effect.logWarning(`Skipping plugin folder "${id}": it holds no version folder.`);
          return Option.none();
        }

        // The newest version wins unless it cannot run; then the previous one does. Versions
        // skipped for missing consent are not failures — they are updates waiting for it.
        let newestManifest: PluginManifest | undefined;
        let firstBlocker: { readonly version: string; readonly message: string } | undefined;
        const refused: Array<{ readonly version: string; readonly message: string }> = [];
        for (const version of versions) {
          const dir = installedPluginVersionDir(path, config.stateDir, id, version);
          if (dir === undefined) continue; // Unreachable: every listed version is a safe name.
          const refuse = (message: string, pendingConsent = false) => {
            firstBlocker ??= { version, message };
            if (!pendingConsent) refused.push({ version, message });
            return message;
          };
          const read = yield* readManifest(dir).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (manifest) => ({ ok: true as const, manifest }),
            }),
          );
          if (!read.ok) {
            refuse(`manifest.json could not be read: ${read.error}`);
            continue;
          }
          newestManifest ??= read.manifest;
          if (read.manifest.id !== id) {
            refuse(`manifest.json declares the plugin id "${read.manifest.id}".`);
            continue;
          }
          if (read.manifest.version !== version) {
            refuse(
              `manifest.json says version ${read.manifest.version}, but the folder is named ${version}.`,
            );
            continue;
          }
          if (
            read.manifest.apiVersion !== undefined &&
            read.manifest.apiVersion !== PLUGIN_API_VERSION
          ) {
            refuse(
              `it needs plugin API v${read.manifest.apiVersion}; this server speaks v${PLUGIN_API_VERSION}. Update p0code or the plugin.`,
            );
            continue;
          }
          const unconsented = read.manifest.capabilities.filter(
            (capability) => !consentedCapabilities.includes(capability),
          );
          if (unconsented.length > 0) {
            const message = refuse(
              `it declares ${unconsented.join(", ")}, which nobody has consented to yet.`,
              true,
            );
            yield* Effect.logWarning(
              `Plugin "${id}": version ${version} stays inactive: ${message}`,
            );
            continue;
          }
          const load = yield* importPlugin(id, version, read.manifest).pipe(
            Effect.match({
              onFailure: (message) => ({ ok: false as const, message }),
              onSuccess: (plugin) => ({ ok: true as const, plugin }),
            }),
          );
          if (!load.ok) {
            refuse(load.message);
            continue;
          }
          if (refused.length > 0) {
            const failed = refused[refused.length - 1]!;
            yield* Effect.logWarning(
              `Plugin "${id}": version ${failed.version} did not load (${failed.message}); running version ${version} instead.`,
            );
          }
          return Option.some(load.plugin);
        }

        const reason = firstBlocker ?? {
          version: versions[0]!,
          message: "it could not be loaded.",
        };
        yield* Effect.logWarning(
          `Plugin "${id}" stays off: version ${reason.version}, ${reason.message}`,
        );
        failures.push({
          manifest: newestManifest ?? unreadableManifest(id, versions[0]),
          message: `Version ${reason.version} is not active: ${reason.message}`,
        });
        return Option.none();
      });

      const root = installedPluginsRoot(path, config.stateDir);
      const ids = (
        (yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false)))
          ? yield* fileSystem
              .readDirectory(root)
              .pipe(Effect.orElseSucceed(() => [] as Array<string>))
          : []
      ).sort();
      const pluginSettings = yield* settings.getSettings.pipe(
        Effect.map((settings) => settings.plugins),
        Effect.orElseSucceed(() => ({}) as PluginSettings),
      );

      const failures: Array<FailedInstallation> = [];
      const plugins: Array<Plugin> = [];
      for (const id of ids) {
        if (bundledIds.includes(id)) {
          yield* Effect.logWarning(
            `Refusing the installed copy of plugin "${id}": it is built into this version of the server.`,
          );
          continue;
        }
        if (!isValidPluginId(id)) {
          yield* Effect.logWarning(`Skipping plugin folder "${id}": not a valid plugin id.`);
          continue;
        }
        const loaded = yield* scanPlugin(
          id,
          pluginSettings[id]?.consentedCapabilities ?? [],
          failures,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Scanning installed plugin "${id}" failed`, { cause }).pipe(
              Effect.as(Option.none<Plugin>()),
            ),
          ),
        );
        if (Option.isSome(loaded)) plugins.push(loaded.value);
      }

      return InstalledPlugins.of({ plugins, failures });
    }),
  );
