import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
  sortOlderSettledScopes,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettled,
  type OlderSettledScope,
} from "@t3tools/client-runtime/state/threads";
import {
  isOlderSettledThreadShell,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  activeProfileUnloadedScratchLimit,
  isProjectInActiveAccountProfile,
} from "@t3tools/shared/accountProfiles";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveEffectiveProfileSettings, type ActiveProfileThreadVisibility } from "./projects";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

/**
 * The Settled shelf for one scope when shells leave older settled threads out: which rows it may
 * list, how many threads it holds in all, and the pages read below each environment's cut, whose
 * rows merge into the thread list. `useOlderSettledShelfGrowth` reads the next pages.
 */
export function useOlderSettledShelf(input: {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
}) {
  const scopes = sortOlderSettledScopes(input.scopes);
  const scopeKey = JSON.stringify(scopes);
  const [requested, setRequested] = useState({ scopeKey, pages: NO_PAGES });
  const pages = requested.scopeKey === scopeKey && input.expanded ? requested.pages : NO_PAGES;
  const shelfScopes = scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
  const shelfKey = JSON.stringify(shelfScopes);
  const shelf = useAtomValue(olderSettledThreads.shelfAtom(shelfScopes));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the requested older settled pages into the thread family registry while shown
  useEffect(() => {
    const releases = (JSON.parse(shelfKey) as typeof shelfScopes).flatMap(({ scope, pages }) =>
      pages === 0
        ? []
        : [
            threadFamilies.mountRows(
              appAtomRegistry,
              scope.environmentId,
              olderSettledThreads.rowsKey(scope, pages),
              olderSettledThreads.pageRowsAtom(scope, pages),
            ),
          ],
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shelfKey]);

  const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
  const pagesOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.pages;
  const frontier = settledShelfFrontier([...shelf.values()]);
  const loaded = shelfScopes.filter(({ pages }) => pages > 0);
  return {
    environments: shelf,
    visibleCount: input.expanded ? input.visibleCount : 0,
    pages,
    grow: (next: ReadonlyMap<EnvironmentId, number>) => setRequested({ scopeKey, pages: next }),
    isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
    /** Older settled threads in scope that are not local; add it to the local Settled rows. */
    unloadedCount: (threads: ReadonlyArray<EnvironmentThreadShell>) =>
      unloadedOlderSettledCount({ olderSettled: olderOf, scopes, threads }),
    loading: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "pending"),
    failed: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "failed"),
    retry: () => {
      for (const { scope, pages } of loaded) {
        olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
      }
    },
  };
}

/** Reads the next pages while the shelf lists fewer rows than it shows. */
export function useOlderSettledShelfGrowth(
  shelf: ReturnType<typeof useOlderSettledShelf>,
  listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const wanted = wantedOlderSettledPages({
    requested: shelf.pages,
    environments: shelf.environments,
    listedCount: listedSettledThreads.length,
    visibleCount: shelf.visibleCount,
  });
  const { grow, pages } = shelf;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more older settled pages when the listed threads cannot fill the visible count
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return unloadedOlderSettledCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(members.map((member) => member.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: members.flatMap((member) =>
        member.environmentId === environmentId ? [member.id] : [],
      ),
    })),
    threads: threads.filter((thread) =>
      members.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
    ),
  });
}

function loadedThreadIdsByEnvironment(
  loadedThreads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }>,
): ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>> {
  const byEnv = new Map<EnvironmentId, Set<ThreadId>>();
  for (const thread of loadedThreads) {
    let set = byEnv.get(thread.environmentId);
    if (set === undefined) {
      set = new Set();
      byEnv.set(thread.environmentId, set);
    }
    set.add(thread.id);
  }
  return byEnv;
}

const EMPTY_THREAD_IDS: ReadonlySet<ThreadId> = new Set();

/**
 * Builds older-settled scopes for the sidebar while honoring the active account profile.
 * Hidden environments and hidden projects are omitted; under a non-home profile with zero
 * unloaded explicit scratch threads, scratch ("No project") projects are also omitted so legacy
 * scratch threads are neither counted nor paged in.
 */
