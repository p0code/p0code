import { CommandId, isOpenEndedSnooze } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isSnoozed } from "./ThreadSettlementService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Hiding is measured in days, so a sweep every few minutes is plenty and keeps the scan off every tick.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** A pull request without a snapshot yet might be open, so it holds the thread too. */
function hasActivePullRequest(thread: ProjectionStore.ProjectionSettlementCandidate): boolean {
  return visibleThreadPullRequests(thread.pullRequests ?? []).some(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  );
}

export function isHiddenAutoArchiveDue(
  thread: ProjectionStore.ProjectionSettlementCandidate,
  nowMs: number,
  afterDays: number | null,
): boolean {
  if (afterDays === null || thread.archivedAt !== null || thread.snoozedAt == null) return false;
  if (!isOpenEndedSnooze(thread.snoozedUntil)) return false;
  // A thread that raised its hand is back in the inbox even though the hide is still stored.
  if (!isSnoozed(thread, nowMs)) return false;
  if (DateTime.toEpochMillis(thread.snoozedAt) > nowMs - afterDays * DAY_MS) return false;
  if (thread.activityRunStatus != null || thread.pendingRuntimeRequest !== null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  return !hasActivePullRequest(thread);
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  let nextSweepAtMs = 0;
  yield* forkParked(
    Stream.runForEach(settings.streamChanges, () =>
      Effect.sync(() => {
        nextSweepAtMs = 0;
      }),
    ),
  );
  return Effect.fn("HiddenAutoArchiveWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs < nextSweepAtMs) return;
    nextSweepAtMs = nowMs + SWEEP_INTERVAL_MS;
    const { hiddenAutoArchiveAfterDays } = yield* settings.getSettings;
    if (hiddenAutoArchiveAfterDays === null) return;
    const candidates = yield* projections.getSettlementCandidates();
    for (const thread of candidates) {
      if (!isHiddenAutoArchiveDue(thread, nowMs, hiddenAutoArchiveAfterDays)) continue;
      yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(
            `server:hidden-auto-archive:${thread.id}:${DateTime.formatIso(thread.snoozedAt!)}`,
          ),
          threadId: thread.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.hidden-auto-archive.failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("hidden-auto-archive", sweep());
  }),
);
