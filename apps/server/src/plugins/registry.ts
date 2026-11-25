import { backupPlugin } from "@t3tools/plugin-backup";
import { obsidianSharedMemory } from "@t3tools/plugin-obsidian-shared-memory";
import { t3ConnectBridge } from "@t3tools/plugin-t3-connect-bridge";
import * as Layer from "effect/Layer";

import { BundledPlugins } from "./PluginHost.ts";

/** First-party plugins shipped in this build. Nothing is loaded from disk. */
export const bundledPlugins = [backupPlugin, t3ConnectBridge, obsidianSharedMemory];

export const layer = Layer.succeed(BundledPlugins, bundledPlugins);
