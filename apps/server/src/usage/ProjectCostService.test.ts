import { assert, describe, it } from "@effect/vitest";
import { UsageDay, ProjectId, ThreadId, type UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectCostService from "./ProjectCostService.ts";
import * as UsageService from "./UsageService.ts";

const RATE_PER_TOKEN: Readonly<Record<string, number>> = { "model-a": 0.001, "model-b": 0.01 };

// Prices every token class at one flat rate, so a test reads its expected cost off the token sum.
const priceCalls: Array<ReadonlyArray<{ readonly model: string; readonly tokens: number }>> = [];
const fakeUsage = Layer.mock(UsageService.UsageService)({
  priceModelTotals: (inputs) =>
    Effect.sync(() => {
      const tokens = (totals: UsageTokenTotals) =>
        totals.uncachedInputTokens +
        totals.cachedInputTokens +
        totals.cacheCreationTokens +
        totals.outputTokens;
      priceCalls.push(inputs.map(({ model, totals }) => ({ model, tokens: tokens(totals) })));
      return inputs.map(({ model, totals }) => {
        const rate = RATE_PER_TOKEN[model];
        return rate === undefined ? null : tokens(totals) * rate;
      });
    }),
});

const layer = ProjectCostService.layer.pipe(
  Layer.provideMerge(fakeUsage),
  Layer.provideMerge(Sqlite.layerMemory),
);

const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");

const seedThread = (threadId: string, projectId: string, model: string, title = "t") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${threadId}, ${projectId}, ${title}, 'codex', 'full-access', 'default',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        ${JSON.stringify({ modelSelection: { model } })}
      )
    `;
  });

let ordinal = 0;
const seedTurn = (
  threadId: string,
  turn: Record<string, unknown>,
  completedAt: string | null = null,
  providerThreadId = `pt-${threadId}`,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    ordinal += 1;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, completed_at,
        payload_json
      ) VALUES (
        ${`turn-${ordinal}`}, ${threadId}, ${providerThreadId}, 'node', ${ordinal}, 'completed',
        ${completedAt}, ${JSON.stringify(turn)}
      )
    `;
  });

const usage = (fields: Record<string, unknown>) => ({
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: 0,
    outputTokens: 0,
    ...fields,
  },
});

