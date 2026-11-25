import {
  collectLimitAccounts,
  type LimitAccount,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ProjectCostService from "../../../usage/ProjectCostService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type P0Namespace, P0ApiError, method } from "./api.ts";

const DEFAULT_TOP = 10;
const MAX_TOP = 50;
const MAX_TITLE_CHARS = 80;

export type UsageServices =
  | McpInvocationContext.McpInvocationContext
  | ServerEnvironment.ServerEnvironment
  | ProviderRegistry.ProviderRegistry
  | UsageLimitSources.UsageLimitSources
  | ThreadManagementService.ThreadManagementService
  | ProjectCostService.ProjectCostService;

const LimitWindow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: Schema.String,
  usedPercent: Schema.Finite,
  leftPercent: Schema.Finite,
  resetsAt: Schema.optionalKey(
    Schema.String.annotate({ description: "ISO time the window refills." }),
  ),
  exhausted: Schema.Boolean.annotate({
    description: "At 100% with the reset still ahead: sends on this account fail until then.",
  }),
  models: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Set when the window covers only these models.",
    }),
  ),
});

const LimitAccountOutput = Schema.Struct({
  driver: Schema.String,
  instanceId: Schema.optionalKey(
    Schema.String.annotate({ description: "The provider instance that reads this account." }),
  ),
  name: Schema.String,
  plan: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(
    Schema.String.annotate({
      description: "The usage hub that reports it, for hub-only accounts.",
    }),
  ),
  exhausted: Schema.Boolean,
  windows: Schema.Array(LimitWindow),
});

const UsageLimitsOutput = Schema.Struct({
  checkedAt: Schema.String,
  accounts: Schema.Array(LimitAccountOutput),
});

const Tokens = {
  input: Schema.Int.annotate({ description: "Uncached input tokens." }),
  cachedInput: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int,
};

const CostLine = Schema.Struct({
  costUsd: Schema.Finite,
  partial: Schema.Boolean.annotate({
    description: "A model had no known price, so the real cost is higher.",
  }),
  unpricedModels: Schema.Array(Schema.String),
  ...Tokens,
});

const UsageCostsInput = Schema.Struct({
  since: Schema.optionalKey(
    Schema.String.annotate({ description: "Inclusive start: a date (2026-11-17) or ISO time." }),
  ),
  until: Schema.optionalKey(
    Schema.String.annotate({ description: "Exclusive end, same formats." }),
  ),
  projectId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Rank and total only this project's threads. \"current\" is the calling thread's.",
    }),
  ),
  top: Schema.optionalKey(
    Schema.Int.annotate({
      description: `Costliest threads to list. Default ${DEFAULT_TOP}, max ${MAX_TOP}.`,
    }),
  ),
});

const UsageCostsOutput = Schema.Struct({
  estimate: Schema.Literal(true).annotate({
    description: "Costs are API list prices times token counts, not what any provider billed.",
  }),
  thisThread: Schema.NullOr(CostLine).annotate({
    description: "The calling thread; null with no spend.",
  }),
  thisProject: Schema.NullOr(
    Schema.Struct({ projectId: Schema.String, ...CostLine.fields }),
  ).annotate({ description: "The calling thread's project." }),
  total: CostLine.annotate({ description: "Everything the filters match." }),
  threadCount: Schema.Int,
  byModel: Schema.Array(
    Schema.Struct({ model: Schema.String, costUsd: Schema.NullOr(Schema.Finite), ...Tokens }),
  ),
  topThreads: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      projectId: Schema.String,
      ...CostLine.fields,
    }),
  ),
});

const unavailable = (detail: string) => (cause: unknown) => new P0ApiError({ detail, cause });

const round = (value: number) => Math.round(value * 10_000) / 10_000;

const nameOf = (account: LimitAccount) =>
  account.displayName ?? account.email ?? account.sourceLabel ?? account.driver;

const toAccount = (account: LimitAccount, now: number) => {
  const windows = account.limits.windows.map((window) => ({
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: Math.round(window.usedPercent),
    leftPercent: remainingPercent(window),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    exhausted:
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || !(Date.parse(window.resetsAt) <= now)),
    ...(window.modelIds?.length ? { models: window.modelIds } : {}),
  }));
  return {
    driver: account.driver,
    ...(account.instanceId === undefined ? {} : { instanceId: account.instanceId }),
    name: nameOf(account),
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    ...(account.sourceLabel === null ? {} : { source: account.sourceLabel }),
    exhausted: windows.some((window) => window.exhausted),
    windows,
  };
};

