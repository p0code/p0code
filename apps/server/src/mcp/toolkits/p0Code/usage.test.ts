import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ProjectCostService from "../../../usage/ProjectCostService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { usageNamespace } from "./usage.ts";

const environmentId = EnvironmentId.make("environment:usage");
const threadId = ThreadId.make("thread:usage");
const NOW = Date.parse("2026-09-03T12:00:00.000Z");

const method = (name: "limits" | "costs") => {
  const found = usageNamespace.methods.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`p0.usage.${name} is missing`);
  return found;
};

const provider = (overrides: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 100,
  resetsAt: "2026-09-08T00:00:00.000Z",
} as const;

const limitsLayer = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot> = [],
) =>
  Layer.mergeAll(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "This Mac",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed(sources) }),
  );

type BreakdownInput = Parameters<
  ProjectCostService.ProjectCostService["Service"]["readCostBreakdown"]
>[0];

const line = (costUsd: number, extra: Partial<ProjectCostService.CostLine> = {}) => ({
  costUsd,
  partial: false,
  unpricedModels: [],
  input: 100,
  cachedInput: 200,
  cacheWrite: 10,
  output: 50,
  ...extra,
});

/** Answers by filter, so a test sees which of thread, project, and everything it asked about. */
const costsOnlyLayer = (seen: Array<BreakdownInput>) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId,
      requestNamespace: "provider:usage",
      thread: {
        threadId,
        providerSessionId: "provider:usage",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
    }),
    Layer.mock(ProjectCostService.ProjectCostService)({
      readCostBreakdown: (input) =>
        Effect.sync(() => {
          seen.push(input);
          const scope =
            input.threadId !== undefined
              ? "thread"
              : input.projectId !== undefined
                ? "project"
                : "all";
          const cost = { thread: 1.23456, project: 5, all: 20 }[scope];
          return {
            total: line(
              cost,
              scope === "all" ? { partial: true, unpricedModels: ["mystery"] } : {},
            ),
            threadCount: scope === "thread" && input.until === "2000-01-01T00:00:00.000Z" ? 0 : 3,
            byModel: [
              {
                model: "model-a",
                costUsd: 15.5,
                tokens: { input: 1, cachedInput: 2, cacheWrite: 3, output: 4 },
              },
              {
                model: "mystery",
                costUsd: null,
                tokens: { input: 5, cachedInput: 6, cacheWrite: 7, output: 8 },
              },
            ],
            topThreads: [
              {
                ...line(12),
                threadId: "thread-big",
                projectId: "project-x",
                title: "x".repeat(200),
              },
            ],
          };
        }),
    }),
  );

const costsLayer = (seen: Array<BreakdownInput>) =>
  Layer.mergeAll(costsOnlyLayer(seen), limitsLayer([]));

const limitsAndCosts = (...args: Parameters<typeof limitsLayer>) =>
  Layer.mergeAll(limitsLayer(...args), costsOnlyLayer([]));

describe("p0.usage.limits", () => {
  it.effect("lists each account once with its windows, and flags exhausted ones", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const result = yield* method("limits").run(undefined);

      assert.deepEqual(result, {
        checkedAt: "2026-09-03T12:00:00.000Z",
        accounts: [
          {
            driver: "codex",
            instanceId: "codex",
            name: "Codex",
            plan: "Pro",
            exhausted: true,
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 40,
                leftPercent: 60,
                resetsAt: "2026-09-03T14:00:00.000Z",
                exhausted: false,
              },
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 100,
                leftPercent: 0,
                resetsAt: "2026-09-08T00:00:00.000Z",
                exhausted: true,
              },
            ],
          },
        ],
      });
    }).pipe(
      Effect.provide(
        limitsAndCosts([
          provider({
            displayName: "Codex",
            auth: { status: "authenticated", email: "me@example.com", label: "Pro" },
            usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session, weekly] },
          }),
        ]),
      ),
    ),
  );

  it.effect("does not list one upstream account twice, or accounts with no limits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const result = (yield* method("limits").run(undefined)) as {
        readonly accounts: ReadonlyArray<{ readonly instanceId?: string; readonly name: string }>;
      };

      // Two instances and a hub row all read me@example.com, so one row, which a hub email
      // names better than the default instance name. The third login reports no windows.
      assert.deepEqual(
        result.accounts.map(({ instanceId, name }) => ({ instanceId, name })),
        [
          { instanceId: "codex", name: "me@example.com" },
          { instanceId: "claude", name: "Claude" },
        ],
      );
    }).pipe(
      Effect.provide(
        limitsAndCosts(
          [
            provider({
              displayName: "Codex",
              auth: { status: "authenticated", email: "me@example.com" },
              usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session] },
            }),
            provider({
              instanceId: ProviderInstanceId.make("codex_work"),
              displayName: "Codex (work)",
              auth: { status: "authenticated", email: "Me@Example.com" },
              usageLimits: { checkedAt: "2026-09-03T10:00:00.000Z", windows: [session] },
            }),
            provider({
              instanceId: ProviderInstanceId.make("claude"),
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "Claude",
              auth: { status: "authenticated", email: "other@example.com" },
              usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [weekly] },
            }),
            provider({
              instanceId: ProviderInstanceId.make("cursor"),
              driver: ProviderDriverKind.make("cursor"),
              auth: { status: "authenticated", email: "third@example.com" },
              usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
            }),
          ],
          [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy",
              label: "Hub",
              checkedAt: "2026-09-03T11:00:00.000Z",
              accounts: [
                {
                  id: "me.json",
                  driver: ProviderDriverKind.make("codex"),
                  email: "me@example.com",
                  usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session] },
                },
              ],
            },
          ],
        ),
      ),
    ),
  );

  it.effect("names a hub-only account by its login and says which hub reports it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const result = (yield* method("limits").run({})) as {
        readonly accounts: ReadonlyArray<Record<string, unknown>>;
      };
      assert.deepEqual(
        result.accounts.map(({ name, source, instanceId, plan }) => ({
          name,
          source,
          instanceId,
          plan,
        })),
        [{ name: "hub@example.com", source: "Hub", instanceId: undefined, plan: "Plus" }],
      );
    }).pipe(
      Effect.provide(
        limitsAndCosts(
          [],
          [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy",
              label: "Hub",
              checkedAt: "2026-09-03T11:00:00.000Z",
              accounts: [
                {
                  id: "hub.json",
                  driver: ProviderDriverKind.make("codex"),
                  email: "hub@example.com",
                  plan: "Plus",
                  usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session] },
                },
              ],
            },
          ],
        ),
      ),
    ),
  );
});

