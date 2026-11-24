import { assert, describe, it } from "@effect/vitest";
import {
  OPEN_ENDED_SNOOZE_UNTIL,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
              accountProfiles: [],
              activeAccountProfileId: null,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    projectId: ProjectId.make("project:limited"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudePersonal"), model: "opus" },
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("limitRecoveryCommand per-thread auto-resume", () => {
  const resetInAnHour = () => failedThread(1000, -HOUR_MS);
  // Armed earlier, and the reset has just passed.
  const armedAfterReset = () => {
    const thread = failedThread(2 * HOUR_MS, 1);
    return {
      ...thread,
      limitRecovery: {
        runId: thread.latestRunId!,
        resetAt: thread.usageLimitResetAt!,
        autoResume: true,
      },
    };
  };

  it("a pre-armed thread arms auto-resume when the environment default is off", () => {
    const arm = limitRecoveryCommand(
      { ...resetInAnHour(), autoResumeAtLimitReset: true },
      false,
      nowMs,
    );
    assert.equal(arm?.type, "thread.metadata.update");
    assert.equal(
      arm?.type === "thread.metadata.update" ? arm.limitRecovery?.autoResume : undefined,
      true,
    );
  });

  it("a thread that opted out does not arm when the environment default is on", () => {
    assert.isNull(
      limitRecoveryCommand({ ...resetInAnHour(), autoResumeAtLimitReset: false }, true, nowMs),
    );
  });

  it("a hidden thread still resumes, a timed snooze holds the resume", () => {
    const armed = armedAfterReset();
    const hidden = { ...armed, snoozedUntil: DateTime.makeUnsafe(OPEN_ENDED_SNOOZE_UNTIL) };
    assert.isNull(limitRecoveryCommand(hidden, true, nowMs));
    assert.equal(
      limitRecoveryCommand({ ...hidden, autoResumeAtLimitReset: true }, false, nowMs)?.type,
      "message.dispatch",
    );
    const snoozed = { ...armed, snoozedUntil: DateTime.makeUnsafe(nowMs + HOUR_MS) };
    assert.isNull(limitRecoveryCommand(snoozed, false, nowMs));
  });
});

describe("limitRecoveryCommand account failover", () => {
  const second = { instanceId: ProviderInstanceId.make("claudeSecond"), model: "opus" };
  const resetInAnHour = () => failedThread(1000, -HOUR_MS);

  it("holds automatic failover during timed snoozes and hidden threads need explicit opt-in", () => {
    const thread = resetInAnHour();
    assert.isNull(
      limitRecoveryCommand(
        { ...thread, snoozedUntil: DateTime.makeUnsafe(nowMs + HOUR_MS) },
        true,
        nowMs,
        false,
        second,
      ),
    );
    assert.isNull(
      limitRecoveryCommand(
        { ...thread, snoozedUntil: DateTime.makeUnsafe(OPEN_ENDED_SNOOZE_UNTIL) },
        true,
        nowMs,
        false,
        second,
      ),
    );
  });

  it("continues on the next account instead of waiting for the reset", () => {
    const command = limitRecoveryCommand(resetInAnHour(), true, nowMs, false, second);
    assert.equal(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.deepEqual(command.modelSelection, second);
    assert.equal(command.manualContinuationOfRunId, "run:limited");
  });

  it("switches a limit that reported no reset time", () => {
    const thread = { ...resetInAnHour(), usageLimitResetAt: null };
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.equal(
      limitRecoveryCommand(thread, false, nowMs, false, second)?.type,
      "message.dispatch",
    );
  });

  it("leaves threads that opted out, already wait for this reset, or failed long ago", () => {
    const thread = resetInAnHour();
    assert.isNull(
      limitRecoveryCommand(
        { ...thread, autoResumeAtLimitReset: false },
        true,
        nowMs,
        false,
        second,
      ),
    );
    const waiting = {
      ...thread,
      limitRecovery: {
        runId: thread.latestRunId!,
        resetAt: thread.usageLimitResetAt!,
        autoResume: true,
      },
    };
    assert.notEqual(
      limitRecoveryCommand(waiting, true, nowMs, false, second)?.type,
      "message.dispatch",
    );
    const stale = failedThread(60_001, -HOUR_MS);
    assert.notEqual(
      limitRecoveryCommand(stale, true, nowMs, false, second)?.type,
      "message.dispatch",
    );
  });
});
