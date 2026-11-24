import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { makeJudgePanel, resolveJudges } from "./JudgePanelService.ts";

const provider = (id: string, enabled = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-25T00:00:00.000Z",
  models: [{ slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "test",
  thread: {
    threadId: ThreadId.make("parent"),
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const result: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("task"),
  childThreadId: ThreadId.make("child"),
  childRunId: null,
  childNodeId: NodeId.make("node"),
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
};

it("resolves unpinned drivers to the first enabled instance, preserves pins, and skips missing models", () => {
  const members = [
    { driverKind: ProviderDriverKind.make("codex"), model: "gpt-6.1-sol", enabled: true },
    { providerInstanceId: ProviderInstanceId.make("second"), model: "gpt-6.1-sol", enabled: true },
    { driverKind: ProviderDriverKind.make("codex"), model: "missing", enabled: true },
    { driverKind: ProviderDriverKind.make("codex"), model: "gpt-6.1-sol", enabled: false },
  ];
  const resolved = resolveJudges(members, [
    provider("off", false),
    provider("first"),
    provider("second"),
  ]);
  expect(resolved.map((entry) => entry.target?.providerInstanceId)).toEqual([
    "first",
    "second",
    undefined,
  ]);
  const signedOut = resolveJudges(members.slice(0, 1), [
    { ...provider("first"), auth: { status: "unauthenticated" } },
  ])[0];
  expect(signedOut?.target).toBeUndefined();
  expect(signedOut?.unavailableReason).toBe("provider unauthenticated");
  expect(
    resolveJudges(members.slice(0, 1), [
      { ...provider("first"), installed: false },
      provider("second"),
    ])[0]?.target,
  ).toBeUndefined();
});

it.effect("fans out every available judge and retains launches when another judge fails", () =>
  Effect.gen(function* () {
    const launched: OrchestratorMcpDelegateTaskInput[] = [];
    const judges = ["first", "second"].map((id) => ({
      providerInstanceId: ProviderInstanceId.make(id),
      model: "gpt-6.1-sol",
      enabled: true,
    }));
    const panel = makeJudgePanel({
      settings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, judges }),
      providers: Effect.succeed([provider("first"), provider("second")]),
      delegate: (_, input) => {
        launched.push(input);
        return input.target?.providerInstanceId === "second"
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Provider unavailable",
              }),
            )
          : Effect.succeed(result);
      },
    });
    const denied = yield* panel.convene(scope, { asCoordinator: true }).pipe(Effect.flip);
    expect(denied.code).toBe("capability_denied");
    yield* panel.convene(scope, {});
    launched.length = 0;
    const report = yield* panel.convene(
      { ...scope, thread: { ...scope.thread!, threadId: result.childThreadId! } },
      {
        asCoordinator: true,
        focus: "Review authentication",
        clientRequestId: "panel",
      },
    );
    expect(
      launched.map((task) => [
        task.target?.providerInstanceId,
        task.role,
        task.isolation,
        task.mode,
      ]),
    ).toEqual([
      ["first", "review", "shared", "async"],
      ["second", "review", "shared", "async"],
    ]);
    for (const task of launched) {
      expect(task.interactionMode).toBe("plan");
      expect(task.runtimeMode).toBe("approval-required");
    }
    expect(report.tasks).toEqual([result]);
    expect(report.skipped).toEqual(["gpt-6.1-sol: Provider unavailable"]);
    expect(launched.map((task) => task.clientRequestId)).toEqual([
      "panel:judge:0",
      "panel:judge:1",
    ]);
  }),
);

it.effect("starts one coordinator and rejects panels with no available judges", () =>
  Effect.gen(function* () {
    const launched: OrchestratorMcpDelegateTaskInput[] = [];
    const panel = makeJudgePanel({
      settings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      providers: Effect.succeed([provider("codex")]),
      delegate: (_, input) => {
        launched.push(input);
        return Effect.succeed(result);
      },
    });
    const report = yield* panel.convene(
      { ...scope, environmentId: EnvironmentId.make("other") },
      {},
    );
    for (const task of launched) {
      expect(task.interactionMode).toBe("plan");
      expect(task.runtimeMode).toBe("approval-required");
    }
    expect(report.tasks).toEqual([result]);
    expect(report.skipped).toHaveLength(3);
    expect(launched).toHaveLength(1);
    const error = yield* panel.convene(scope, { members: [] }).pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(launched).toHaveLength(1);
  }),
);
