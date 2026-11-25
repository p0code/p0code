import { DataBackup } from "../persistence/DataBackup.ts";
import {
  type PluginManifest,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { definePlugin, PluginContext, type PluginError } from "@t3tools/plugin-api";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import { layer as bindingsLayer } from "./bindings.ts";
import {
  BundledPlugins,
  layer as pluginHostLayer,
  PluginHost,
  PluginHostBindings,
} from "./PluginHost.ts";

const readSummaryCalls: Array<UsageSummaryInput> = [];
let activeUsageReads = 0;
let peakUsageReads = 0;

const sampleSummary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-03T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-02"),
  buckets: [
    {
      day: UsageDay.make("2026-08-01"),
      hourStart: "2026-08-01T10:00:00.000Z",
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourcePath: "/Users/alice/.claude/projects/secret-repo",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 50,
        cacheCreationTokens: 20,
        outputTokens: 40,
        reasoningTokens: 10,
      },
      costUsd: 0.25,
      cacheSavingsUsd: 0.05,
      costSource: "modelPriced",
      records: 2,
      unpricedRecords: 0,
      sessions: 1,
    },
    {
      day: UsageDay.make("2026-08-01"),
      hourStart: "2026-08-01T15:00:00.000Z",
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourcePath: "/Users/alice/.claude/projects/another-secret-repo",
      totals: {
        uncachedInputTokens: 300,
        cachedInputTokens: 150,
        cacheCreationTokens: 30,
        outputTokens: 80,
        reasoningTokens: 25,
      },
      costUsd: 0.75,
      cacheSavingsUsd: 0.1,
      costSource: "modelPriced",
      records: 3,
      unpricedRecords: 1,
      sessions: 2,
    },
    {
      day: UsageDay.make("2026-08-02"),
      provider: "muse",
      model: "unlisted-model",
      sourcePath: "/Users/alice/.muse/sessions/private-id",
      totals: {
        uncachedInputTokens: 50,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 15,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
  ],
  sources: [],
  pricing: { status: "fresh", source: "https://example.test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};

const manifest = (id: string, capabilities: PluginManifest["capabilities"]): PluginManifest => ({
  id,
  name: id,
  description: "Test plugin.",
  version: "1.0.0",
  unofficial: false,
  externalServices: [],
  capabilities,
  httpRoutes: [],
});

const readInput = Schema.Struct({
  sinceDay: Schema.String,
  untilDay: Schema.String,
  timeZone: Schema.String,
});

const declaredReader = definePlugin({
  manifest: manifest("usage-reader", ["usage:read"]),
  actions: { read: { input: readInput, output: Schema.Unknown } },
  start: Effect.gen(function* () {
    const context = yield* PluginContext;
    return {
      actions: {
        read: (input: typeof readInput.Type) => context.usage.dailyTotals(input),
      },
    };
  }),
});

const undeclaredReader = definePlugin({
  manifest: manifest("no-usage-reader", []),
  actions: { read: { input: readInput, output: Schema.Unknown } },
  start: Effect.gen(function* () {
    const context = yield* PluginContext;
    return {
      actions: {
        read: (input: typeof readInput.Type) => context.usage.dailyTotals(input),
      },
    };
  }),
});

const stubUsageLayer = Layer.succeed(
  UsageService.UsageService,
  UsageService.UsageService.of({
    readSummary: (input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          readSummaryCalls.push(input);
          activeUsageReads++;
          peakUsageReads = Math.max(peakUsageReads, activeUsageReads);
        }),
        () => Effect.yieldNow.pipe(Effect.as(sampleSummary)),
        () =>
          Effect.sync(() => {
            activeUsageReads--;
          }),
      ),
    refreshRates: Effect.die("unused"),
    priceModelTotals: () => Effect.die("unused"),
  }),
);

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-plugin-bindings-test-",
});

