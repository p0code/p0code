import { backupPlugin } from "@t3tools/plugin-backup";
import { obsidianSharedMemory } from "@t3tools/plugin-obsidian-shared-memory";
import { t3ConnectBridge } from "@t3tools/plugin-t3-connect-bridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { InstalledPlugins, layerWith } from "./loader.ts";
import { BundledPlugins } from "./PluginHost.ts";

/** First-party plugins shipped in this build; installed ones join them from the plugin folder. */
const bundledPlugins = [backupPlugin, t3ConnectBridge, obsidianSharedMemory];

export const layer = Layer.effect(
  BundledPlugins,
  Effect.gen(function* () {
    const installed = yield* InstalledPlugins;
    return BundledPlugins.of({
      plugins: [...bundledPlugins, ...installed.plugins],
      failures: installed.failures,
    });
  }),
).pipe(Layer.provide(layerWith(bundledPlugins.map((plugin) => plugin.manifest.id))));
