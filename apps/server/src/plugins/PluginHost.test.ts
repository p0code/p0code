import {
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  type PluginManifest,
  WS_METHODS,
} from "@t3tools/contracts";
import { definePlugin, PluginContext, PluginError, type PluginServices } from "@t3tools/plugin-api";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { requiredScopesForRpcCall } from "../auth/RpcAuthorization.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BundledPlugins,
  layer as pluginHostLayer,
  layerAgentInstructions,
  PluginAgentInstructions,
  PluginHost,
  PluginHostBindings,
} from "./PluginHost.ts";

const manifest = (id: string, capabilities: PluginManifest["capabilities"]): PluginManifest => ({
  id,
  name: id,
  description: "Test plugin.",
  version: "1.0.0",
  unofficial: false,
  externalServices: [],
  capabilities,
  httpRoutes: [`/api/${id}/ping`],
});

const events: Array<string> = [];
const revoked: Array<string> = [];

const echo = definePlugin({
  manifest: manifest("echo", ["auth:issue-device-credentials", "http:routes"]),
  actions: { echo: { input: Schema.Struct({ text: Schema.String }), output: Schema.String } },
  start: Effect.gen(function* () {
    const context = yield* PluginContext;
    events.push(`start:${context.pluginId}`);
    yield* Effect.addFinalizer(() => Effect.sync(() => events.push("stop:echo")));
    return {
      actions: { echo: ({ text }) => Effect.succeed(text.toUpperCase()) },
      routes: {
        "/api/echo/ping": () => Effect.succeed({ status: 200, body: { pong: true } }),
      },
    };
  }),
});

const broken = definePlugin({
  manifest: manifest("broken", []),
  actions: {},
  start: Effect.fail(new PluginError({ message: "No network today." })),
});

const advisor = definePlugin({
  manifest: manifest("advisor", ["agent:instructions"]),
  actions: {},
  start: Effect.succeed({
    actions: {},
    agentInstructions: Effect.succeed("<plugin_note>remember this</plugin_note>"),
  }),
});

const undeclaredAdvisor = definePlugin({
  manifest: manifest("undeclared-advisor", []),
  actions: {},
  start: Effect.succeed({
    actions: {},
    agentInstructions: Effect.succeed("<forbidden>nope</forbidden>"),
  }),
});

const unusedContext = Effect.fail(new PluginError({ message: "unused" }));
const stubPtyLayer = Layer.succeed(
  PtyAdapter.PtyAdapter,
  PtyAdapter.PtyAdapter.of({
    spawn: () => Effect.die("unused"),
  }),
);

const layerBindings = Layer.effect(
  PluginHostBindings,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Exclude<PluginServices, PluginContext>>();
    return PluginHostBindings.of({
      platform,
      revokeIssued: (pluginId) => Effect.sync(() => revoked.push(pluginId)),
      migrateLegacyData: () => Effect.void,
      contextFor: (pluginManifest, reportStatus) =>
        Effect.succeed(
          PluginContext.of({
            pluginId: pluginManifest.id,
            dataDir: "/nonexistent",
            storage: {
              get: () => Effect.succeedNone,
              set: () => Effect.void,
              remove: () => Effect.void,
            },
            reportStatus,
            environment: {
              environmentId: Effect.die("unused"),
              descriptor: Effect.die("unused"),
              localOrigin: unusedContext,
            },
            deviceAccess: { issueCredential: () => unusedContext, revokeAll: Effect.void },
            agentActivity: {
              changes: Stream.empty,
              read: () => Effect.succeed(null),
              activeThreadIds: Effect.succeed([]),
            },
          }),
        ),
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer, stubPtyLayer),
  ),
);

const layerHost = pluginHostLayer.pipe(
  Layer.provide(Layer.succeed(BundledPlugins, [echo, broken, advisor, undeclaredAdvisor])),
  Layer.provide(layerBindings),
  Layer.provideMerge(layerAgentInstructions),
  Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
);

const snapshotOf = (id: string) =>
  PluginHost.pipe(
    Effect.flatMap((host) => host.changes.pipe(Stream.take(1), Stream.runHead)),
    Effect.map((snapshot) =>
      Option.getOrThrow(snapshot).plugins.find((plugin) => plugin.manifest.id === id),
    ),
  );

