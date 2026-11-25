import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PluginHost } from "./PluginHost.ts";
import { layerSecretRedaction, makeLayer } from "./http.ts";

const SECRET = "route-secret-for-tests";
const ROUTE = "/api/test/ping";

const host = PluginHost.of({
  changes: Stream.empty,
  setEnabled: () => Effect.die("unused"),
  invoke: () => Effect.die("unused"),
  route: (path) =>
    Effect.succeed(
      path === ROUTE || path === "/api/other/ping"
        ? () => Effect.succeed({ status: 200, body: { pong: true } })
        : null,
    ),
  agentInstructions: Effect.succeed([]),
});

const layer = makeLayer(
  [
    { manifest: { id: "test", capabilities: ["http:routes"], httpRoutes: [ROUTE] } },
    { manifest: { id: "other", capabilities: ["http:routes"], httpRoutes: ["/api/other/ping"] } },
    {
      manifest: { id: "no-capability", capabilities: [], httpRoutes: ["/api/no-capability/ping"] },
    },
  ],
  (id) => Effect.succeed(id === "test" ? SECRET : "other-secret"),
).pipe(
  Layer.provideMerge(Layer.succeed(PluginHost, host)),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const server = (logs?: Array<string>) => {
  const logger = Logger.layer(
    [
      Logger.make((entry) => {
        logs?.push(Logger.formatJson.log(entry));
      }),
    ],
    { mergeWithExisting: false },
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    layer.pipe(Layer.provideMerge(layerSecretRedaction), Layer.provideMerge(logger)),
    { disableLogger: logs === undefined },
  );
  disposers.push(dispose);
  return handler;
};

const post = (
  handler: (request: Request) => Promise<Response>,
  headers: Record<string, string>,
  body = "{}",
  query = "",
) =>
  handler(
    new Request(`http://127.0.0.1/api/test/ping${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

describe("plugin routes", () => {
  it("lets the p0code UI post from its own origin", async () => {
    const response = await post(server(), {
      origin: "http://127.0.0.1",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });

  it("refuses a cross-origin post and a secret-less originless post", async () => {
    const handler = server();
    expect((await post(handler, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(handler, {})).status).toBe(403);
    expect((await post(handler, { "x-p0code-plugin-route-secret": "wrong" })).status).toBe(403);
    expect((await post(handler, {}, "{}", "?p0_route=wrong")).status).toBe(403);
  });

  it("accepts a caller presenting the plugin route secret", async () => {
    const response = await post(server(), { "x-p0code-plugin-route-secret": SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });

  it("accepts a query secret only on a declared route", async () => {
    const handler = server();
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
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("keeps header and query secrets out of request logs and errors", async () => {
    const logs: Array<string> = [];
    const handler = server(logs);
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
    const response = await post(
      server(),
      { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" },
      "x".repeat(1024 * 1024 + 1),
    );
    expect(response.status).toBe(413);
  });

  it("still answers 404 for a route whose plugin is off", async () => {
    const response = await server()(
      new Request("http://127.0.0.1/api/test/missing", {
        method: "POST",
        headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
  });
});