const stubDependencies = Layer.mergeAll(
  FetchHttpClient.layer,
  stubUsageLayer,
  Layer.mock(DataBackup)({}),
  Layer.succeed(
    PtyAdapter.PtyAdapter,
    PtyAdapter.PtyAdapter.of({ spawn: () => Effect.die("unused") }),
  ),
  configLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.die("unused"),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    createPairingLink: () => Effect.die("unused"),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
  Layer.succeed(SessionStore.SessionStore, {
    listActive: () => Effect.succeed([]),
    revoke: () => Effect.void,
  } as unknown as SessionStore.SessionStore["Service"]),
  Layer.succeed(PairingGrantStore.PairingGrantStore, {
    listActive: () => Effect.succeed([]),
    revoke: () => Effect.void,
  } as unknown as PairingGrantStore.PairingGrantStore["Service"]),
  Layer.succeed(HttpServer.HttpServer, {
    address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 0 },
  } as unknown as HttpServer.HttpServer["Service"]),
  Layer.succeed(ThreadManagement.ThreadManagementService, {
    streamDomainEvents: Stream.empty,
    getAgentAwarenessSnapshot: () => Effect.die("unused"),
  } as unknown as ThreadManagement.ThreadManagementService["Service"]),
  Layer.succeed(ProjectService.ProjectService, {
    getById: () => Effect.succeedNone,
  } as unknown as ProjectService.ProjectService["Service"]),
).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const layerBindingsTest = bindingsLayer.pipe(Layer.provide(stubDependencies));

const layerHostWithBindings = pluginHostLayer.pipe(
  Layer.provide(
    Layer.succeed(
      BundledPlugins,
      BundledPlugins.of({ plugins: [declaredReader, undeclaredReader], failures: [] }),
    ),
  ),
  Layer.provideMerge(layerBindingsTest),
  Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
);

const EXPECTED_KEYS = [
  "cacheCreationTokens",
  "cachedInputTokens",
  "costUsd",
  "day",
  "model",
  "outputTokens",
  "provider",
  "reasoningTokens",
  "records",
  "uncachedInputTokens",
  "unpricedRecords",
];

