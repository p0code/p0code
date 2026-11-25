import type { SupervisorConnectionPhase } from "@t3tools/client-runtime/connection";
import type { DatabaseMigrationProgress, ServerStartupStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type StartupStage =
  | "starting-server"
  | "updating-database"
  | "connecting"
  | "loading-threads"
  | "ready";

export interface StartupProgressSnapshot {
  readonly stage: StartupStage;
  readonly percent: number;
  readonly migration: DatabaseMigrationProgress | null;
}

export interface ClientStartupReadinessInput {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly hydrated: boolean;
  readonly firstRunDecision: "pending" | "app" | "wizard";
  readonly catalogReady: boolean;
  readonly enabledEnvironmentCount: number;
  readonly primaryEnvironmentDiscovered: boolean;
  readonly primaryConnectionPhase: SupervisorConnectionPhase | null;
  readonly primaryServerConfigReady: boolean;
  readonly primaryShellHasSnapshot: boolean;
  readonly allShellsBootstrapped: boolean;
  readonly startupTimedOut: boolean;
}

const STAGE_ORDER: Record<StartupStage, number> = {
  "starting-server": 0,
  "updating-database": 1,
  connecting: 2,
  "loading-threads": 3,
  ready: 4,
};

const STARTING_SERVER_PERCENT = 15;
const UPDATING_DATABASE_BASE_PERCENT = 25;
const UPDATING_DATABASE_UNKNOWN_PERCENT = 35;
const UPDATING_DATABASE_SPAN_PERCENT = 30;
const CONNECTING_PERCENT = 70;
const LOADING_THREADS_PERCENT = 90;
const READY_PERCENT = 100;

export function normalizeDatabaseMigrationProgress(
  migration: DatabaseMigrationProgress | null | undefined,
): DatabaseMigrationProgress | null {
  if (!migration) return null;
  const { current, total } = migration;
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    current <= 0 ||
    total <= 0
  ) {
    return null;
  }
  return {
    current: Math.min(current, total),
    total,
  };
}

export function computeStartupStagePercent(
  stage: StartupStage,
  migration: DatabaseMigrationProgress | null = null,
): number {
  switch (stage) {
    case "starting-server":
      return STARTING_SERVER_PERCENT;
    case "updating-database": {
      const normalized = normalizeDatabaseMigrationProgress(migration);
      if (normalized === null) return UPDATING_DATABASE_UNKNOWN_PERCENT;
      return (
        UPDATING_DATABASE_BASE_PERCENT +
        Math.round((normalized.current / normalized.total) * UPDATING_DATABASE_SPAN_PERCENT)
      );
    }
    case "connecting":
      return CONNECTING_PERCENT;
    case "loading-threads":
      return LOADING_THREADS_PERCENT;
    case "ready":
      return READY_PERCENT;
  }
}

export function createStartupProgress(
  stage: StartupStage,
  migration: DatabaseMigrationProgress | null = null,
): StartupProgressSnapshot {
  const normalizedMigration =
    stage === "updating-database" ? normalizeDatabaseMigrationProgress(migration) : null;
  return {
    stage,
    percent: computeStartupStagePercent(stage, normalizedMigration),
    migration: normalizedMigration,
  };
}

function sameMigration(
  left: DatabaseMigrationProgress | null,
  right: DatabaseMigrationProgress | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.current === right.current && left.total === right.total;
}

/** Keeps startup progress moving monotonically forward within one launch. */
export function advanceStartupProgress(
  previous: StartupProgressSnapshot,
  next: StartupProgressSnapshot,
): StartupProgressSnapshot {
  const previousRank = STAGE_ORDER[previous.stage];
  const nextRank = STAGE_ORDER[next.stage];

  if (nextRank < previousRank) {
    return previous;
  }

  if (nextRank === previousRank) {
    if (
      previous.stage === "updating-database" &&
      next.stage === "updating-database" &&
      next.migration !== null
    ) {
      if (
        previous.migration !== null &&
        next.migration.total === previous.migration.total &&
        next.migration.current < previous.migration.current
      ) {
        return previous;
      }
      const percent = Math.max(previous.percent, next.percent);
      if (percent === previous.percent && sameMigration(previous.migration, next.migration)) {
        return previous;
      }
      return {
        stage: "updating-database",
        percent,
        migration: next.migration,
      };
    }

    const percent = Math.max(previous.percent, next.percent);
    if (percent === previous.percent) {
      return previous;
    }
    return {
      ...next,
      percent,
    };
  }

  return {
    ...next,
    percent: Math.max(previous.percent, next.percent),
  };
}