describe("PluginHost", () => {
  it.layer(layerHost)((it) => {
    it.effect("keeps plugins off until enabled, then runs and stops them", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost;
        assert.strictEqual((yield* snapshotOf("echo"))?.state, "disabled");
        assert.isNull(yield* host.route("/api/echo/ping"));
        const refused = yield* host
          .invoke({ pluginId: "echo", action: "echo", input: {} })
          .pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }),
          );
        assert.strictEqual(refused, "Turn the plugin on first.");

        yield* host.setEnabled({ pluginId: "echo", enabled: true });
        assert.strictEqual((yield* snapshotOf("echo"))?.state, "running");
        assert.include(events, "start:echo");
        const echoed = yield* host.invoke({
          pluginId: "echo",
          action: "echo",
          input: { text: "hi" },
        });
        assert.strictEqual(echoed, "HI");
        const invalid = yield* host
          .invoke({ pluginId: "echo", action: "echo", input: { text: 1 } })
          .pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }),
          );
        assert.strictEqual(invalid, "Invalid action input.");
        const route = yield* host.route("/api/echo/ping");
        assert.isNotNull(route);

        revoked.length = 0;
        yield* host.setEnabled({ pluginId: "echo", enabled: false });
        assert.strictEqual((yield* snapshotOf("echo"))?.state, "disabled");
        assert.include(events, "stop:echo");
        assert.deepStrictEqual(revoked, ["echo"]);
        assert.isNull(yield* host.route("/api/echo/ping"));
      }),
    );

    it.effect("isolates a plugin that fails to start", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.setEnabled({ pluginId: "broken", enabled: true });
        yield* host.setEnabled({ pluginId: "echo", enabled: true });
        const failed = yield* snapshotOf("broken");
        assert.strictEqual(failed?.state, "failed");
        assert.strictEqual(failed?.message, "No network today.");
        assert.strictEqual((yield* snapshotOf("echo"))?.state, "running");
        yield* host.setEnabled({ pluginId: "broken", enabled: false });
        assert.strictEqual((yield* snapshotOf("broken"))?.state, "disabled");
        yield* host.setEnabled({ pluginId: "echo", enabled: false });
      }),
    );

    it.effect("rejects unknown plugins", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const error = yield* host
          .setEnabled({ pluginId: "nope", enabled: true })
          .pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }),
          );
        assert.strictEqual(error, "Unknown plugin.");
      }),
    );

    it.effect(
      "exposes agentInstructions only for running plugins declaring agent:instructions",
      () =>
        Effect.gen(function* () {
          const host = yield* PluginHost;
          const slot = yield* PluginAgentInstructions;
          assert.deepStrictEqual(yield* host.agentInstructions, []);
          assert.deepStrictEqual(yield* slot.read, []);

          yield* host.setEnabled({ pluginId: "advisor", enabled: true });
          assert.deepStrictEqual(yield* host.agentInstructions, [
            "<plugin_note>remember this</plugin_note>",
          ]);
          assert.deepStrictEqual(yield* slot.read, ["<plugin_note>remember this</plugin_note>"]);

          yield* host.setEnabled({ pluginId: "undeclared-advisor", enabled: true });
          assert.strictEqual((yield* snapshotOf("undeclared-advisor"))?.state, "failed");
          assert.deepStrictEqual(yield* host.agentInstructions, [
            "<plugin_note>remember this</plugin_note>",
          ]);

          yield* host.setEnabled({ pluginId: "advisor", enabled: false });
          yield* host.setEnabled({ pluginId: "undeclared-advisor", enabled: false });
          assert.deepStrictEqual(yield* host.agentInstructions, []);
          assert.deepStrictEqual(yield* slot.read, []);
        }),
    );
  });

  it("requires the administrative relay scope to manage plugins", () => {
    assert.deepStrictEqual(
      requiredScopesForRpcCall(WS_METHODS.pluginsSetEnabled, { pluginId: "echo", enabled: true }),
      [AuthRelayConfigureScope],
    );
    assert.deepStrictEqual(
      requiredScopesForRpcCall(WS_METHODS.pluginsInvoke, {
        pluginId: "echo",
        action: "x",
        input: {},
      }),
      [AuthRelayConfigureScope],
    );
    assert.deepStrictEqual(requiredScopesForRpcCall(WS_METHODS.pluginsSubscribe, {}), [
      AuthRelayReadScope,
    ]);
    assert.deepStrictEqual(
      requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, {
        patch: { plugins: { echo: { enabled: true } } },
      }),
      [AuthRelayConfigureScope],
    );
  });
});
