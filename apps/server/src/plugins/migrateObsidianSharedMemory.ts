import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as ServerSettings from "../serverSettings.ts";

const PLUGIN_ID = "obsidian-shared-memory";
const LEGACY_SECRET_NAME = "obsidian-shared-memory-token";
const PLUGIN_SECRET_NAME = `plugin-${PLUGIN_ID}-token`;

const LegacyPreferences = Schema.Struct({
  vault: Schema.String,
  folder: Schema.String,
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  agentId: Schema.String,
});
const decodePreferences = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyPreferences));
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(LegacyPreferences));

const rewriteDefaultVaultFolder = (
  path: Path.Path,
  folder: string,
  oldVaultRoot: string,
  newVaultRoot: string,
): string => {
  if (!folder) return folder;
  const relative = path.relative(oldVaultRoot, folder);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.join(newVaultRoot, relative);
  }
  return folder;
};

/**
 * One-time migration from the built-in `SharedMemorySync` layout in `<stateDir>` into the
 * `obsidian-shared-memory` plugin's data directory and secret namespace. Safe to re-run.
 */
export const migrateObsidianSharedMemory = Effect.fn("plugins.migrateObsidianSharedMemory")(
  function* (input: {
    readonly stateDir: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) {
    const { stateDir, fileSystem, path, secrets, settings } = input;
    const oldPrefsPath = path.join(stateDir, "shared-memory.json");
    const oldHomeDir = path.join(stateDir, "obsidian-headless-home");
    const oldVaultDir = path.join(stateDir, "shared-memory");
    const pluginDir = path.join(stateDir, "plugins", PLUGIN_ID);
    const newPrefsPath = path.join(pluginDir, "shared-memory.json");
    const newHomeDir = path.join(pluginDir, "obsidian-headless-home");
    const newVaultDir = path.join(pluginDir, "shared-memory");

    const hasLegacyPrefs = yield* fileSystem
      .exists(oldPrefsPath)
      .pipe(Effect.orElseSucceed(() => false));
    const legacyToken = yield* secrets
      .get(LEGACY_SECRET_NAME)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (!hasLegacyPrefs && Option.isNone(legacyToken)) return;

    yield* fileSystem.makeDirectory(pluginDir, { recursive: true });

    const moveIfAbsent = Effect.fnUntraced(function* (source: string, destination: string) {
      const sourceExists = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
      if (!sourceExists) return;
      const destinationExists = yield* fileSystem
        .exists(destination)
        .pipe(Effect.orElseSucceed(() => false));
      if (destinationExists) return;
      yield* fileSystem.rename(source, destination);
    });

    yield* moveIfAbsent(oldHomeDir, newHomeDir);
    yield* moveIfAbsent(oldVaultDir, newVaultDir);

    if (Option.isSome(legacyToken)) {
      const existingPluginToken = yield* secrets.get(PLUGIN_SECRET_NAME);
      if (Option.isNone(existingPluginToken)) {
        yield* secrets.set(PLUGIN_SECRET_NAME, legacyToken.value);
      }
      yield* secrets.remove(LEGACY_SECRET_NAME);
    }

    let configured = Option.isSome(legacyToken);
    if (hasLegacyPrefs) {
      const raw = yield* fileSystem.readFileString(oldPrefsPath);
      const parsed = decodePreferences(raw);
      let nextContent = raw;
      if (Option.isSome(parsed)) {
        const prefs = parsed.value;
        if (prefs.vault.trim().length > 0 || prefs.folder.trim().length > 0 || prefs.enabled) {
          configured = true;
        }
        const rewrittenFolder = rewriteDefaultVaultFolder(
          path,
          prefs.folder,
          oldVaultDir,
          newVaultDir,
        );
        if (rewrittenFolder !== prefs.folder) {
          nextContent = encodePreferences({ ...prefs, folder: rewrittenFolder });
        }
      }
      const hasNewPrefs = yield* fileSystem
        .exists(newPrefsPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasNewPrefs) {
        const tempPath = `${newPrefsPath}.migrate.tmp`;
        yield* fileSystem.writeFileString(tempPath, nextContent, { mode: 0o600 });
        yield* fileSystem.rename(tempPath, newPrefsPath);
      }
      yield* fileSystem.remove(oldPrefsPath, { force: true });
    }

    if (configured) {
      const current = yield* settings.getSettings;
      if (!Object.hasOwn(current.plugins, PLUGIN_ID)) {
        yield* settings.updateSettings({ plugins: { [PLUGIN_ID]: { enabled: true } } });
      }
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not migrate legacy Obsidian shared memory data", { cause }),
  ),
);
