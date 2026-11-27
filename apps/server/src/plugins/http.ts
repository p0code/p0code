import {
  AuthRelayConfigureScope,
  pluginHttpRouteAuth,
  pluginHttpRoutePath,
  type PluginHttpRouteAuth,
  type PluginManifest,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { API_MAX_BODY_BYTES } from "../http.ts";
import { requestUrl } from "../requestUrl.ts";
import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import { BundledPlugins, PluginHost } from "./PluginHost.ts";
import * as Headers from "effect/http/Headers";
import * as UrlParams from "effect/http/UrlParams";
import { layer as pluginRegistryLayer } from "./registry.ts";
import { removeObsoleteRouteSecrets, routeSecret } from "./routeSecret.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const ROUTE_SECRET_HEADER = "x-p0code-plugin-route-secret";
const PLUGIN_HTTP_REQUIRED_SCOPE = AuthRelayConfigureScope;

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

const authenticateSessionRoute = Effect.fn("PluginHttp.authenticateSession")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(PLUGIN_HTTP_REQUIRED_SCOPE)) {
    return yield* failEnvironmentScopeRequired(PLUGIN_HTTP_REQUIRED_SCOPE);
  }
  return session;
});

/**
 * Plugin routes are host-guarded, not plugin-guarded: routes default to `auth: "session"` (an
 * authenticated owner session with plugin management scope, or the per-plugin route secret). Only
 * routes explicitly declared `auth: "none"` in the manifest are reachable unauthenticated. Every
 * body is capped like the HttpApi routes.
 */
const route = Effect.fn("PluginHttp.route")(function* (
  path: string,
  secret: string,
  pluginId: string,
  routeAuth: PluginHttpRouteAuth,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 404 });
  const handler = yield* PluginHost.pipe(Effect.flatMap((host) => host.route(path, pluginId)));
  if (handler === null) return HttpServerResponse.empty({ status: 404 });
  const url = Option.getOrUndefined(requestUrl(request));
  const querySecret = url?.searchParams.get("p0_route");
  url?.searchParams.delete("p0_route");
  let sanitizedHeaders = Headers.remove(request.headers, ROUTE_SECRET_HEADER);
  if (routeAuth !== "none") {
    sanitizedHeaders = Headers.remove(Headers.remove(sanitizedHeaders, "authorization"), "cookie");
  }
  const sanitized = request.modify({
    url: url === undefined ? path : `${url.pathname}${url.search}`,
    headers: sanitizedHeaders,
  });
  const secretHeader = request.headers[ROUTE_SECRET_HEADER];
  const hasSecretAttempt = secretHeader !== undefined || querySecret != null;
  const hasValidSecret =
    (secretHeader !== undefined && timingSafeEqualBase64Url(secretHeader, secret)) ||
    (querySecret != null && timingSafeEqualBase64Url(querySecret, secret));
  if (routeAuth !== "none" && !hasValidSecret) {
    if (hasSecretAttempt) return yield* forbidden();
    const usesDpop = /^DPoP /i.test(request.headers.authorization ?? "");
    const authFailure = yield* authenticateSessionRoute().pipe(
      Effect.as(null),
      Effect.catchTags({
        EnvironmentAuthInvalidError: (error) =>
          HttpServerRespondable.toResponse(error).pipe(
            Effect.map((response) =>
              HttpServerResponse.setHeaders(response, {
                ...NO_STORE,
                ...(usesDpop ? { "www-authenticate": "DPoP" } : {}),
              }),
            ),
          ),
        EnvironmentScopeRequiredError: (error) =>
          HttpServerRespondable.toResponse(error).pipe(
            Effect.map((response) => HttpServerResponse.setHeaders(response, NO_STORE)),
          ),
        EnvironmentInternalError: (error) =>
          HttpServerRespondable.toResponse(error).pipe(
            Effect.map((response) => HttpServerResponse.setHeaders(response, NO_STORE)),
          ),
      }),
    );
    if (authFailure !== null) return authFailure;
  }
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
            plugin.manifest.httpRoutes.some((entry) => pluginHttpRoutePath(entry) === pathname),
        );
        if (!owner) return HttpServerResponse.empty({ status: 404 });
        const matchingRoutes = owner.manifest.httpRoutes.filter(
          (entry) => pluginHttpRoutePath(entry) === pathname,
        );
        const routeAuth: PluginHttpRouteAuth =
          matchingRoutes.length > 0 &&
          matchingRoutes.every((entry) => pluginHttpRouteAuth(entry) === "none")
            ? "none"
            : "session";
        const secret = yield* secretFor(owner.manifest.id);
        return yield* route(pathname, secret, owner.manifest.id, routeAuth);
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
