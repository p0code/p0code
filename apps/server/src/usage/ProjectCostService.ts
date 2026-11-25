import {
  type ProjectCost,
  type ProjectCostAmount,
  type ProjectCostInput,
  ProjectCostReadError,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageService from "./UsageService.ts";

/** Reopening the popover, or two clients asking at once, share one aggregate read. */
const CACHE_TTL_MS = 5_000;
const CACHE_MAX_ENTRIES = 64;

const UNKNOWN_MODEL = "unknown";

interface ModelTokenRow {
  readonly model: string | null;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly threadUncachedInputTokens: number;
  readonly threadCachedInputTokens: number;
  readonly threadCacheCreationTokens: number;
  readonly threadOutputTokens: number;
}

const projectTotals = (row: ModelTokenRow): UsageTokenTotals => ({
  uncachedInputTokens: row.uncachedInputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: 0,
});

const threadTotals = (row: ModelTokenRow): UsageTokenTotals => ({
  uncachedInputTokens: row.threadUncachedInputTokens,
  cachedInputTokens: row.threadCachedInputTokens,
  cacheCreationTokens: row.threadCacheCreationTokens,
  outputTokens: row.threadOutputTokens,
  reasoningTokens: 0,
});

const hasTokens = (totals: UsageTokenTotals) =>
  totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens >
  0;

/** A model with no known price adds nothing and marks the sum partial. */
function sumModelCosts(
  models: ReadonlyArray<{ readonly model: string; readonly costUsd: number | null }>,
): ProjectCostAmount {
  const unpricedModels = models.flatMap((entry) => (entry.costUsd === null ? [entry.model] : []));
  return {
    costUsd: models.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
    partial: unpricedModels.length > 0,
    unpricedModels,
  };
}

export class CostBreakdownReadError extends Schema.TaggedError<CostBreakdownReadError>()(
  "CostBreakdownReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read token spend.";
  }
}

/** Which turns to total. Times are ISO; a turn counts by when it completed, else when it started. */
export interface CostBreakdownInput {
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  /** How many of the costliest threads to list. */
  readonly top: number;
}

