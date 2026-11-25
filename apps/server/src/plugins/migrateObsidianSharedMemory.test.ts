import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { migrateObsidianSharedMemory } from "./migrateObsidianSharedMemory.ts";

const makeTestLayer = () => {
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-obsidian-migration-",
  });
  return Layer.mergeAll(
    configLayer,
    ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
    ServerSettings.ServerSettingsService.layerTest(),
  ).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)));
};

describe("migrateObsidianSharedMemory", () => {
  it.effect(
    "moves legacy files, rewrites default vault path, copies secret, and enables plugin idempotently",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const settings = yield* ServerSettings.ServerSettingsService;

        const oldVaultFolder = path.join(config.stateDir, "shared-memory", "dmF1bHQtMQ");
        const oldHomeDir = path.join(config.stateDir, "obsidian-headless-home");
        yield* fileSystem.makeDirectory(oldVaultFolder, { recursive: true });
        yield* fileSystem.makeDirectory(oldHomeDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(oldVaultFolder, "MEMORY.md"), "# Memory\n");
        yield* fileSystem.writeFileString(path.join(oldHomeDir, "marker"), "home");
        yield* fileSystem.writeFileString(
          path.join(config.stateDir, "shared-memory.json"),
          JSON.stringify({
            vault: "vault-1",
            folder: oldVaultFolder,
            enabled: true,
            paused: false,
            agentId: "agent-1",
          }),
        );
        yield* secrets.set(
          "obsidian-shared-memory-token",
          new TextEncoder().encode("secret-token"),
        );

        const args = { stateDir: config.stateDir, fileSystem, path, secrets, settings };
        yield* migrateObsidianSharedMemory(args);

        const pluginDir = path.join(config.stateDir, "plugins", "obsidian-shared-memory");
        const expectedVaultFolder = path.join(pluginDir, "shared-memory", "dmF1bHQtMQ");
        assert.isFalse(yield* fileSystem.exists(path.join(config.stateDir, "shared-memory.json")));
        assert.isFalse(yield* fileSystem.exists(oldHomeDir));
        assert.isFalse(yield* fileSystem.exists(path.join(config.stateDir, "shared-memory")));
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(expectedVaultFolder, "MEMORY.md")),
          "# Memory\n",
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(
            path.join(pluginDir, "obsidian-headless-home", "marker"),
          ),
          "home",
        );
        const migratedPrefs = JSON.parse(
          yield* fileSystem.readFileString(path.join(pluginDir, "shared-memory.json")),
        ) as { folder: string; vault: string; enabled: boolean; agentId: string };
        assert.strictEqual(migratedPrefs.folder, expectedVaultFolder);
        assert.strictEqual(migratedPrefs.vault, "vault-1");
        assert.strictEqual(migratedPrefs.enabled, true);
        assert.strictEqual(migratedPrefs.agentId, "agent-1");

        assert.isTrue(Option.isNone(yield* secrets.get("obsidian-shared-memory-token")));
        const copied = yield* secrets.get("plugin-obsidian-shared-memory-token");
        assert.isTrue(Option.isSome(copied));
        if (Option.isSome(copied)) {
          assert.strictEqual(new TextDecoder().decode(copied.value), "secret-token");
        }
        const afterFirst = yield* settings.getSettings;
        assert.strictEqual(afterFirst.plugins["obsidian-shared-memory"]?.enabled, true);

        // Disabling the plugin afterwards is preserved across subsequent startups.
        yield* settings.updateSettings({
          plugins: { "obsidian-shared-memory": { enabled: false } },
        });
        yield* migrateObsidianSharedMemory(args);
        const afterSecond = yield* settings.getSettings;
        assert.strictEqual(afterSecond.plugins["obsidian-shared-memory"]?.enabled, false);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("preserves custom vault folders outside stateDir", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const settings = yield* ServerSettings.ServerSettingsService;

      const customFolder = "/custom/obsidian/vault";
      yield* fileSystem.writeFileString(
        path.join(config.stateDir, "shared-memory.json"),
        JSON.stringify({
          vault: "vault-2",
          folder: customFolder,
          enabled: false,
          paused: true,
          agentId: "",
        }),
      );

      yield* migrateObsidianSharedMemory({
        stateDir: config.stateDir,
        fileSystem,
        path,
        secrets,
        settings,
      });

      const pluginDir = path.join(config.stateDir, "plugins", "obsidian-shared-memory");
      const migratedPrefs = JSON.parse(
        yield* fileSystem.readFileString(path.join(pluginDir, "shared-memory.json")),
      ) as { folder: string };
      assert.strictEqual(migratedPrefs.folder, customFolder);
      assert.strictEqual(
        (yield* settings.getSettings).plugins["obsidian-shared-memory"]?.enabled,
        true,
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("leaves unconfigured installs untouched even when an empty headless home exists", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const settings = yield* ServerSettings.ServerSettingsService;

      yield* fileSystem.makeDirectory(path.join(config.stateDir, "obsidian-headless-home"), {
        recursive: true,
      });

      yield* migrateObsidianSharedMemory({
        stateDir: config.stateDir,
        fileSystem,
        path,
        secrets,
        settings,
      });

      assert.isFalse(
        yield* fileSystem.exists(path.join(config.stateDir, "plugins", "obsidian-shared-memory")),
      );
      assert.isUndefined((yield* settings.getSettings).plugins["obsidian-shared-memory"]);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
