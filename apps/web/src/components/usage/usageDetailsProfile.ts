import type { UsageDetails, UsageDetailsRow } from "@t3tools/contracts";
import {
  isThreadInActiveAccountProfile,
  type ProfileFilteringSettings,
} from "@t3tools/shared/accountProfiles";

const NO_TOTALS: UsageDetails["totals"] = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  records: 0,
  costUsd: 0,
  unpricedRecords: 0,
};

function addRow(totals: UsageDetails["totals"], row: UsageDetailsRow): UsageDetails["totals"] {
  return {
    uncachedInputTokens: totals.uncachedInputTokens + row.uncachedInputTokens,
    outputTokens: totals.outputTokens + row.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + row.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens + row.cacheCreationTokens,
    reasoningTokens: totals.reasoningTokens + row.reasoningTokens,
    records: totals.records + row.records,
    costUsd: totals.costUsd + row.costUsd,
    unpricedRecords: totals.unpricedRecords + row.unpricedRecords,
  };
}

/**
 * Drops rows whose thread the active account profile hides, and recomputes the page's totals from
 * the rows that stay. `totalRows` stays the server's count so paging keeps moving through them.
 */
export function usageDetailsInActiveProfile(
  data: UsageDetails,
  settings: ProfileFilteringSettings | null,
): UsageDetails {
  if (settings === null) return data;
  const rows = data.rows.filter((row) =>
    isThreadInActiveAccountProfile(settings, {
      id: row.threadId,
      projectId: row.projectId,
    }),
  );
  if (rows.length === data.rows.length) return data;
  return {
    rows,
    totalRows: data.totalRows,
    totals: rows.reduce(addRow, NO_TOTALS),
  };
}