export interface CostTokens {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface CostLine extends CostTokens {
  readonly costUsd: number;
  /** Some models have no known price, so the real cost is higher. */
  readonly partial: boolean;
  readonly unpricedModels: ReadonlyArray<string>;
}

export interface CostBreakdown {
  readonly total: CostLine;
  readonly threadCount: number;
  readonly byModel: ReadonlyArray<{
    readonly model: string;
    readonly costUsd: number | null;
    readonly tokens: CostTokens;
  }>;
  readonly topThreads: ReadonlyArray<
    CostLine & { readonly threadId: string; readonly projectId: string; readonly title: string }
  >;
}

interface ThreadModelRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly model: string | null;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

const addTokens = (a: CostTokens, b: CostTokens): CostTokens => ({
  input: a.input + b.input,
  cachedInput: a.cachedInput + b.cachedInput,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

const rowTotals = (row: ThreadModelRow): UsageTokenTotals => ({
  uncachedInputTokens: row.uncachedInputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: 0,
});

const NO_TOKENS: CostTokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };

const tokensOf = (totals: UsageTokenTotals): CostTokens => ({
  input: totals.uncachedInputTokens,
  cachedInput: totals.cachedInputTokens,
  cacheWrite: totals.cacheCreationTokens,
  output: totals.outputTokens,
});

export class ProjectCostService extends Context.Service<
  ProjectCostService,
  {
    readonly readProjectCost: (
      input: ProjectCostInput,
    ) => Effect.Effect<ProjectCost, ProjectCostReadError>;
    /** Spend over any mix of project, thread, and time range, with the costliest threads. */
    readonly readCostBreakdown: (
      input: CostBreakdownInput,
    ) => Effect.Effect<CostBreakdown, CostBreakdownReadError>;
  }
>()("p0/usage/ProjectCostService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;
  const cache = new Map<string, { readonly atMs: number; readonly cost: ProjectCost }>();
  const breakdownCache = new Map<
    string,
    { readonly atMs: number; readonly breakdown: CostBreakdown }
  >();

  // The turn's reported model wins over the thread's current one, which can change mid-thread.
  // Turn input counts include cache reads and writes, so uncached input is the remainder.
  // Local commands and turns without counts are skipped. The thread columns repeat the sums
  // for one thread so a single pass answers both; an empty thread id matches nothing.
  const readModelTokens = (input: ProjectCostInput) =>
    sql<ModelTokenRow>`
      SELECT
        model,
        SUM(MAX(0, input - cached - created)) AS uncachedInputTokens,
        SUM(cached) AS cachedInputTokens,
        SUM(created) AS cacheCreationTokens,
        SUM(output) AS outputTokens,
        SUM(CASE WHEN thread_id = ${input.threadId ?? ""} THEN MAX(0, input - cached - created) ELSE 0 END) AS threadUncachedInputTokens,
        SUM(CASE WHEN thread_id = ${input.threadId ?? ""} THEN cached ELSE 0 END) AS threadCachedInputTokens,
        SUM(CASE WHEN thread_id = ${input.threadId ?? ""} THEN created ELSE 0 END) AS threadCacheCreationTokens,
        SUM(CASE WHEN thread_id = ${input.threadId ?? ""} THEN output ELSE 0 END) AS threadOutputTokens
      FROM (
        SELECT
          pt.thread_id AS thread_id,
          COALESCE(
            json_extract(pt.payload_json, '$.model'),
            json_extract(pt.payload_json, '$.turnTokenUsage.models[0]'),
            json_extract(th.payload_json, '$.modelSelection.model')
          ) AS model,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens'), 0) AS input,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cachedInputTokens'), 0) AS cached,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cacheCreationTokens'), 0) AS created,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens'), 0) AS output
        FROM orchestration_v2_projection_threads th
        JOIN orchestration_v2_projection_provider_turns pt ON pt.thread_id = th.thread_id
        WHERE th.project_id = ${input.projectId}
          AND json_extract(pt.payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
          AND COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.localCommand'), 0) = 0
      )
      GROUP BY model
    `;

  const readProjectCost = Effect.fn("ProjectCostService.readProjectCost")(function* (
    input: ProjectCostInput,
  ) {
    yield* Effect.annotateCurrentSpan({ projectId: input.projectId });
    const now = yield* Clock.currentTimeMillis;
    const key = `${input.projectId}\0${input.threadId ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined && now - cached.atMs < CACHE_TTL_MS) return cached.cost;

    const rows = yield* readModelTokens(input).pipe(
      Effect.mapError((cause) => new ProjectCostReadError({ projectId: input.projectId, cause })),
    );
    const named = rows.map((row) => ({ row, model: row.model ?? UNKNOWN_MODEL }));
    const projectEntries = named.flatMap(({ row, model }) =>
      hasTokens(projectTotals(row)) ? [{ model, totals: projectTotals(row) }] : [],
    );
    const threadEntries =
      input.threadId === undefined
        ? []
        : named.flatMap(({ row, model }) =>
            hasTokens(threadTotals(row)) ? [{ model, totals: threadTotals(row) }] : [],
          );
    const costs = yield* usage.priceModelTotals([...projectEntries, ...threadEntries]);
    const priced = (entries: typeof projectEntries, offset: number) =>
      sumModelCosts(
        entries.map((entry, index) => ({
          model: entry.model,
          costUsd: costs[offset + index] ?? null,
        })),
      );
    const cost: ProjectCost = {
      project: priced(projectEntries, 0),
      ...(input.threadId === undefined
        ? {}
        : { thread: priced(threadEntries, projectEntries.length) }),
    };

    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { atMs: now, cost });
    return cost;
  });

  // The same turn rules as above, grouped per thread and model so one pass serves any filter.
  // Null filters match everything; turns with no timestamp fall out of a ranged read.
  const readThreadModelTokens = (input: CostBreakdownInput) =>
    sql<ThreadModelRow>`
      SELECT
        thread_id AS threadId,
        project_id AS projectId,
        title,
        model,
        SUM(MAX(0, input - cached - created)) AS uncachedInputTokens,
        SUM(cached) AS cachedInputTokens,
        SUM(created) AS cacheCreationTokens,
        SUM(output) AS outputTokens
      FROM (
        SELECT
          th.thread_id AS thread_id,
          th.project_id AS project_id,
          th.title AS title,
          COALESCE(
            json_extract(pt.payload_json, '$.model'),
            json_extract(pt.payload_json, '$.turnTokenUsage.models[0]'),
            json_extract(th.payload_json, '$.modelSelection.model')
          ) AS model,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens'), 0) AS input,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cachedInputTokens'), 0) AS cached,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cacheCreationTokens'), 0) AS created,
          COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens'), 0) AS output
        FROM orchestration_v2_projection_threads th
        JOIN orchestration_v2_projection_provider_turns pt ON pt.thread_id = th.thread_id
        WHERE json_extract(pt.payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
          AND COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.localCommand'), 0) = 0
          AND (${input.projectId ?? null} IS NULL OR th.project_id = ${input.projectId ?? null})
          AND (${input.threadId ?? null} IS NULL OR th.thread_id = ${input.threadId ?? null})
          AND (${input.since ?? null} IS NULL OR COALESCE(pt.completed_at, pt.started_at) >= ${input.since ?? null})
          AND (${input.until ?? null} IS NULL OR COALESCE(pt.completed_at, pt.started_at) < ${input.until ?? null})
      )
      GROUP BY thread_id, model
    `;

  const readCostBreakdown = Effect.fn("ProjectCostService.readCostBreakdown")(function* (
    input: CostBreakdownInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const key = [input.projectId, input.threadId, input.since, input.until, input.top].join(" ");
    const cached = breakdownCache.get(key);
    if (cached !== undefined && now - cached.atMs < CACHE_TTL_MS) return cached.breakdown;

    const rows = yield* readThreadModelTokens(input).pipe(
      Effect.mapError((cause) => new CostBreakdownReadError({ cause })),
    );
    const entries = rows.flatMap((row) => {
      const totals = rowTotals(row);
      return hasTokens(totals)
        ? [{ row, model: row.model ?? UNKNOWN_MODEL, totals, tokens: tokensOf(totals) }]
        : [];
    });
    const costs = yield* usage.priceModelTotals(
      entries.map(({ model, totals }) => ({ model, totals })),
    );
    const priced = entries.map((entry, index) => ({ ...entry, costUsd: costs[index] ?? null }));

    const line = (items: ReadonlyArray<(typeof priced)[number]>): CostLine => ({
      ...sumModelCosts(items),
      ...items.reduce((sum, item) => addTokens(sum, item.tokens), NO_TOKENS),
    });
    const byThread = Map.groupBy(priced, ({ row }) => row.threadId);
    const topThreads = [...byThread.values()]
      .map((items) => ({
        threadId: items[0]!.row.threadId,
        projectId: items[0]!.row.projectId,
        title: items[0]!.row.title,
        ...line(items),
      }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, input.top);
    const byModel = [...Map.groupBy(priced, ({ model }) => model)].map(([model, items]) => ({
      model,
      costUsd: items.some((item) => item.costUsd === null)
        ? null
        : items.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
      tokens: items.reduce((sum, item) => addTokens(sum, item.tokens), NO_TOKENS),
    }));
    const breakdown: CostBreakdown = {
      total: line(priced),
      threadCount: byThread.size,
      byModel: byModel.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
      topThreads,
    };

    if (breakdownCache.size >= CACHE_MAX_ENTRIES) breakdownCache.clear();
    breakdownCache.set(key, { atMs: now, breakdown });
    return breakdown;
  });

  return ProjectCostService.of({ readProjectCost, readCostBreakdown });
});

export const layer = Layer.effect(ProjectCostService, make);
