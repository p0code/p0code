import { obsidianSharedMemory } from "@t3tools/plugin-obsidian-shared-memory";
import { t3ConnectBridge } from "@t3tools/plugin-t3-connect-bridge";
import { tokscaleAutoPublish } from "@t3tools/plugin-tokscale-auto-publish";
import * as Layer from "effect/Layer";

import { BundledPlugins } from "./PluginHost.ts";

/** First-party plugins shipped in this build. Nothing is loaded from disk. */
export const bundledPlugins = [t3ConnectBridge, obsidianSharedMemory, tokscaleAutoPublish];

export const layer = Layer.succeed(BundledPlugins, bundledPlugins);
