import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PluginManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PluginHost } from "./PluginHost.ts";
import { makeLayer } from "./http.ts";

const ROUTE = "/api/test/ping";

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

const layerFor = (plugins: ReadonlyArray<{ readonly manifest: PluginManifest }>) =>
  makeLayer(plugins).pipe(
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

const server = (plugins: ReadonlyArray<{ readonly manifest: PluginManifest }>) => {
  const { handler, dispose } = HttpRouter.toWebHandler(layerFor(plugins), { disableLogger: true });
  disposers.push(dispose);
  return handler;
};

const post = (handler: (request: Request) => Promise<Response>) =>
  handler(
    new Request("http://127.0.0.1/api/test/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );

describe("plugin routes", () => {
  it("serves a listed path when the plugin declares http:routes", async () => {
    const response = await post(server([{ manifest: manifest("test", ["http:routes"], [ROUTE]) }]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });

  it("does not mount a listed path without the http:routes capability", async () => {
    const response = await post(server([{ manifest: manifest("test", [], [ROUTE]) }]));
    expect(response.status).toBe(404);
  });
});
