import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as PublicTunnels from "../../../tunnels/PublicTunnels.ts";
import * as ProjectCostService from "../../../usage/ProjectCostService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { declarationsFor } from "./api.ts";
import * as P0Handlers from "./handlers.ts";
import { P0_NAMESPACES } from "./namespaces.ts";
import { P0CodeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:p0-code");
const threadId = ThreadId.make("thread:p0-code");

const exhaustedWeekly = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 100,
  resetsAt: "2999-01-01T00:00:00.000Z",
} as const;

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "me@example.com" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [exhaustedWeekly] },
  },
];

const costLine = (costUsd: number) => ({
  costUsd,
  partial: false,
  unpricedModels: [],
  input: 1,
  cachedInput: 2,
  cacheWrite: 3,
  output: 4,
});

const layerFor = (scope: Partial<McpInvocationContext.McpInvocationScope> = {}) =>
  McpToolAccess.HandlersLayer.layer(P0Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:p0-code",
          thread: {
            threadId,
            providerSessionId: "provider:p0-code",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          ...scope,
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(PublicTunnels.PublicTunnels)({
          allowName: () => false,
          activeNames: () => [],
          accept: () => {},
          closeSockets: () => {},
          registerServerPort: () => {},
        }),
        ServerSettingsService.ServerSettingsService.layerTest(),
        Layer.mock(ProjectCostService.ProjectCostService)({
          readCostBreakdown: (input) =>
            Effect.succeed({
              total: costLine(10),
              threadCount: 2,
              byModel: [],
              topThreads:
                input.threadId === undefined && input.projectId === undefined
                  ? [
                      { ...costLine(7), threadId: "t-1", projectId: "p-1", title: "Refactor" },
                      { ...costLine(3), threadId: "t-2", projectId: "p-1", title: "Fix" },
                    ]
                  : [],
            }),
        }),
      ),
    ),
  );

const callTool = (code: string, scope?: Partial<McpInvocationContext.McpInvocationScope>) =>
  Effect.gen(function* () {
    const toolkit = yield* P0CodeToolkit;
    const results = yield* toolkit
      .handle("p0_code", { code })
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  }).pipe(Effect.provide(layerFor(scope)));

it.live("runs a snippet written against the declarations the search gives", () =>
  Effect.gen(function* () {
    const declarations = declarationsFor(P0_NAMESPACES, "usage cost") ?? "";
    expect(declarations).toContain("function limits(): Promise<");
    expect(declarations).toContain("topThreads");

    const result = yield* callTool(`
      const { accounts } = await p0.usage.limits();
      const costs = await p0.usage.costs({ top: 5 });
      console.log("accounts", accounts.length);
      return {
        exhausted: accounts.filter((account) => account.exhausted).map((account) => account.name),
        costliest: costs.topThreads[0].title,
        share: Math.round((costs.topThreads[0].costUsd / costs.total.costUsd) * 100),
        estimate: costs.estimate,
      };
    `);

    expect(result).toEqual({
      result: { exhausted: ["Codex"], costliest: "Refactor", share: 70, estimate: true },
      logs: ["accounts 1"],
    });
  }),
);

it.live("returns the API declarations from p0.help", () =>
  Effect.gen(function* () {
    const result = yield* callTool(`return [await p0.help("cost"), await p0.help("browser")];`);
    expect(result).toEqual({
      result: [
        declarationsFor(P0_NAMESPACES, "cost"),
        "No p0 API matches. Namespaces: usage, tunnels.",
      ],
    });
  }),
);

it.live("fails with the snippet's error and its console output", () =>
  Effect.gen(function* () {
    const result = yield* callTool(`console.log("before"); return await p0.usage.nope();`);
    expect(result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("p0.usage.nope is not a function"),
    });
    expect(result).toMatchObject({ message: expect.stringContaining("before") });
  }),
);

it.live("tells the snippet which options were invalid", () =>
  Effect.gen(function* () {
    const result = yield* callTool(`return await p0.usage.costs({ top: "ten" });`);
    expect(result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Invalid options for p0.usage.costs"),
    });
  }),
);

it.live("refuses a caller that is not a thread", () =>
  Effect.gen(function* () {
    const result = yield* callTool(`return 1;`, { thread: undefined });
    expect(result).toMatchObject({ code: "thread_credential_required" });
  }),
);

it.live("refuses a credential that cannot read threads", () =>
  Effect.gen(function* () {
    const result = yield* callTool(`return 1;`, { capabilities: new Set() });
    expect(result).toMatchObject({ code: "capability_denied" });
  }),
);
