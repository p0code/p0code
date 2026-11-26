import {
  CommandId,
  isOpenEndedSnooze,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import {
  autoSwitchesAccountOnLimit,
  limitFailoverSelection,
} from "@t3tools/shared/accountProfiles";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { routineSpan } from "@t3tools/shared/observability";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;
const FAILOVER_WINDOW_MS = 60_000;

/**
 * `defaultAutoResume` is the environment setting; a thread's own choice overrides it.
 * `failover` is the next account the active profile would continue on, when it switches on its own;
 * switching beats waiting for the reset.
 */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  defaultAutoResume: boolean,
  nowMs: number,
  snooze = false,
  failover: ModelSelection | null = null,
): OrchestrationV2Command | null {
  const hidden = isOpenEndedSnooze(thread.snoozedUntil);
  const autoResume = thread.autoResumeAtLimitReset ?? (hidden ? false : defaultAutoResume);
  if (hidden && thread.autoResumeAtLimitReset !== true) return null;
  const timedSnooze =
    thread.snoozedUntil != null && !hidden && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs;
  if (timedSnooze) return null;
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const failedAtMs = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  // A thread that opted out of auto-resume, or already waits for this run's reset, stays put.
  if (
    failover !== null &&
    thread.autoResumeAtLimitReset !== false &&
    thread.limitRecovery?.runId !== thread.latestRunId &&
    nowMs - failedAtMs <= FAILOVER_WINDOW_MS
  ) {
    const identity = `${thread.id}:${thread.latestRunId}`;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-failover:${identity}`),
      messageId: MessageId.make(`limit-failover:${identity}`),
      threadId: thread.id,
      manualContinuationOfRunId: thread.latestRunId,
      modelSelection: failover,
      text: "",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    };
  }
  if (!thread.usageLimitResetAt) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    // A timed snooze holds the resume until it wakes; hiding a thread does not pause its work.
    (thread.snoozedUntil != null &&
      !isOpenEndedSnooze(thread.snoozedUntil) &&
      DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const due = DueHint.make();
  const failedCommands = new Set<string>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep", { attributes: routineSpan })(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const failover = autoSwitchesAccountOnLimit(preferences);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      failoverSince: failover ? DateTime.subtract(now, { milliseconds: FAILOVER_WINDOW_MS }) : null,
    });
    const providers = failover && candidates.length > 0 ? yield* providerRegistry.getProviders : [];
    let acted = false;
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        failover
          ? limitFailoverSelection({
              selection: thread.modelSelection,
              providers,
              settings: preferences,
              projectId: thread.projectId,
              now: nowMs,
            })
          : null,
      );
      if (command === null || failedCommands.has(command.commandId)) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => failedCommands.add(command.commandId)).pipe(
            Effect.andThen(
              Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
                threadId: thread.id,
                cause,
              }),
            ),
          ),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