export function olderSettledScopesForProfile(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly isScratch?: boolean | undefined;
  }>;
  readonly loadedThreads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }>;
  readonly visibility: ActiveProfileThreadVisibility;
}): ReadonlyArray<OlderSettledScope> {
  const loadedByEnv = loadedThreadIdsByEnvironment(input.loadedThreads);
  const scratchKeys = new Set<string>();
  const projectsByEnv = new Map<
    EnvironmentId,
    Array<{ readonly id: ProjectId; readonly isScratch?: boolean | undefined }>
  >();
  for (const project of input.projects) {
    if (project.isScratch) scratchKeys.add(`${project.environmentId}:${project.id}`);
    let list = projectsByEnv.get(project.environmentId);
    if (list === undefined) {
      list = [];
      projectsByEnv.set(project.environmentId, list);
    }
    list.push(project);
  }
  const isScratchKey = (key: string) =>
    scratchKeys.has(key) || input.visibility.projectScratchByKey.get(key) === true;

  const scopes: OlderSettledScope[] = [];
  for (const environmentId of input.environmentIds) {
    if (input.visibility.hiddenEnvironments.has(environmentId)) continue;
    const settings = resolveEffectiveProfileSettings(
      environmentId,
      input.visibility.separatingByEnvironment,
      input.visibility.primarySeparating,
    );
    const scratchLimit = activeProfileUnloadedScratchLimit(
      settings,
      loadedByEnv.get(environmentId) ?? EMPTY_THREAD_IDS,
    );
    const dropScratch = scratchLimit === 0;
    const prefix = `${environmentId}:`;

    if (input.scopedProjectKeys !== null) {
      const projectIds: ProjectId[] = [];
      for (const key of input.scopedProjectKeys) {
        if (!key.startsWith(prefix)) continue;
        const projectId = ProjectId.make(key.slice(prefix.length));
        if (input.visibility.hiddenProjectKeys.has(key)) continue;
        if (dropScratch && isScratchKey(key)) continue;
        if (!isProjectInActiveAccountProfile(settings, projectId, { isScratch: isScratchKey(key) }))
          continue;
        projectIds.push(projectId);
      }
      if (projectIds.length > 0) scopes.push({ environmentId, projectIds });
      continue;
    }

    if (dropScratch) {
      const envProjects = projectsByEnv.get(environmentId) ?? [];
      const projectIds = envProjects
        .filter((project) => {
          const key = `${environmentId}:${project.id}`;
          return (
            !isScratchKey(key) &&
            !input.visibility.hiddenProjectKeys.has(key) &&
            isProjectInActiveAccountProfile(settings, project.id, { isScratch: false })
          );
        })
        .map((project) => project.id);
      if (projectIds.length > 0) scopes.push({ environmentId, projectIds });
      continue;
    }

    scopes.push({ environmentId, projectIds: null });
  }
  return scopes;
}

/**
 * Unloaded older settled thread count honoring the active account profile.
 * Subtracts every loaded older settled thread (across all profiles so loaded threads from other
 * profiles are not counted as unloaded) and caps scratch ("No project") unloaded counts by the
 * number of unloaded threads explicitly assigned to the active non-home profile.
 */
export function unloadedOlderSettledCountForProfile(input: {
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly allLoadedThreads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly source: Pick<
      OrchestrationV2ThreadShell,
      "id" | "projectId" | "lineage" | "settledOverride" | "settledAt"
    >;
  }>;
  readonly visibility: ActiveProfileThreadVisibility;
}): number {
  let unloaded = 0;
  for (const scope of input.scopes) {
    if (input.visibility.hiddenEnvironments.has(scope.environmentId)) continue;
    const older = input.olderSettled(scope.environmentId);
    if (older === null) continue;
    const settings = resolveEffectiveProfileSettings(
      scope.environmentId,
      input.visibility.separatingByEnvironment,
      input.visibility.primarySeparating,
    );
    const loadedIds = new Set<ThreadId>();
    const loadedOlderByProject = new Map<ProjectId, number>();
    for (const thread of input.allLoadedThreads) {
      if (thread.environmentId !== scope.environmentId) continue;
      loadedIds.add(thread.id);
      if (isOlderSettledThreadShell(thread.source, older.beforeMs)) {
        loadedOlderByProject.set(
          thread.source.projectId,
          (loadedOlderByProject.get(thread.source.projectId) ?? 0) + 1,
        );
      }
    }
    let remainingScratchLimit = activeProfileUnloadedScratchLimit(settings, loadedIds);
    const projectIds = scope.projectIds === null ? [...older.counts.keys()] : scope.projectIds;
    for (const projectId of projectIds) {
      const key = `${scope.environmentId}:${projectId}`;
      const isScratch = input.visibility.projectScratchByKey.get(key) === true;
      if (input.visibility.hiddenProjectKeys.has(key)) continue;
      if (!isProjectInActiveAccountProfile(settings, projectId, { isScratch })) continue;
      const rawCount = older.counts.get(projectId) ?? 0;
      let projectUnloaded = Math.max(0, rawCount - (loadedOlderByProject.get(projectId) ?? 0));
      if (isScratch && remainingScratchLimit !== null) {
        projectUnloaded = Math.min(projectUnloaded, remainingScratchLimit);
        remainingScratchLimit -= projectUnloaded;
      }
      unloaded += projectUnloaded;
    }
  }
  return unloaded;
}