describe("PluginHostBindings usage:read", () => {
  it.layer(layerHostWithBindings)((it) => {
    it.effect("refuses every backup operation without data:backup", () =>
      Effect.gen(function* () {
        const bindings = yield* PluginHostBindings;
        const ctx = yield* bindings.contextFor(manifest("no-backup", []), () => Effect.void);
        const operations: ReadonlyArray<Effect.Effect<unknown, PluginError, Scope.Scope>> = [
          ctx.dataBackup.snapshot,
          ctx.dataBackup.stageRestore("/outside"),
          ctx.dataBackup.pendingRestore,
          ctx.dataBackup.cancelRestore,
        ];
        for (const operation of operations) {
          const message = yield* operation.pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: () => "unexpected success",
            }),
          );
          assert.strictEqual(message, "The plugin did not declare this capability.");
        }
      }),
    );
    it.effect("refuses plugins that did not declare usage:read", () =>
      Effect.gen(function* () {
        readSummaryCalls.length = 0;
        const bindings = yield* PluginHostBindings;
        const ctx = yield* bindings.contextFor(manifest("undeclared", []), () => Effect.void);
        const directError = yield* ctx.usage
          .dailyTotals({ sinceDay: "2026-08-01", untilDay: "2026-08-02", timeZone: "UTC" })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ tag: error._tag, message: error.message }),
              onSuccess: () => ({ tag: "Success", message: "" }),
            }),
          );
        assert.deepStrictEqual(directError, {
          tag: "PluginError",
          message: "The plugin did not declare this capability.",
        });

        const host = yield* PluginHost;
        yield* host.setEnabled({ pluginId: "no-usage-reader", enabled: true });
        const hostError = yield* host
          .invoke({
            pluginId: "no-usage-reader",
            action: "read",
            input: { sinceDay: "2026-08-01", untilDay: "2026-08-02", timeZone: "UTC" },
          })
          .pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }),
          );
        assert.strictEqual(hostError, "The plugin did not declare this capability.");
        assert.strictEqual(readSummaryCalls.length, 0);
        yield* host.setEnabled({ pluginId: "no-usage-reader", enabled: false });
      }),
    );

    it.effect("refuses windows over 400 days before reading usage", () =>
      Effect.gen(function* () {
        readSummaryCalls.length = 0;
        const bindings = yield* PluginHostBindings;
        const ctx = yield* bindings.contextFor(
          manifest("wide-reader", ["usage:read"]),
          () => Effect.void,
        );
        const result = yield* ctx.usage
          .dailyTotals({ sinceDay: "2025-01-01", untilDay: "2026-02-05", timeZone: "UTC" })
          .pipe(Effect.flip);
        assert.include(result.message, "at most 400 days");
        assert.strictEqual(readSummaryCalls.length, 0);
        yield* ctx.usage.dailyTotals({
          sinceDay: "2025-01-01",
          untilDay: "2026-02-04",
          timeZone: "UTC",
        });
        assert.strictEqual(readSummaryCalls.length, 1);
      }),
    );

    it.effect("coalesces parallel usage reads across plugins", () =>
      Effect.gen(function* () {
        readSummaryCalls.length = 0;
        const bindings = yield* PluginHostBindings;
        const contexts = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, i) => i),
          (i) => bindings.contextFor(manifest(`parallel-${i}`, ["usage:read"]), () => Effect.void),
        );
        const rows = yield* Effect.forEach(
          contexts,
          (ctx) =>
            ctx.usage.dailyTotals({
              sinceDay: "2026-07-01",
              untilDay: "2026-07-02",
              timeZone: "UTC",
            }),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(readSummaryCalls.length, 1);
        assert.strictEqual(rows.length, 12);
        for (const result of rows) assert.deepStrictEqual(result, rows[0]);
      }),
    );

    it.effect("serializes different usage windows across plugins", () =>
      Effect.gen(function* () {
        readSummaryCalls.length = 0;
        peakUsageReads = 0;
        const bindings = yield* PluginHostBindings;
        const contexts = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, i) => i),
          (i) => bindings.contextFor(manifest(`different-${i}`, ["usage:read"]), () => Effect.void),
        );
        yield* Effect.forEach(
          contexts,
          (ctx, i) =>
            ctx.usage.dailyTotals({
              sinceDay: `2026-06-${String(i + 1).padStart(2, "0")}`,
              untilDay: "2026-06-30",
              timeZone: "UTC",
            }),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(readSummaryCalls.length, 12);
        assert.strictEqual(peakUsageReads, 1);
        assert.strictEqual(activeUsageReads, 0);
      }),
    );

    it.effect("returns folded numeric daily rows without paths, hours, or session counts", () =>
      Effect.gen(function* () {
        readSummaryCalls.length = 0;
        const host = yield* PluginHost;
        yield* host.setEnabled({ pluginId: "usage-reader", enabled: true });

        const rows = (yield* host.invoke({
          pluginId: "usage-reader",
          action: "read",
          input: { sinceDay: "2026-08-01", untilDay: "2026-08-02", timeZone: "UTC" },
        })) as ReadonlyArray<Record<string, unknown>>;

        assert.deepStrictEqual(readSummaryCalls, [
          {
            sinceDay: UsageDay.make("2026-08-01"),
            untilDay: UsageDay.make("2026-08-02"),
            timeZone: "UTC",
            resolution: "day",
            awaitRefresh: false,
            provisional: true,
          },
        ]);

        assert.deepStrictEqual(rows, [
          {
            day: "2026-08-01",
            provider: "claude",
            model: "claude-sonnet-4-5",
            uncachedInputTokens: 400,
            cachedInputTokens: 200,
            cacheCreationTokens: 50,
            outputTokens: 120,
            reasoningTokens: 35,
            costUsd: 1,
            records: 5,
            unpricedRecords: 1,
          },
          {
            day: "2026-08-02",
            provider: "muse",
            model: "unlisted-model",
            uncachedInputTokens: 50,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 15,
            reasoningTokens: 0,
            costUsd: 0,
            records: 1,
            unpricedRecords: 1,
          },
        ]);

        for (const row of rows) {
          assert.deepStrictEqual(Object.keys(row).toSorted(), EXPECTED_KEYS);
        }
        assert.notInclude(JSON.stringify(rows), "secret-repo");
        assert.notInclude(JSON.stringify(rows), "private-id");
        assert.notInclude(JSON.stringify(rows), "hourStart");
        assert.notInclude(JSON.stringify(rows), "sessions");

        yield* host.setEnabled({ pluginId: "usage-reader", enabled: false });
      }),
    );
  });
});
