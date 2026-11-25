import type { PluginManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";

const PREFIX = "plugin-route-secret-";
const secretName = (pluginId: string) => `${PREFIX}${pluginId}`;

export const routeSecret = Effect.fn("PluginRoutes.secret")(function* (pluginId: string) {
  const secrets = yield* ServerSecretStore;
  return base64UrlEncode(yield* secrets.getOrCreateRandom(secretName(pluginId), 32));
});

// Bundled plugins have no uninstall RPC: removal means the next build omits the plugin.
export const removeObsoleteRouteSecrets = Effect.fn("PluginRoutes.removeObsolete")(function* (
  plugins: ReadonlyArray<Pick<PluginManifest, "id" | "capabilities">>,
) {
  const secrets = yield* ServerSecretStore;
  if (secrets.list === undefined) return;
  const active = new Set(
    plugins
      .filter((plugin) => plugin.capabilities.includes("http:routes"))
      .map((plugin) => secretName(plugin.id)),
  );
  const names = yield* secrets.list(PREFIX);
  yield* Effect.forEach(
    names.filter((name) => !active.has(name)),
    (name) => secrets.remove(name),
    { discard: true },
  );
});
