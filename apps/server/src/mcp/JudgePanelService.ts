import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { OrchestratorMcpConveneJudgesInput as PanelInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  type JudgeMember,
  type OrchestratorMcpConveneJudgesInput,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const coordinators = new Set<string>();
const expandedCoordinators = new Set<string>();
const reviewers = new Set<string>();
const coordinatorKey = (scope: McpInvocationScope, threadId: string) =>
  `${scope.environmentId}:${threadId}`;
export const markReviewThread = (scope: McpInvocationScope, threadId: string) =>
  reviewers.add(coordinatorKey(scope, threadId));
export const isJudgeReviewer = (scope: McpInvocationScope) =>
  scope.thread !== undefined && reviewers.has(coordinatorKey(scope, scope.thread.threadId));

export const judgeToolEnabled = () => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope === undefined || (scope.thread !== undefined && !isJudgeReviewer(scope));
};

const encodePanelRequest = Schema.encodeSync(Schema.fromJsonString(PanelInput));

export function resolveJudges(
  members: ReadonlyArray<JudgeMember>,
  providers: ReadonlyArray<ServerProvider>,
) {
  return members
    .filter((member) => member.enabled)
    .map((member) => {
      const provider = providers.find(
        (provider) =>
          provider.enabled &&
          (member.providerInstanceId
            ? provider.instanceId === member.providerInstanceId
            : provider.driver === member.driverKind),
      );
      return {
        member,
        unavailableReason: !provider
          ? "provider unavailable"
          : !provider.installed
            ? "provider not installed"
            : provider.auth.status === "unauthenticated"
              ? "provider unauthenticated"
              : provider.status === "error"
                ? "provider error"
                : "model missing",
        target:
          provider?.installed &&
          provider.status !== "error" &&
          provider.auth.status !== "unauthenticated" &&
          provider.models.some((model) => model.slug === member.model)
            ? {
                providerInstanceId: provider.instanceId,
                model: member.model,
                ...(member.options ? { options: member.options } : {}),
              }
            : undefined,
      };
    });
}

/** The coordinator owns the reviewer completion cohort and returns one report to the main agent. */
export function makeJudgePanel(deps: {
  settings: Effect.Effect<ServerSettings, OrchestratorMcpFailure>;
  providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  delegate: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
}) {
  return {
    convene: Effect.fn("JudgePanelService.convene")(function* (
      scope: McpInvocationScope,
      input: OrchestratorMcpConveneJudgesInput,
    ) {
      const key = scope.thread ? coordinatorKey(scope, scope.thread.threadId) : undefined;
      if (
        isJudgeReviewer(scope) ||
        (input.asCoordinator &&
          (key === undefined || !coordinators.has(key) || expandedCoordinators.has(key))) ||
        (!input.asCoordinator && key !== undefined && coordinators.has(key))
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Only this panel's coordinator may launch its judges; reviewers cannot create panels.",
        });
      const settings = yield* deps.settings;
      const resolved = resolveJudges(input.members ?? settings.judges, yield* deps.providers);
      const available = resolved.flatMap((entry) =>
        entry.target ? [{ ...entry, target: entry.target }] : [],
      );
      const skipped = resolved
        .filter((entry) => !entry.target)
        .map((entry) => `${entry.member.model}: ${entry.unavailableReason}`);
      if (available.length === 0)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "No enabled judges have an available provider and model. Configure Judges in Settings.",
        });
      const focus = input.focus ?? settings.judgeDefaultScope;
      if (input.asCoordinator) {
        if (key) expandedCoordinators.add(key);
        const tasks = yield* Effect.forEach(
          available,
          (entry, index) =>
            deps
              .delegate(scope, {
                task: `${settings.judgeInstructions}\n\nScope: ${focus}\n\nYou are independent judge ${index + 1} (${entry.member.model}). Do not read other judges' reports. Only inspect; do not edit files or delegate further. Return concrete severity-ranked file:line findings to the panel coordinator.`,
                title: `Judge ${index + 1}: ${entry.member.model}`,
                target: entry.target,
                role: "review",
                interactionMode: "plan",
                runtimeMode: "approval-required",
                isolation: "shared",
                mode: "async",
                ...(input.clientRequestId
                  ? { clientRequestId: `${input.clientRequestId}:judge:${index}` }
                  : {}),
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        for (const result of tasks)
          if (result._tag === "Success" && result.success.childThreadId !== null)
            reviewers.add(coordinatorKey(scope, result.success.childThreadId));
        return {
          tasks: tasks.flatMap((result) => (result._tag === "Success" ? [result.success] : [])),
          skipped: [
            ...skipped,
            ...tasks.flatMap((result, index) =>
              result._tag === "Failure"
                ? [`${available[index]!.member.model}: ${result.failure.message}`]
                : [],
            ),
          ],
        };
      }
      const members = available.map((entry) => ({
        ...entry.member,
        providerInstanceId: entry.target.providerInstanceId,
      }));
      const request = encodePanelRequest({
        members,
        focus,
        asCoordinator: true,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      });
      const coordinator = yield* deps.delegate(scope, {
        title: "Judges panel",
        task: `Coordinate an independent panel of judges. Do not edit files or implement fixes. First call convene_judges with this exact JSON: ${request}\nWait for ALL launched judges to finish using existing completion notifications; do not poll or finish while children are working. If a judge fails, report that explicitly. Do not launch replacements. Then return ONE aggregated report to your parent: deduplicate findings by underlying issue, group by severity P0/P1/P2/P3, include concrete file:line evidence and the models that agreed. Preserve disagreements and single-judge findings. Include skipped or failed models and say explicitly if no actionable findings were found. The parent agent should validate findings, fix real issues, and run relevant tests.\nUnavailable judges skipped before launch: ${skipped.join(", ") || "none"}.\nReviewer rubric: ${settings.judgeInstructions}`,
        role: "review",
        interactionMode: "plan",
        runtimeMode: "approval-required",
        isolation: "shared",
        mode: "async",
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      });
      if (coordinator.childThreadId === null)
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Judge coordinator did not create a child thread.",
        });
      reviewers.delete(coordinatorKey(scope, coordinator.childThreadId));
      coordinators.add(coordinatorKey(scope, coordinator.childThreadId));
      return { tasks: [coordinator], skipped };
    }),
  };
}
