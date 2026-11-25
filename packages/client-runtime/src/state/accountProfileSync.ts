// @effect-diagnostics globalTimers:off - The debounce runs in web and native clients, outside an Effect runtime.
import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { syncedAccountProfilesPatch } from "@t3tools/shared/accountProfiles";

export interface AccountProfileSyncState {
  /** The primary environment's live settings; null while it is not connected. */
  readonly source: ServerSettings | null;
  /** Other connected environments this client may write settings on. */
  readonly targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly settings: ServerSettings;
  }>;
}

/**
 * Spreads the primary environment's account profiles to the other connected environments. A
 * target is written once per source change and again after it reconnects; edits made on a target
 * alone wait for the next of those, so two clients never bounce writes off each other.
 */
export function createAccountProfileSync(options: {
  /** Resolves false when the write failed (not when it was interrupted). */
  readonly write: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => Promise<boolean>;
  /** Called at most once per environment for the life of the sync. */
  readonly onFailed: (environmentId: EnvironmentId) => void;
  readonly delayMs?: number;
}) {
  let state: AccountProfileSyncState = { source: null, targets: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const syncedSourceByTarget = new Map<EnvironmentId, string>();
  const reportedFailures = new Set<EnvironmentId>();

  const flush = () => {
    timer = undefined;
    const { source, targets } = state;
    const present = new Set(targets.map((target) => target.environmentId));
    for (const environmentId of syncedSourceByTarget.keys()) {
      if (!present.has(environmentId)) syncedSourceByTarget.delete(environmentId);
    }
    if (source === null) return;
    const sourceKey = JSON.stringify([source.accountProfiles, source.activeAccountProfileId]);
    for (const { environmentId, settings } of targets) {
      if (syncedSourceByTarget.get(environmentId) === sourceKey) continue;
      syncedSourceByTarget.set(environmentId, sourceKey);
      const patch = syncedAccountProfilesPatch(source, settings);
      if (patch === undefined) continue;
      void options.write(environmentId, patch).then((saved) => {
        if (saved || reportedFailures.has(environmentId)) return;
        reportedFailures.add(environmentId);
        options.onFailed(environmentId);
      });
    }
  };

  return {
    update(next: AccountProfileSyncState) {
      state = next;
      timer ??= setTimeout(flush, options.delayMs ?? 500);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