export function resolveServerStartupProgress(status: ServerStartupStatus): StartupProgressSnapshot {
  const migration = normalizeDatabaseMigrationProgress(status.migration);
  return migration !== null
    ? createStartupProgress("updating-database", migration)
    : createStartupProgress("starting-server");
}

export function resolveClientStartupStage(input: ClientStartupReadinessInput): StartupStage {
  if (!input.enabled && !input.hostedStatic) {
    return "ready";
  }

  if (input.hostedStatic) {
    if (!input.hydrated || !input.catalogReady) {
      return "connecting";
    }
    if (input.enabledEnvironmentCount === 0) {
      return "ready";
    }
    if (!input.allShellsBootstrapped && !input.startupTimedOut) {
      return "loading-threads";
    }
    return "ready";
  }

  if (input.startupTimedOut && input.firstRunDecision !== "pending") {
    return "ready";
  }

  const primaryConnected =
    input.primaryConnectionPhase === "connected" ||
    input.primaryServerConfigReady ||
    input.primaryShellHasSnapshot;
  const primarySettledDisconnected =
    input.primaryConnectionPhase === "offline" || input.primaryConnectionPhase === "blocked";

  if (!input.primaryEnvironmentDiscovered) {
    return "connecting";
  }

  if (!primaryConnected && !primarySettledDisconnected && !input.allShellsBootstrapped) {
    return "connecting";
  }

  if (!input.allShellsBootstrapped || !input.hydrated || input.firstRunDecision === "pending") {
    return "loading-threads";
  }

  return "ready";
}

export function formatStartupProgressLabel(
  progress: StartupProgressSnapshot,
  resolve: MessageResolver = m,
): string {
  switch (progress.stage) {
    case "starting-server":
      return resolve(msg("Starting server"));
    case "updating-database":
      return progress.migration !== null
        ? resolve(
            msg("Updating database ({current}/{total})", {
              current: String(progress.migration.current),
              total: String(progress.migration.total),
            }),
          )
        : resolve(msg("Updating database"));
    case "connecting":
      return resolve(msg("Connecting"));
    case "loading-threads":
      return resolve(msg("Loading threads"));
    case "ready":
      return resolve(msg("Ready", { $context: "startup loading progress complete" }));
  }
}

let bootStartupProgress: StartupProgressSnapshot = createStartupProgress("starting-server");

export function syncBootShellDom(
  progress: StartupProgressSnapshot,
  doc: Pick<Document, "getElementById"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): void {
  if (!doc || typeof doc.getElementById !== "function") return;
  const card = doc.getElementById("boot-shell-card");
  if (!card) return;
  const label = formatStartupProgressLabel(progress);
  const bar = doc.getElementById("boot-shell-bar");
  const fill = doc.getElementById("boot-shell-bar-fill");
  const status = doc.getElementById("boot-shell-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(progress.percent));
    bar.setAttribute("aria-valuetext", label);
  }
  if (fill) {
    fill.style.width = `${progress.percent}%`;
  }
  if (status) {
    status.textContent = label;
  }
}

export function getBootStartupProgress(): StartupProgressSnapshot {
  return bootStartupProgress;
}

function reportBootStartupProgress(next: StartupProgressSnapshot): StartupProgressSnapshot {
  const advanced = advanceStartupProgress(bootStartupProgress, next);
  if (advanced !== bootStartupProgress) {
    bootStartupProgress = advanced;
  }
  syncBootShellDom(bootStartupProgress);
  return bootStartupProgress;
}

export function reportBootStage(
  stage: StartupStage,
  migration: DatabaseMigrationProgress | null = null,
): StartupProgressSnapshot {
  return reportBootStartupProgress(createStartupProgress(stage, migration));
}

export function reportServerStartupStatus(status: ServerStartupStatus): StartupProgressSnapshot {
  return reportBootStartupProgress(resolveServerStartupProgress(status));
}

export function __resetBootStartupProgressForTests(): void {
  bootStartupProgress = createStartupProgress("starting-server");
}
