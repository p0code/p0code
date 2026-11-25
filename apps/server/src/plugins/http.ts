import type { PluginManifest } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { API_MAX_BODY_BYTES } from "../http.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import { requestUrl } from "../requestUrl.ts";
import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import { BundledPlugins, PluginHost } from "./PluginHost.ts";
import * as Headers from "effect/http/Headers";
import * as UrlParams from "effect/http/UrlParams";
import { layer as pluginRegistryLayer } from "./registry.ts";
import { removeObsoleteRouteSecrets, routeSecret } from "./routeSecret.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const ROUTE_SECRET_HEADER = "x-p0code-plugin-route-secret";

// Provide outside HttpRouter.serve so its logger and root request spans share these names.
export const layerSecretRedaction = Layer.mergeAll(
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.map(Headers.CurrentRedactedNames, (names) => [...names, ROUTE_SECRET_HEADER]),
  ),
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    Effect.map(UrlParams.CurrentRedactedNames, (names) => [...names, "p0_route"]),
  ),
);

const forbidden = () =>
  HttpServerResponse.json(
    { message: "This plugin route is not open to that caller." },
    { status: 403, headers: NO_STORE },
  );

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const hostHeader = (request: HttpServerRequest.HttpServerRequest) => {
  const value = request.headers["x-forwarded-host"] ?? request.headers.host;
  return value?.split(",")[0]?.trim().toLowerCase();
};

/**
 * Same-origin means the origin this request reached, matching how OAuth and pairing decide it
 * behind Tailscale and tunnels. Desktop renderer origins are the p0code UI too.
 */
const isUiOrigin = (request: HttpServerRequest.HttpServerRequest, origin: string): boolean => {
  if ((DESKTOP_RENDERER_ORIGINS as ReadonlyArray<string>).includes(origin)) return true;
  // Browsers set this for a same-origin POST even when a proxy hides the public host.
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  const reached = Option.getOrUndefined(requestUrl(request));
  if (reached !== undefined && origin === reached.origin) return true;
  try {
    const host = new URL(origin).host.toLowerCase();
    return host.length > 0 && host === hostHeader(request);
  } catch {
    return false;
  }
};

/**
 * Plugin routes are host-guarded, not plugin-guarded: a caller must be the p0code UI (same
 * origin) or present the route secret, and every body is capped like the HttpApi routes.
 */
const route = Effect.fn("PluginHttp.route")(function* (
  path: string,
  secret: string,
  pluginId: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 404 });
  const handler = yield* PluginHost.pipe(Effect.flatMap((host) => host.route(path, pluginId)));
  if (handler === null) return HttpServerResponse.empty({ status: 404 });
  const url = Option.getOrUndefined(requestUrl(request));
  const querySecret = url?.searchParams.get("p0_route");
  url?.searchParams.delete("p0_route");
  const sanitized = request.modify({
    url: url === undefined ? path : `${url.pathname}${url.search}`,
    headers: Headers.remove(request.headers, ROUTE_SECRET_HEADER),
  });
  const secretHeader = request.headers[ROUTE_SECRET_HEADER];
  const origin = request.headers.origin;
  const allowed =
    (secretHeader !== undefined && timingSafeEqualBase64Url(secretHeader, secret)) ||
    (querySecret != null && timingSafeEqualBase64Url(querySecret, secret)) ||
    (origin !== undefined && isUiOrigin(request, origin));
  if (!allowed) return yield* forbidden();
  const raw = yield* sanitized.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(API_MAX_BODY_BYTES)),
  );
  const nonempty = raw.trim().length > 0;
  if (
    nonempty &&
    sanitized.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return HttpServerResponse.empty({ status: 415 });
  const decoded = nonempty ? decodeJson(raw) : Option.some(null);
  if (Option.isNone(decoded)) return HttpServerResponse.empty({ status: 400 });
  const body = decoded.value;
  const response = yield* handler(body).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, sanitized),
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
export const makeLayer = <R>(
  plugins: ReadonlyArray<{
    readonly manifest: Pick<PluginManifest, "id" | "capabilities" | "httpRoutes">;
  }>,
  secretFor: (pluginId: string) => Effect.Effect<string, never, R>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const dispatch = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = Option.getOrUndefined(requestUrl(request))?.pathname;
        if (!pathname || request.method !== "POST")
          return HttpServerResponse.empty({ status: 404 });
        const host = yield* PluginHost;
        const snapshot = yield* host.snapshot;
        const candidates = [
          ...snapshot.plugins.filter((plugin) => plugin.state === "running"),
          ...plugins,
        ];
        const owner = candidates.find(
          (plugin) =>
            plugin.manifest.capabilities.includes("http:routes") &&
            plugin.manifest.httpRoutes.includes(pathname),
        );
        if (!owner) return HttpServerResponse.empty({ status: 404 });
        const secret = yield* secretFor(owner.manifest.id);
        return yield* route(pathname, secret, owner.manifest.id);
      });
      yield* router.add("*", "/api/*", dispatch);
      yield* router.add("*", "/api", HttpServerResponse.empty({ status: 404 }));
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const hosted = yield* BundledPlugins;
    yield* removeObsoleteRouteSecrets(hosted.plugins.map((plugin) => plugin.manifest)).pipe(
      Effect.orDie,
    );
    return makeLayer([], (id) => routeSecret(id).pipe(Effect.orDie));
  }),
).pipe(Layer.provide(pluginRegistryLayer));