describe("p0.usage.costs", () => {
  it.effect("reports this thread, its project, and the ranking across everything", () =>
    Effect.gen(function* () {
      const seen: Array<BreakdownInput> = [];
      const result = (yield* method("costs")
        .run({ since: "2026-11-17", until: "2026-11-24T12:00:00Z" })
        .pipe(Effect.provide(costsLayer(seen)))) as Record<string, unknown>;

      assert.strictEqual(result.estimate, true);
      assert.deepEqual(result.thisThread, line(1.2346));
      assert.deepEqual(result.thisProject, { projectId: "project:mcp-test", ...line(5) });
      assert.deepEqual(result.total, line(20, { partial: true, unpricedModels: ["mystery"] }));
      assert.strictEqual(result.threadCount, 3);
      assert.deepEqual(result.byModel, [
        { model: "model-a", costUsd: 15.5, input: 1, cachedInput: 2, cacheWrite: 3, output: 4 },
        { model: "mystery", costUsd: null, input: 5, cachedInput: 6, cacheWrite: 7, output: 8 },
      ]);
      const [top] = result.topThreads as ReadonlyArray<{ readonly title: string }>;
      assert.strictEqual(top?.title.length, 80);

      const range = { since: "2026-11-17T00:00:00.000Z", until: "2026-11-24T12:00:00.000Z" };
      assert.sameDeepMembers(seen, [
        { top: 10, ...range },
        { threadId, top: 1, ...range },
        { projectId: "project:mcp-test", top: 1, ...range },
      ]);
    }),
  );

  it.effect("reads the current project once when asked to rank it", () =>
    Effect.gen(function* () {
      const seen: Array<BreakdownInput> = [];
      const result = (yield* method("costs")
        .run({ projectId: "current", top: 500 })
        .pipe(Effect.provide(costsLayer(seen)))) as Record<string, unknown>;

      assert.sameDeepMembers(seen, [
        { projectId: "project:mcp-test", top: 50 },
        { threadId, top: 1 },
      ]);
      assert.deepEqual(result.thisProject, { projectId: "project:mcp-test", ...line(5) });
      assert.deepEqual(result.total, line(5));
    }),
  );

  it.effect("ranks another project and keeps a top of at least one", () =>
    Effect.gen(function* () {
      const seen: Array<BreakdownInput> = [];
      yield* method("costs")
        .run({ projectId: "project-x", top: 0 })
        .pipe(Effect.provide(costsLayer(seen)));
      assert.deepInclude(seen, { projectId: "project-x", top: 1 });
    }),
  );

  it.effect("answers null for a thread with no spend in the range", () =>
    Effect.gen(function* () {
      const result = (yield* method("costs")
        .run({ since: "1999-01-01", until: "2000-01-01" })
        .pipe(Effect.provide(costsLayer([])))) as Record<string, unknown>;
      assert.isNull(result.thisThread);
      assert.isNotNull(result.thisProject);
    }),
  );

  it.effect("refuses a date it cannot read, and unknown options", () =>
    Effect.gen(function* () {
      const badDate = yield* method("costs")
        .run({ since: "last tuesday" })
        .pipe(Effect.asVoid, Effect.flip, Effect.provide(costsLayer([])));
      assert.include(badDate.message, "since is not a date");
      const badTop = yield* method("costs")
        .run({ top: "ten" })
        .pipe(Effect.asVoid, Effect.flip, Effect.provide(costsLayer([])));
      assert.include(badTop.message, "Invalid options for p0.usage.costs");
    }),
  );
});
