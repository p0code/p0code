import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PluginHost } from "./PluginHost.ts";
import { makeLayer } from "./http.ts";

const SECRET = "route-secret-for-tests";
const ROUTE = "/api/test/ping";

const host = PluginHost.of({
  changes: Stream.empty,
  setEnabled: () => Effect.die("unused"),
  invoke: () => Effect.die("unused"),
  route: (path) =>
    Effect.succeed(
      path === ROUTE ? () => Effect.succeed({ status: 200, body: { pong: true } }) : null,
    ),
  agentInstructions: Effect.succeed([]),
});

const layer = makeLayer([{ manifest: { httpRoutes: [ROUTE] } }], SECRET).pipe(
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

const server = () => {
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true });
  disposers.push(dispose);
  return handler;
};

const post = (
  handler: (request: Request) => Promise<Response>,
  headers: Record<string, string>,
  body = "{}",
) =>
  handler(
    new Request("http://127.0.0.1/api/test/ping", {
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
  });

  it("accepts a caller presenting the plugin route secret", async () => {
    const response = await post(server(), { "x-p0code-plugin-route-secret": SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
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
