import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { PluginHost } from "./PluginHost.ts";
import { bundledPlugins } from "./registry.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

const dispatch = (path: string) =>
  HttpRouter.add(
    "POST",
    `/${path.replace(/^\/+/u, "")}`,
    Effect.gen(function* () {
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
    }),
  );

/** Routes exist for every bundled plugin's declared paths and answer 404 while it is off. */
export const layer = bundledPlugins
  .flatMap((plugin) => plugin.manifest.httpRoutes.map(dispatch))
  .reduce<ReturnType<typeof dispatch>>((merged, route) => Layer.merge(merged, route), Layer.empty);
