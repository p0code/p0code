import type { PluginManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { PluginHost } from "./PluginHost.ts";
import { bundledPlugins } from "./registry.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

const dispatch = Effect.fn("PluginHttp.dispatch")(function* (path: string) {
  const handler = yield* PluginHost.pipe(Effect.flatMap((host) => host.route(path)));
  if (handler === null) return HttpServerResponse.empty({ status: 404 });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const response = yield* handler(body).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Plugin route failed", { path, cause }).pipe(
        Effect.as({ status: 500, body: { message: "The plugin failed." } }),
      ),
    ),
  );
  return yield* HttpServerResponse.json(response.body, {
    status: response.status,
    headers: NO_STORE,
  });
});

/**
 * Mounts routes only for plugins that declare `http:routes`; a plugin listing paths without the
 * capability is refused here as well as when it starts. Routes answer 404 while the plugin is off.
 */
export const makeLayer = (
  plugins: ReadonlyArray<{
    readonly manifest: Pick<PluginManifest, "id" | "capabilities" | "httpRoutes">;
  }>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      for (const plugin of plugins) {
        if (!plugin.manifest.capabilities.includes("http:routes")) {
          if (plugin.manifest.httpRoutes.length > 0) {
            yield* Effect.logError(
              "Refusing to mount plugin routes: the manifest does not declare http:routes.",
              { plugin: plugin.manifest.id },
            );
          }
          continue;
        }
        for (const path of plugin.manifest.httpRoutes) {
          yield* router.add("POST", `/${path.replace(/^\/+/u, "")}`, dispatch(path));
        }
      }
    }),
  );

export const layer = makeLayer(bundledPlugins);
