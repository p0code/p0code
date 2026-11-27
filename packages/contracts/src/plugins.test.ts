import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PluginManifest,
  pluginHttpRouteAuth,
  pluginHttpRoutePath,
  type PluginHttpRoute,
} from "./plugins.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const baseManifest = (httpRoutes: ReadonlyArray<unknown>) => ({
  id: "example",
  name: "Example",
  description: "Example plugin.",
  version: "1.0.0",
  unofficial: false,
  externalServices: [],
  capabilities: ["http:routes"],
  httpRoutes,
});

describe("plugin manifest httpRoutes", () => {
  it("defaults string and auth-omitted route entries to session auth", () => {
    const decoded = decodeManifest(
      baseManifest([
        "/api/example/default",
        { path: "/api/example/omitted" },
        { path: "/api/example/explicit-session", auth: "session" },
        { path: "/api/example/webhook", auth: "none" },
      ]),
    );
    const routes: ReadonlyArray<PluginHttpRoute> = decoded.httpRoutes;
    expect(routes.map(pluginHttpRoutePath)).toEqual([
      "/api/example/default",
      "/api/example/omitted",
      "/api/example/explicit-session",
      "/api/example/webhook",
    ]);
    expect(routes.map(pluginHttpRouteAuth)).toEqual(["session", "session", "session", "none"]);
  });

  it("rejects invalid route paths and unknown auth modes", () => {
    expect(() => decodeManifest(baseManifest(["/not-api/hook"]))).toThrow();
    expect(() =>
      decodeManifest(baseManifest([{ path: "/api/example/hook", auth: "public" }])),
    ).toThrow();
    expect(() =>
      decodeManifest(baseManifest([{ path: "/api/Example/Uppercase", auth: "none" }])),
    ).toThrow();
  });
});
