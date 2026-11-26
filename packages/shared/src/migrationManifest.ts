/**
 * The single source of truth for the server's migration id/name pairs. The migrator
 * (`apps/server/src/persistence/Migrations.ts`) builds its migration list from this manifest, and
 * the T3 Code import guard reads a source database's migration history against it, so the two can
 * never disagree about which migrations this build understands.
 */

export const migrationManifest: Array<readonly [number, string]> = [
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
  [34, "ProjectionThreadsSnoozed"],
  [35, "ProjectionThreadTitleRegeneration"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"],
  [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"],
  [62, "ThreadFailureLookupIndex"],
  [63, "DropUnusedV1Projections"],
  [64, "CanonicalizeThreadPullRequestLinks"],
  [65, "CodexUsageNativeTurnIndex"],
  [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"],
  [68, "ShellStopRequestIndex"],
  [69, "ThreadMessageSearch"],
  [70, "PeerLinks"],
  [71, "PeerLinkFence"],
  [72, "WaitingLinkRequestIndex"],
  [73, "ActiveTurnItemIndexes"],
  [74, "ExcludeAttachmentPlaceholdersFromSearch"],
  [75, "SubagentDeliveryState"],
  [76, "ProjectionProjectsPinArchive"],
  [77, "RepairBooleanSettledOverride"],
  [78, "DropOrchestrationEventCorrelationIndex"],
  [79, "DelegatedRecoveryIndexes"],
  [80, "ScheduledTaskThreadMode"],
  [81, "ProjectionMessageSearchText"],
  [82, "TurnItemConversationIndex"],
  [83, "CommandReadIndexes"],
  [84, "LastExecutedRunIndex"],
  [85, "TurnItemCounts"],
  [86, "QueuedTurnInputIndex"],
  [87, "ProjectionProjectsCustomTitle"],
  [88, "TurnItemTypeStatusIndex"],
  [89, "ShellThreadReadIndexes"],
  [90, "AuthConnectDevices"],
  [91, "AuthConnectDeniedRequests"],
  [92, "QueuedTurnInputIndexJsonValid"],
  [93, "ProviderTurnAttemptIndex"],
  [94, "TurnItemMessageOrdinalIndex"],
  [95, "TurnItemInlineWorkOutput"],
  [96, "RepairStaleTitleRegeneration"],
  [97, "IssueTrackerBindings"],
  [98, "ActiveShellIndexIndexes"],
  [99, "BackgroundRecoveryIndexes"],
  [100, "TurnStartReadIndexes"],
  [101, "DelegatedTaskReadIndexes"],
  [102, "ThreadItemCounts"],
  [103, "IssueTrackerAdditionalScopes"],
  [104, "ProjectionProjectsTrackedFolders"],
  [105, "TaskFolders"],
  [106, "WorktreePathKeyIndex"],
  [107, "DeferredSlashCommandIndex"],
  [108, "AgentFeedback"],
  [109, "IssueTrackerAccounts"],
  [110, "Workflows"],
  [111, "SupersededRunAttemptIndex"],
  [112, "LayoutCommandApprovals"],
  [113, "WorkflowSkippedRuns"],
  [114, "WorkflowRunIndexes"],
  [115, "WorkflowRunTags"],
  [116, "ForkHistoryMembership"],
  [117, "WorkflowMailSender"],
  [118, "WorkflowPools"],
  // p0code shipped this one as 112 before syncing upstream's 112-118; see moveForkMigration112.
  [119, "DropUnusedProviderTurnIndexes"],
  [120, "PublicTunnels"],
  [121, "WorkflowRunSubject"],
  [122, "DeployHost"],
];

export const FIRST_V2_MIGRATION_ID = 55;

/** The highest migration id this build knows, so callers can spot a newer build's records. */
export const BUILD_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));

export interface RecordedMigration {
  readonly id: number;
  readonly name: string;
}

/**
 * Drops p0code's legacy `112_DropUnusedProviderTurnIndexes` row when no later migration exists,
 * matching `moveForkMigration112` in `apps/server/src/persistence/Migrations.ts`.
 */
function normalizeForkMigration112(
  recorded: ReadonlyArray<RecordedMigration>,
): ReadonlyArray<RecordedMigration> {
  if (recorded.some((row) => row.id > 112)) return recorded;
  return recorded.filter(
    (row) => !(row.id === 112 && row.name === "DropUnusedProviderTurnIndexes"),
  );
}

/** Previews used V2 ids 53/54; preserve their schema and import progress while reserving main's ids. */
export function v2PreviewId(
  history: ReadonlyArray<RecordedMigration>,
): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 53);
  const legacy = later.find(
    (row) => row.name === "OrchestrationV2" && (row.id === 53 || row.id === 54),
  );
  if (!legacy) return undefined;
  const valid = later.every(
    (row) =>
      row === legacy ||
      (legacy.id === 54 &&
        ((row.id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
  );
  return valid ? legacy.id : "invalid";
}

/** The history as startup's preview reconciliation leaves it, or null when startup rejects it. */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<RecordedMigration>,
): ReadonlyArray<RecordedMigration> | null {
  const previewId = v2PreviewId(history);
  if (previewId === undefined) return history;
  if (previewId === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 53),
    { id: 53, name: "PullRequestFilesViewed" },
    { id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    { id: 55, name: "OrchestrationV2" },
    ...(history.some((row) => row.id === 55)
      ? [{ id: 56, name: "RemoveRedundantProjectionIndexes" }]
      : []),
  ];
}

/**
 * Migration entries the migrator would skip as "required but not run" — the ids this build's
 * manifest assigns below the source's highest recorded id whose recorded name differs. Mirrors
 * `assertV2MigrationsCanRun` so the import guard and the migrator share one rule.
 */
export function skippedV2Migrations(
  recorded: ReadonlyArray<RecordedMigration>,
  throughId?: number,
): string[] {
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.id));
  const recordedNames = new Map(recorded.map((row) => [row.id, row.name]));
  return migrationManifest.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
}

/**
 * Migration incompatibilities that prevent this build from safely importing a source database:
 * an invalid V2 preview history, any migration above `BUILD_MIGRATION_HEAD`, or any V2 migration
 * the migrator would refuse after accounting for `moveForkMigration112` and V2 preview upgrades.
 */
export function incompatibleSourceMigrations(
  recorded: ReadonlyArray<RecordedMigration>,
): ReadonlyArray<string> {
  const afterFork = normalizeForkMigration112(recorded);
  const reconciled = reconciledV2PreviewHistory(afterFork);
  if (reconciled === null) {
    return ["an unexpected V2 preview history"];
  }
  const newer = reconciled
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
  return [...newer, ...skippedV2Migrations(reconciled)];
}
