import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as DatabaseMigrationProgress from "./DatabaseMigrationProgress.ts";
import {
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";
import {
  FIRST_V2_MIGRATION_ID,
  migrationManifest,
  skippedV2Migrations,
} from "@t3tools/shared/migrationManifest";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import Migration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0067 from "./Migrations/067_WebhookDedupe.ts";
import Migration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration0070 from "./Migrations/070_PeerLinks.ts";
import Migration0071 from "./Migrations/071_PeerLinkFence.ts";
import Migration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration0075 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import Migration0077 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import Migration0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import Migration0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Migration0080 from "./Migrations/080_ScheduledTaskThreadMode.ts";
import Migration0081 from "./Migrations/081_ProjectionMessageSearchText.ts";
import Migration0082 from "./Migrations/082_TurnItemConversationIndex.ts";
import Migration0083 from "./Migrations/083_CommandReadIndexes.ts";
import Migration0084 from "./Migrations/084_LastExecutedRunIndex.ts";
import Migration0085 from "./Migrations/085_TurnItemCounts.ts";
import Migration0086 from "./Migrations/086_QueuedTurnInputIndex.ts";
import Migration0087 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import Migration0088 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import Migration0089 from "./Migrations/089_ShellThreadReadIndexes.ts";
import Migration0090 from "./Migrations/090_AuthConnectDevices.ts";
import Migration0091 from "./Migrations/091_AuthConnectDeniedRequests.ts";
import Migration0092 from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import Migration0093 from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import Migration0094 from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import Migration0095 from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import Migration0096 from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import Migration0097 from "./Migrations/097_IssueTrackerBindings.ts";
import Migration0098 from "./Migrations/098_ActiveShellIndexIndexes.ts";
import Migration0099 from "./Migrations/099_BackgroundRecoveryIndexes.ts";
import Migration0100 from "./Migrations/100_TurnStartReadIndexes.ts";
import Migration0101 from "./Migrations/101_DelegatedTaskReadIndexes.ts";
import Migration0102 from "./Migrations/102_ThreadItemCounts.ts";
import Migration0103 from "./Migrations/103_IssueTrackerAdditionalScopes.ts";
import Migration0104 from "./Migrations/104_ProjectionProjectsTrackedFolders.ts";
import Migration0105 from "./Migrations/105_TaskFolders.ts";
import Migration0106 from "./Migrations/106_WorktreePathKeyIndex.ts";
import Migration0107 from "./Migrations/107_DeferredSlashCommandIndex.ts";
import Migration0108 from "./Migrations/108_AgentFeedback.ts";
import Migration0109 from "./Migrations/109_IssueTrackerAccounts.ts";
import Migration0110 from "./Migrations/110_Workflows.ts";
import Migration0111 from "./Migrations/111_SupersededRunAttemptIndex.ts";
import Migration0112 from "./Migrations/112_LayoutCommandApprovals.ts";
import Migration0113 from "./Migrations/113_WorkflowSkippedRuns.ts";
import Migration0114 from "./Migrations/114_WorkflowRunIndexes.ts";
import Migration0115 from "./Migrations/115_WorkflowRunTags.ts";
import Migration0116 from "./Migrations/116_ForkHistoryMembership.ts";
import Migration0117 from "./Migrations/117_WorkflowMailSender.ts";
import Migration0118 from "./Migrations/118_WorkflowPools.ts";
import Migration0119 from "./Migrations/119_DropUnusedProviderTurnIndexes.ts";
import Migration0120 from "./Migrations/120_PublicTunnels.ts";
import Migration0121 from "./Migrations/121_WorkflowRunSubject.ts";
import Migration0122 from "./Migrations/122_DeployHost.ts";
import Migration0123 from "./Migrations/123_AuthPluginsManageScope.ts";
import Migration0124 from "./Migrations/124_DeployCliSubject.ts";

export { migrationManifest, skippedV2Migrations };

const migrationsById = {
  1: Migration0001,
  2: Migration0002,
  3: Migration0003,
  4: Migration0004,
  5: Migration0005,
  6: Migration0006,
  7: Migration0007,
  8: Migration0008,
  9: Migration0009,
  10: Migration0010,
  11: Migration0011,
  12: Migration0012,
  13: Migration0013,
  14: Migration0014,
  15: Migration0015,
  16: Migration0016,
  17: Migration0017,
  18: Migration0018,
  19: Migration0019,
  20: Migration0020,
  21: Migration0021,
  22: Migration0022,
  23: Migration0023,
  24: Migration0024,
  25: Migration0025,
  26: Migration0026,
  27: Migration0027,
  28: Migration0028,
  29: Migration0029,
  30: Migration0030,
  31: Migration0031,
  32: Migration0032,
  33: Migration0033,
  34: Migration0034,
  35: Migration0035,
  36: Migration0036,
  37: Migration0037,
  38: Migration0038,
  39: Migration0039,
  40: Migration0040,
  41: Migration0041,
  42: Migration0042,
  43: Migration0043,
  44: Migration0044,
  45: Migration0045,
  46: Migration0046,
  47: Migration0047,
  48: Migration0048,
  49: Migration0049,
  50: Migration0050,
  51: Migration0051,
  52: Migration0052,
  53: Migration0053,
  54: Migration0054,
  55: Migration0055,
  56: Migration0056,
  57: Migration0057,
  58: Migration0058,
  59: Migration0059,
  60: Migration0060,
  61: Migration0061,
  62: Migration0062,
  63: Migration0063,
  64: Migration0064,
  65: Migration0065,
  66: Migration0066,
  67: Migration0067,
  68: Migration0068,
  69: Migration0069,
  70: Migration0070,
  71: Migration0071,
  72: Migration0072,
  73: Migration0073,
  74: Migration0074,
  75: Migration0075,
  76: Migration0076,
  77: Migration0077,
  78: Migration0078,
  79: Migration0079,
  80: Migration0080,
  81: Migration0081,
  82: Migration0082,
  83: Migration0083,
  84: Migration0084,
  85: Migration0085,
  86: Migration0086,
  87: Migration0087,
  88: Migration0088,
  89: Migration0089,
  90: Migration0090,
  91: Migration0091,
  92: Migration0092,
  93: Migration0093,
  94: Migration0094,
  95: Migration0095,
  96: Migration0096,
  97: Migration0097,
  98: Migration0098,
  99: Migration0099,
  100: Migration0100,
  101: Migration0101,
  102: Migration0102,
  103: Migration0103,
  104: Migration0104,
  105: Migration0105,
  106: Migration0106,
  107: Migration0107,
  108: Migration0108,
  109: Migration0109,
  110: Migration0110,
  111: Migration0111,
  112: Migration0112,
  113: Migration0113,
  114: Migration0114,
  115: Migration0115,
  116: Migration0116,
  117: Migration0117,
  118: Migration0118,
  119: Migration0119,
  120: Migration0120,
  121: Migration0121,
  122: Migration0122,
  123: Migration0123,
  124: Migration0124,
} as const;

type KnownMigration = (typeof migrationsById)[keyof typeof migrationsById];
const migrationLookup: ReadonlyMap<number, KnownMigration> = new Map(
  Object.entries(migrationsById).map(([id, migration]) => [Number(id), migration] as const),
);

const migrationEntries = migrationManifest.map(([id, name]) => {
  const migration = migrationLookup.get(id);
  if (migration === undefined) throw new Error(`No migration module for ${id}_${name}`);
  return [id, name, migration] as const;
});

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const skipped = skippedV2Migrations(
    recorded.map((row) => ({ id: row.migration_id, name: row.name })),
    throughId,
  );
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

// Mirrors the Migrator, which runs only ids above the highest recorded, plus the V2-preview reconciliation.
export const hasPendingMigrations = Effect.fn("hasPendingMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null; readonly previewRows: number }>`
    SELECT
      MAX(migration_id) AS latestId,
      SUM(name = 'OrchestrationV2' AND migration_id IN (53, 54)) AS previewRows
    FROM effect_sql_migrations
  `;
  const row = rows[0];
  return (row?.latestId ?? 0) < latestMigrationId || (row?.previewRows ?? 0) > 0;
});

// p0code briefly recorded DropUnusedProviderTurnIndexes as 112, the id upstream gave
// LayoutCommandApprovals. That migration only drops indexes if they exist, so forgetting the row
// lets upstream's 112-118 run and the index drop rerun as 119.
const moveForkMigration112 = Effect.fn("moveForkMigration112")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = 112 AND name = 'DropUnusedProviderTurnIndexes'
      AND NOT EXISTS (SELECT 1 FROM effect_sql_migrations WHERE migration_id > 112)
  `;
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const progress = yield* Effect.serviceOption(DatabaseMigrationProgress.DatabaseMigrationProgress);
  // The desktop waits past its readiness budget until the finished line follows this one.
  const hasPending = yield* hasPendingMigrations();
  if (hasPending) yield* Effect.log(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  if (hasPending) yield* moveForkMigration112();
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  // The reconcile takes the write lock; CLI startup must not contend with the server for a no-op.
  const previewMigrations = includesV2 && hasPending ? yield* reconcileV2PreviewMigration() : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  const [latest] =
    ledger.length === 0
      ? []
      : yield* sql<{
          readonly id: number | null;
        }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
  const latestRecordedId = latest?.id ?? 0;
  const pending = migrationEntries.filter(
    ([id]) =>
      id > latestRecordedId && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
  );
  // One transaction per migration: an index build on a large database can take minutes, and a
  // restart then resumes after the last finished migration instead of rolling all of them back.
  const executedMigrations: Array<readonly [id: number, name: string]> = [...previewMigrations];
  yield* Effect.gen(function* () {
    for (const [index, [id, name]] of pending.entries()) {
      if (Option.isSome(progress)) {
        yield* Ref.set(progress.value.current, { current: index + 1, total: pending.length });
      }
      if (latestRecordedId > 0) {
        yield* Effect.log(
          `${DATABASE_MIGRATION_PROGRESS_MESSAGE} (${index + 1} of ${pending.length})`,
        ).pipe(
          Effect.annotateLogs({
            migration: `${id}_${name}`,
            progress: `${index + 1} of ${pending.length}`,
          }),
        );
      }
      executedMigrations.push(...(yield* run({ loader: makeMigrationLoader(id) })));
    }
  }).pipe(
    Effect.ensuring(Option.isSome(progress) ? Ref.set(progress.value.current, null) : Effect.void),
  );
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log(DATABASE_MIGRATIONS_FINISHED_MESSAGE).pipe(Effect.annotateLogs({ migrations }));

  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
