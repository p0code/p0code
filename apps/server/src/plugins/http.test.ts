import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeClientScopes,
  AuthRelayConfigureScope,
  AuthStandardClientScopes,
  guestSessionCookieName,
  type PluginManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { PluginHost } from "./PluginHost.ts";
import { layerSecretRedaction, makeLayer } from "./http.ts";

const SECRET = "route-secret-for-tests";
const ROUTE = "/api/test/ping";
const PUBLIC_ROUTE = "/api/public/webhook";
const MIXED_ROUTE = "/api/mixed/ping";
const DEV_TOKEN = "reusable-dev-auth-token-for-plugin-http-tests";

const manifest = (
  id: string,
  capabilities: PluginManifest["capabilities"],
  httpRoutes: PluginManifest["httpRoutes"],
): PluginManifest => ({
  id,
  name: id,
  description: "Test plugin.",
  version: "1.0.0",
  unofficial: false,
  externalServices: [],
  capabilities,
  httpRoutes,
});

let lastHandlerHeaders: Record<string, string | undefined> | undefined;

const host = PluginHost.of({
  changes: Stream.empty,
  snapshot: Effect.succeed({ plugins: [] }),
  replace: () => Effect.void,
  setEnabled: () => Effect.die("unused"),
  invoke: () => Effect.die("unused"),
  route: (path) =>
    Effect.succeed(
      path === ROUTE || path === "/api/other/ping" || path === PUBLIC_ROUTE || path === MIXED_ROUTE
        ? () =>
            Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
              Effect.tap((request) =>
                Effect.sync(() => {
                  lastHandlerHeaders = Option.isSome(request)
                    ? {
                        authorization: request.value.headers.authorization,
                        cookie: request.value.headers.cookie,
                        secret: request.value.headers["x-p0code-plugin-route-secret"],
                      }
                    : undefined;
                }),
              ),
              Effect.as({ status: 200, body: { pong: true } }),
            )
        : null,
    ),
  agentInstructions: Effect.succeed([]),
  deployProviders: Effect.succeed([]),
});

interface TestCredentials {
  readonly cookieName: string;
  readonly ownerCookie: string;
  readonly ownerBearer: string;
  readonly nonOwnerCookie: string;
  readonly nonOwnerBearer: string;
}

const DEFAULT_PLUGINS: ReadonlyArray<{ readonly manifest: PluginManifest }> = [
  { manifest: manifest("test", ["http:routes"], [ROUTE]) },
  { manifest: manifest("other", ["http:routes"], ["/api/other/ping"]) },
  {
    manifest: manifest("public-hook", ["http:routes"], [{ path: PUBLIC_ROUTE, auth: "none" }]),
  },
  {
    manifest: manifest(
      "mixed",
      ["http:routes"],
      [{ path: MIXED_ROUTE, auth: "none" }, MIXED_ROUTE],
    ),
  },
  { manifest: manifest("no-capability", [], ["/api/no-capability/ping"]) },
  {
    manifest: manifest(
      "no-capability-public",
      [],
      [{ path: "/api/no-capability/public", auth: "none" }],
    ),
  },
];

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const makeServer = async (
  plugins: ReadonlyArray<{ readonly manifest: PluginManifest }> = DEFAULT_PLUGINS,
  logs?: Array<string>,
) => {
  const logger = Logger.layer(
    [
      Logger.make((entry) => {
        logs?.push(Logger.formatJson.log(entry));
      }),
    ],
    { mergeWithExisting: false },
  );

  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "p0-plugin-http-test-" })));

  const layerBase = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
    Layer.provide(layerBase),
  );

  let credentials!: TestCredentials;
  const seedCredentials = Layer.effectDiscard(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browserClient = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };
      const ownerBrowser = yield* auth.createBrowserSession(DEV_TOKEN, browserClient);
      const ownerToken = yield* auth.issueSession({
        scopes: AuthAdministrativeClientScopes,
        label: "owner-bearer",
      });
      const pairing = yield* auth.createPairingLink({
        scopes: AuthStandardClientScopes,
        label: "paired-browser",
      });
      const nonOwnerBrowser = yield* auth.createBrowserSession(pairing.credential, browserClient);
      const nonOwnerToken = yield* auth.issueSession({
        scopes: AuthStandardClientScopes,
        label: "paired-bearer",
      });
      const cookieName = ownerBrowser.cookieName ?? sessions.cookieName;
      credentials = {
        cookieName,
        ownerCookie: `${cookieName}=${ownerBrowser.sessionToken}`,
        ownerBearer: ownerToken.token,
        nonOwnerCookie: `${sessions.cookieName}=${nonOwnerBrowser.sessionToken}`,
        nonOwnerBearer: nonOwnerToken.token,
      };
    }),
  );

  const layer = Layer.mergeAll(
    makeLayer(plugins, (id) => Effect.succeed(id === "test" ? SECRET : "other-secret")),
    seedCredentials,
  ).pipe(
    Layer.provideMerge(Layer.succeed(PluginHost, host)),
    Layer.provideMerge(layerAuth),
    Layer.provideMerge(layerSecretRedaction),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(Layer.provideMerge(layerBase), Layer.provideMerge(Etag.layerWeak)),
    ),
    Layer.provideMerge(logger),
    Layer.provide(layerBase),
  );

  const { handler, dispose } = HttpRouter.toWebHandler(layer, {
    disableLogger: logs === undefined,
  });
  disposers.push(dispose);
  // Trigger lazy layer build so seeded credentials are ready before requests.
  await handler(new Request("http://127.0.0.1/api", { method: "GET" }));
  return { handler, credentials };
};