const limits = method("usage", {
  name: "limits",
  doc: "Every provider account's usage-limit windows (session, weekly, monthly): percent used and left, reset time, and whether it is exhausted. One row per upstream account, however many instances or hubs report it; accounts that report no limits are left out.",
  input: Schema.Struct({}),
  output: UsageLimitsOutput,
  run: Effect.fn("p0.usage.limits")(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const descriptor = yield* environment.getDescriptor;
    const providers = yield* registry.getProviders;
    const usageLimitSources = yield* sources.current;
    const now = yield* Clock.currentTimeMillis;
    const accounts = collectLimitAccounts(
      new Map([
        [
          descriptor.environmentId,
          {
            entry: { target: { label: descriptor.label } },
            serverConfig: { providers, usageLimitSources },
          },
        ],
      ]),
    );
    return {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      accounts: accounts.map((account) => toAccount(account, now)),
    };
  }),
});

const parseTime = (name: string, value: string | undefined) => {
  if (value === undefined) return Effect.undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed)
    ? Effect.succeed(DateTime.formatIso(parsed.value))
    : Effect.fail(
        new P0ApiError({ detail: `Invalid options for p0.usage.costs: ${name} is not a date.` }),
      );
};

const costs = method("usage", {
  name: "costs",
  doc: "Token spend and estimated API cost for this chat, its project, and across chats: the costliest threads and totals by model, optionally within a time range or one project. Estimates only, from list prices.",
  input: UsageCostsInput,
  output: UsageCostsOutput,
  run: Effect.fn("p0.usage.costs")(function* (input) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const costService = yield* ProjectCostService.ProjectCostService;
    const since = yield* parseTime("since", input.since);
    const until = yield* parseTime("until", input.until);
    const top = Math.min(MAX_TOP, Math.max(1, input.top ?? DEFAULT_TOP));
    const threadId = scope.thread?.threadId;
    const shell =
      threadId === undefined
        ? null
        : yield* threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(unavailable("Could not read this thread.")));
    const currentProjectId = shell?.projectId;
    const projectId = input.projectId === "current" ? currentProjectId : input.projectId;
    const read = (filter: {
      readonly projectId?: string;
      readonly threadId?: string;
      readonly top: number;
    }) =>
      costService
        .readCostBreakdown({
          ...filter,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
        })
        .pipe(Effect.mapError(unavailable("Could not read token spend.")));

    const [matching, thread, project] = yield* Effect.all(
      [
        read({ ...(projectId === undefined ? {} : { projectId }), top }),
        threadId === undefined ? Effect.succeed(null) : read({ threadId, top: 1 }),
        currentProjectId === undefined || currentProjectId === projectId
          ? Effect.succeed(null)
          : read({ projectId: currentProjectId, top: 1 }),
      ],
      { concurrency: "unbounded" },
    );
    const line = (cost: ProjectCostService.CostLine) => ({
      costUsd: round(cost.costUsd),
      partial: cost.partial,
      unpricedModels: cost.unpricedModels,
      input: cost.input,
      cachedInput: cost.cachedInput,
      cacheWrite: cost.cacheWrite,
      output: cost.output,
    });
    const projectBreakdown = currentProjectId === projectId ? matching : project;
    return {
      estimate: true as const,
      thisThread: thread === null || thread.threadCount === 0 ? null : line(thread.total),
      thisProject:
        projectBreakdown === null ||
        currentProjectId === undefined ||
        projectBreakdown.threadCount === 0
          ? null
          : { projectId: currentProjectId, ...line(projectBreakdown.total) },
      total: line(matching.total),
      threadCount: matching.threadCount,
      byModel: matching.byModel.map(({ model, costUsd, tokens }) => ({
        model,
        costUsd: costUsd === null ? null : round(costUsd),
        ...tokens,
      })),
      topThreads: matching.topThreads.map(({ threadId: id, title, projectId: owner, ...cost }) => ({
        threadId: id,
        title: Array.from(title).slice(0, MAX_TITLE_CHARS).join(""),
        projectId: owner,
        ...line(cost),
      })),
    };
  }),
});

export const usageNamespace: P0Namespace<UsageServices> = {
  name: "usage",
  doc: "your provider accounts' quota limits and your chats' token spend and cost",
  methods: [limits, costs],
};
