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
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, timingSafeEqualBase64Url } from "../auth/utils.ts";
import { PluginHost } from "./PluginHost.ts";
import { bundledPlugins } from "./registry.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const ROUTE_SECRET_NAME = "plugin-route-secret";
const ROUTE_SECRET_HEADER = "x-p0code-plugin-route-secret";

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
const route = Effect.fn("PluginHttp.route")(function* (path: string, secret: string) {
  const handler = yield* PluginHost.pipe(Effect.flatMap((host) => host.route(path)));
  if (handler === null) return HttpServerResponse.empty({ status: 404 });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const secretHeader = request.headers[ROUTE_SECRET_HEADER];
  const origin = request.headers.origin;
  const allowed =
    (secretHeader !== undefined && timingSafeEqualBase64Url(secretHeader, secret)) ||
    (origin !== undefined && isUiOrigin(request, origin));
  if (!allowed) return yield* forbidden();
  const raw = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(API_MAX_BODY_BYTES)),
  );
  const body = raw.trim().length === 0 ? null : Option.getOrNull(decodeJson(raw));
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

/** Routes exist for every bundled plugin's declared paths and answer 404 while it is off. */
export const makeLayer = (
  plugins: ReadonlyArray<{ readonly manifest: Pick<PluginManifest, "httpRoutes"> }>,
  secret: string,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      for (const plugin of plugins) {
        for (const path of plugin.manifest.httpRoutes) {
          yield* router.add("POST", `/${path.replace(/^\/+/u, "")}`, route(path, secret));
        }
      }
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const secret = yield* secrets
      .getOrCreateRandom(ROUTE_SECRET_NAME, 32)
      .pipe(Effect.map(base64UrlEncode), Effect.orDie);
    return makeLayer(bundledPlugins, secret);
  }),
);