const post = (
  handler: (request: Request) => Promise<Response>,
  headers: Record<string, string> = {},
  body = "{}",
  query = "",
  path = ROUTE,
) =>
  handler(
    new Request(`http://127.0.0.1${path}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

const sameOrigin = { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" };

describe("plugin routes", () => {
  it("rejects unauthenticated requests even with spoofed UI or same-origin headers", async () => {
    const { handler } = await makeServer();
    for (const headers of [
      { origin: "p0code://app" },
      { origin: "p0code-dev://app" },
      { origin: "t3code://app" },
      sameOrigin,
      { origin: "http://127.0.0.1", host: "127.0.0.1" },
      { origin: "https://spoofed.example", "x-forwarded-host": "spoofed.example" },
      { origin: "https://evil.example" },
      {},
    ]) {
      const response = await post(handler, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("allows an authenticated owner session via cookie or bearer token", async () => {
    const { handler, credentials } = await makeServer();

    const sameOriginCookie = await post(handler, {
      ...sameOrigin,
      cookie: credentials.ownerCookie,
    });
    expect(sameOriginCookie.status).toBe(200);
    expect(await sameOriginCookie.json()).toEqual({ pong: true });
    expect(lastHandlerHeaders?.cookie).toBeUndefined();

    const desktopOriginCookie = await post(handler, {
      origin: "p0code://app",
      cookie: credentials.ownerCookie,
    });
    expect(desktopOriginCookie.status).toBe(200);
    expect(await desktopOriginCookie.json()).toEqual({ pong: true });

    const bearer = await post(handler, {
      authorization: `Bearer ${credentials.ownerBearer}`,
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual({ pong: true });
    expect(lastHandlerHeaders?.authorization).toBeUndefined();
  });

  it("rejects non-owner and guest sessions even from the app origin", async () => {
    const { handler, credentials } = await makeServer();

    const nonOwnerCookie = await post(handler, {
      ...sameOrigin,
      cookie: credentials.nonOwnerCookie,
    });
    expect(nonOwnerCookie.status).toBe(403);
    expect(await nonOwnerCookie.json()).toMatchObject({
      code: "insufficient_scope",
      requiredPermission: AuthRelayConfigureScope,
    });

    const nonOwnerBearer = await post(handler, {
      authorization: `Bearer ${credentials.nonOwnerBearer}`,
    });
    expect(nonOwnerBearer.status).toBe(403);
    expect(await nonOwnerBearer.json()).toMatchObject({
      code: "insufficient_scope",
      requiredPermission: AuthRelayConfigureScope,
    });

    const guestCookie = await post(handler, {
      ...sameOrigin,
      cookie: `${guestSessionCookieName("share-1")}=guest-session-token`,
    });
    expect(guestCookie.status).toBe(401);
  });

  it("enforces CSRF origin checks on cookie-authenticated session requests", async () => {
    const { handler, credentials } = await makeServer();

    expect(
      (
        await post(handler, {
          origin: "https://evil.example",
          cookie: credentials.ownerCookie,
        })
      ).status,
    ).toBe(401);

    expect(
      (
        await post(handler, {
          origin: "null",
          cookie: credentials.ownerCookie,
        })
      ).status,
    ).toBe(401);

    expect(
      (
        await post(handler, {
          "sec-fetch-site": "cross-site",
          cookie: credentials.ownerCookie,
        })
      ).status,
    ).toBe(401);

    expect(
      (
        await post(handler, {
          "sec-fetch-site": "same-site",
          cookie: credentials.ownerCookie,
        })
      ).status,
    ).toBe(401);
  });

  it("allows routes explicitly declared auth: none without a session or route secret", async () => {
    const { handler } = await makeServer();

    const originless = await post(handler, {}, "{}", "", PUBLIC_ROUTE);
    expect(originless.status).toBe(200);
    expect(await originless.json()).toEqual({ pong: true });

    const crossOrigin = await post(
      handler,
      { origin: "https://webhook.example" },
      "{}",
      "",
      PUBLIC_ROUTE,
    );
    expect(crossOrigin.status).toBe(200);
    expect(await crossOrigin.json()).toEqual({ pong: true });

    // A route declared both public and session fails closed to session auth.
    expect((await post(handler, {}, "{}", "", MIXED_ROUTE)).status).toBe(401);
    expect((await post(handler, { origin: "p0code://app" }, "{}", "", MIXED_ROUTE)).status).toBe(
      401,
    );

    // Public routes still require the http:routes capability.
    expect((await post(handler, {}, "{}", "", "/api/no-capability/public")).status).toBe(404);
  });

  it("does not mount a listed path without the http:routes capability", async () => {
    const { handler, credentials } = await makeServer([
      { manifest: manifest("test", [], [ROUTE]) },
    ]);
    const response = await post(handler, {
      ...sameOrigin,
      cookie: credentials.ownerCookie,
    });
    expect(response.status).toBe(404);
  });

  it("refuses a wrong route secret even alongside an owner cookie", async () => {
    const { handler, credentials } = await makeServer();
    expect((await post(handler, { "x-p0code-plugin-route-secret": "wrong" })).status).toBe(403);
    expect((await post(handler, {}, "{}", "?p0_route=wrong")).status).toBe(403);
    expect(
      (
        await post(handler, {
          ...sameOrigin,
          cookie: credentials.ownerCookie,
          "x-p0code-plugin-route-secret": "wrong",
        })
      ).status,
    ).toBe(403);
  });

  it("accepts a caller presenting the plugin route secret", async () => {
    const { handler } = await makeServer();
    const response = await post(handler, { "x-p0code-plugin-route-secret": SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });

  it("accepts a query secret only on a declared route", async () => {
    const { handler } = await makeServer();
    expect((await post(handler, {}, "{}", `?p0_route=${SECRET}`)).status).toBe(200);
    const response = await handler(
      new Request(`http://127.0.0.1/api/test/missing?p0_route=${SECRET}`, {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
    expect(
      (
        await handler(
          new Request(`http://127.0.0.1/api/other/ping?p0_route=${SECRET}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1/api/other/ping?p0_route=other-secret", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handler(
          new Request(`http://127.0.0.1/api/no-capability/ping?p0_route=${SECRET}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("keeps header and query secrets out of request logs and errors", async () => {
    const logs: Array<string> = [];
    const { handler } = await makeServer(DEFAULT_PLUGINS, logs);
    const response = await post(
      handler,
      { "x-p0code-plugin-route-secret": SECRET },
      "x".repeat(1024 * 1024 + 1),
      `?p0_route=${SECRET}`,
    );
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(SECRET);
    const missing = await handler(
      new Request(`http://127.0.0.1/undeclared?p0_route=${SECRET}`, { method: "POST" }),
    );
    expect(missing.status).toBe(404);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("caps the body before a plugin handler sees it", async () => {
    const { handler, credentials } = await makeServer();
    const response = await post(
      handler,
      { ...sameOrigin, cookie: credentials.ownerCookie },
      "x".repeat(1024 * 1024 + 1),
    );
    expect(response.status).toBe(413);
  });

  it("refuses unknown paths and methods without asking a plugin for a handler", async () => {
    using calls = vi.spyOn(host, "route");
    const { handler } = await makeServer();
    for (const path of ["/api", "/api/", "/api/not-declared", "/api/no-capability/ping"]) {
      expect(
        (await handler(new Request(`http://127.0.0.1${path}`, { method: "POST" }))).status,
      ).toBe(404);
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "BREW"]) {
      expect((await handler(new Request(`http://127.0.0.1${ROUTE}`, { method }))).status).toBe(404);
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses non-JSON content and malformed JSON", async () => {
    const { handler, credentials } = await makeServer();
    const authHeaders = { ...sameOrigin, cookie: credentials.ownerCookie };
    expect((await post(handler, { ...authHeaders, "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await post(handler, authHeaders, "{broken")).status).toBe(400);
  });

  it("still answers 404 for a route whose plugin is off", async () => {
    const { handler, credentials } = await makeServer();
    const response = await handler(
      new Request("http://127.0.0.1/api/test/missing", {
        method: "POST",
        headers: {
          ...sameOrigin,
          cookie: credentials.ownerCookie,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
  });
});