describe("ProjectCostService", () => {
  it.effect("prices a project's turns per model and splits out one thread", () =>
    Effect.gen(function* () {
      yield* seedThread("thread-1", PROJECT, "model-a");
      yield* seedThread("thread-2", PROJECT, "model-a");
      yield* seedThread("elsewhere", OTHER_PROJECT, "model-a");
      // 1000 input of which 400 cached and 100 written: 500 uncached.
      yield* seedTurn(
        "thread-1",
        usage({
          inputTokens: 1000,
          cachedInputTokens: 400,
          cacheCreationTokens: 100,
          outputTokens: 50,
        }),
      );
      // The turn's own model beats the thread's.
      yield* seedTurn("thread-2", {
        model: "model-b",
        ...usage({ inputTokens: 100, outputTokens: 20 }),
      });
      yield* seedTurn("thread-2", usage({ inputTokens: 10, outputTokens: 5 }));
      // Skipped: local command, no counts, other project.
      yield* seedTurn(
        "thread-2",
        usage({ inputTokens: 9999, outputTokens: 9999, localCommand: true }),
      );
      yield* seedTurn("thread-2", { status: "completed" });
      yield* seedTurn("elsewhere", usage({ inputTokens: 5000, outputTokens: 5000 }));

      const service = yield* ProjectCostService.ProjectCostService;
      const cost = yield* service.readProjectCost({ projectId: PROJECT, threadId: THREAD_1 });

      // model-a: (500 + 400 + 100 + 50) + (10 + 5) tokens; model-b: 120 tokens.
      assert.closeTo(cost.project.costUsd, 1065 * 0.001 + 120 * 0.01, 1e-9);
      assert.isFalse(cost.project.partial);
      assert.closeTo(cost.thread?.costUsd ?? Number.NaN, 1050 * 0.001, 1e-9);

      const other = yield* service.readProjectCost({ projectId: PROJECT, threadId: THREAD_2 });
      assert.closeTo(other.thread?.costUsd ?? Number.NaN, 15 * 0.001 + 120 * 0.01, 1e-9);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves out models with no price and marks the total partial", () =>
    Effect.gen(function* () {
      yield* seedThread("thread-1", PROJECT, "model-a");
      yield* seedTurn("thread-1", usage({ inputTokens: 100, outputTokens: 0 }));
      yield* seedTurn("thread-1", {
        model: "mystery",
        ...usage({ inputTokens: 100, outputTokens: 0 }),
      });

      const service = yield* ProjectCostService.ProjectCostService;
      const cost = yield* service.readProjectCost({ projectId: PROJECT });

      assert.closeTo(cost.project.costUsd, 100 * 0.001, 1e-9);
      assert.isTrue(cost.project.partial);
      assert.deepEqual(cost.project.unpricedModels, ["mystery"]);
      assert.isUndefined(cost.thread);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers from a short cache, then reads again once it expires", () =>
    Effect.gen(function* () {
      yield* seedThread("thread-1", PROJECT, "model-a");
      yield* seedTurn("thread-1", usage({ inputTokens: 100, outputTokens: 0 }));
      const service = yield* ProjectCostService.ProjectCostService;
      const calls = priceCalls.length;

      const first = yield* service.readProjectCost({ projectId: PROJECT });
      yield* seedTurn("thread-1", usage({ inputTokens: 100, outputTokens: 0 }));
      const cached = yield* service.readProjectCost({ projectId: PROJECT });
      assert.strictEqual(cached, first);
      assert.strictEqual(priceCalls.length, calls + 1);

      yield* TestClock.adjust("6 seconds");
      const fresh = yield* service.readProjectCost({ projectId: PROJECT });
      assert.closeTo(fresh.project.costUsd, 200 * 0.001, 1e-9);
      assert.strictEqual(priceCalls.length, calls + 2);
    }).pipe(Effect.provide(layer)),
  );
  describe("readCostBreakdown", () => {
    const seedSpend = Effect.gen(function* () {
      yield* seedThread("thread-1", PROJECT, "model-a", "Big refactor");
      yield* seedThread("thread-2", PROJECT, "model-a", "Small fix");
      yield* seedThread("elsewhere", OTHER_PROJECT, "model-b", "Other project");
      yield* seedTurn(
        "thread-1",
        usage({
          inputTokens: 1000,
          cachedInputTokens: 400,
          cacheCreationTokens: 100,
          outputTokens: 50,
        }),
        "2026-03-01T10:00:00.000Z",
      );
      yield* seedTurn(
        "thread-1",
        usage({ inputTokens: 100, outputTokens: 0 }),
        "2026-03-10T10:00:00.000Z",
      );
      yield* seedTurn(
        "thread-2",
        { model: "model-b", ...usage({ inputTokens: 100, outputTokens: 20 }) },
        "2026-03-05T10:00:00.000Z",
      );
      yield* seedTurn(
        "elsewhere",
        usage({ inputTokens: 10, outputTokens: 10 }),
        "2026-03-05T10:00:00.000Z",
      );
      // Skipped like readProjectCost: local command, and a turn with no counts.
      yield* seedTurn("thread-2", usage({ inputTokens: 9999, localCommand: true }));
      yield* seedTurn("thread-2", { status: "completed" });
    });

    it.effect("ranks threads across projects and totals each model", () =>
      Effect.gen(function* () {
        yield* seedSpend;
        const service = yield* ProjectCostService.ProjectCostService;
        const all = yield* service.readCostBreakdown({ top: 2 });

        // thread-1: 1050 + 100 model-a tokens; thread-2: 120 model-b tokens; elsewhere: 20.
        assert.deepEqual(
          all.topThreads.map((thread) => thread.threadId),
          ["thread-2", "thread-1"],
        );
        assert.strictEqual(all.topThreads[0]?.title, "Small fix");
        assert.strictEqual(all.topThreads[0]?.projectId, PROJECT);
        assert.closeTo(all.topThreads[1]?.costUsd ?? Number.NaN, 1150 * 0.001, 1e-9);
        assert.deepEqual(all.topThreads[1]?.cachedInput, 400);
        assert.strictEqual(all.threadCount, 3);
        assert.closeTo(all.total.costUsd, 1150 * 0.001 + 140 * 0.01, 1e-9);
        assert.isFalse(all.total.partial);
        assert.deepEqual(
          all.byModel.map(({ model }) => model),
          ["model-b", "model-a"],
        );
        assert.deepEqual(all.byModel[1]?.tokens, {
          input: 600,
          cachedInput: 400,
          cacheWrite: 100,
          output: 50,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("filters by project, thread, and time range", () =>
      Effect.gen(function* () {
        yield* seedSpend;
        const service = yield* ProjectCostService.ProjectCostService;

        const project = yield* service.readCostBreakdown({ projectId: OTHER_PROJECT, top: 5 });
        assert.deepEqual(
          project.topThreads.map((thread) => thread.threadId),
          ["elsewhere"],
        );

        const thread = yield* service.readCostBreakdown({ threadId: THREAD_2, top: 5 });
        assert.closeTo(thread.total.costUsd, 120 * 0.01, 1e-9);

        // [since, until): the 10 March turn and the untimed turns drop out.
        const ranged = yield* service.readCostBreakdown({
          since: "2026-03-01T00:00:00.000Z",
          until: "2026-03-08T00:00:00.000Z",
          top: 5,
        });
        assert.closeTo(ranged.total.costUsd, 1050 * 0.001 + 140 * 0.01, 1e-9);
        assert.strictEqual(ranged.threadCount, 3);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("marks a total partial when a model has no price", () =>
      Effect.gen(function* () {
        yield* seedThread("thread-1", PROJECT, "model-a");
        yield* seedTurn("thread-1", usage({ inputTokens: 100 }));
        yield* seedTurn("thread-1", { model: "mystery", ...usage({ inputTokens: 50 }) });
        const service = yield* ProjectCostService.ProjectCostService;
        const result = yield* service.readCostBreakdown({ top: 5 });

        assert.isTrue(result.total.partial);
        assert.deepEqual(result.total.unpricedModels, ["mystery"]);
        assert.closeTo(result.total.costUsd, 100 * 0.001, 1e-9);
        assert.isNull(result.byModel.find(({ model }) => model === "mystery")?.costUsd);
        assert.strictEqual(result.total.input, 150);
      }).pipe(Effect.provide(layer)),
    );
  });
  describe("readDetails", () => {
    const input = {
      sinceDay: UsageDay.make("2026-03-01"),
      untilDay: UsageDay.make("2026-03-31"),
      offset: 0,
      limit: 1,
      sort: "day" as const,
      descending: false,
    };
    it.effect(
      "groups days, accounts and models, filters before totals, and pages deterministically",
      () =>
        Effect.gen(function* () {
          yield* seedThread("thread-1", PROJECT, "model-a", "Refactor");
          yield* seedThread("thread-2", OTHER_PROJECT, "model-b", "Other");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, provider_instance_id, status, updated_at, payload_json) VALUES ('pt-thread-1', 'thread-1', 'claude', 'work-account', 'active', '2026-03-01T00:00:00Z', '{}')`;
          yield* seedTurn(
            "thread-1",
            usage({
              inputTokens: 1000,
              cachedInputTokens: 400,
              cacheCreationTokens: 100,
              outputTokens: 50,
              reasoningTokens: 20,
            }),
            "2026-03-01T23:59:00Z",
          );
          yield* seedTurn(
            "thread-1",
            usage({ inputTokens: 10, outputTokens: 5 }),
            "2026-03-01T23:59:30Z",
          );
          yield* seedTurn(
            "thread-1",
            { model: "model-b", ...usage({ inputTokens: 100, outputTokens: 20 }) },
            "2026-03-02T00:00:00Z",
          );
          yield* seedTurn("thread-2", usage({ inputTokens: 10 }), "2026-03-02T00:00:00Z");
          yield* seedTurn(
            "thread-1",
            usage({ inputTokens: 9999, localCommand: true }),
            "2026-03-02T00:00:00Z",
          );
          yield* seedTurn("thread-1", { status: "completed" }, "2026-03-02T00:00:00Z");
          const service = yield* ProjectCostService.ProjectCostService;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, provider_instance_id, status, updated_at, payload_json) VALUES ('other-account-thread', 'thread-1', 'claude', 'zzz-account', 'active', '2026-03-01T00:00:00Z', '{}')`;
          yield* seedTurn(
            "thread-1",
            usage({ inputTokens: 10 }),
            "2026-03-01T23:59:45Z",
            "other-account-thread",
          );
          yield* seedTurn("thread-1", usage({ inputTokens: 10 }), "2026-03-03T00:00:00Z");
          const first = yield* service.readDetails(input);
          assert.strictEqual(first.totalRows, 5);
          assert.strictEqual(first.rows.length, 1);
          assert.strictEqual(first.rows[0]?.records, 2);
          assert.strictEqual(first.rows[0]?.uncachedInputTokens, 510);
          assert.strictEqual(first.rows[0]?.reasoningTokens, 20);
          assert.strictEqual(first.rows[0]?.account, "work-account");
          assert.closeTo(first.totals.costUsd, 1.065 + 1.2 + 0.1 + 0.02, 1e-9);
          assert.strictEqual(first.totals.records, 6);
          const second = yield* service.readDetails({ ...input, offset: 1 });
          assert.notDeepEqual(second.rows, first.rows);
          assert.deepEqual(second.totals, first.totals);
          const filtered = yield* service.readDetails({
            ...input,
            project: "PROJECT-1",
            provider: "WORK",
            model: "MODEL-B",
            threadId: THREAD_1,
            sinceDay: UsageDay.make("2026-03-02"),
            untilDay: UsageDay.make("2026-03-02"),
          });
          assert.strictEqual(filtered.totalRows, 1);
          assert.closeTo(filtered.totals.costUsd, 1.2, 1e-9);
          const byCost = yield* service.readDetails({ ...input, sort: "cost", descending: true });
          assert.strictEqual(byCost.rows[0]?.model, "model-b");
        }).pipe(Effect.provide(layer)),
    );
    it.effect(
      "reports unknown prices, empty filters and exhausted pages without losing totals",
      () =>
        Effect.gen(function* () {
          yield* seedThread("thread-1", PROJECT, "mystery");
          yield* seedTurn("thread-1", usage({ inputTokens: 100 }), "2026-03-01T00:00:00Z");
          const service = yield* ProjectCostService.ProjectCostService;
          const unknown = yield* service.readDetails(input);
          assert.strictEqual(unknown.totals.unpricedRecords, 1);
          assert.strictEqual(unknown.totals.costUsd, 0);
          const empty = yield* service.readDetails({ ...input, provider: "missing" });
          assert.deepEqual(empty.rows, []);
          assert.strictEqual(empty.totalRows, 0);
          assert.strictEqual(empty.totals.records, 0);
          const end = yield* service.readDetails({ ...input, offset: 100 });
          assert.deepEqual(end.rows, []);
          assert.deepEqual(end.totals, unknown.totals);
          const reversed = yield* service
            .readDetails({ ...input, untilDay: UsageDay.make("2026-02-01") })
            .pipe(Effect.flip);
          assert.strictEqual(reversed.reason, "invalidWindow");
          const long = yield* service
            .readDetails({ ...input, untilDay: UsageDay.make("2028-01-01") })
            .pipe(Effect.flip);
          assert.strictEqual(long.reason, "invalidWindow");
        }).pipe(Effect.provide(layer)),
    );
  });
});
