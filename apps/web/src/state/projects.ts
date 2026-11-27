import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell, environmentSnapshotAtom, expectsPrimaryEnvironment } from "./shell";
import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import {
  effectiveAccountProfileSettings,
  isProjectInActiveAccountProfile,
  isThreadInActiveAccountProfile,
  type ProfileFilteringSettings,
  profileHiddenEnvironmentIds,
} from "@t3tools/shared/accountProfiles";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));

const primaryAccountProfileSettingsAtom = Atom.make((get) => {
  const primaryId = get(primaryEnvironmentIdAtom);
  if (primaryId === null) return null;
  const settings = get(environmentServerConfigsAtom).get(primaryId)?.settings;
  return settings != null && settings.accountProfiles.length > 0 ? settings : null;
}).pipe(Atom.withLabel("web-primary-account-profile-settings"));

/** Primary environment's profile settings when it has at least two profiles to separate. */
export const primarySeparatingAccountProfileSettingsAtom = Atom.make((get) => {
  const primary = get(primaryAccountProfileSettingsAtom);
  return primary !== null && primary.accountProfiles.length >= 2 ? primary : null;
}).pipe(Atom.withLabel("web-primary-separating-account-profile-settings"));

/** Machines the active account profile leaves out of lists and pickers. */
export const profileHiddenEnvironmentIdsAtom = Atom.make((get) =>
  profileHiddenEnvironmentIds(
    new Map(
      [...get(environmentServerConfigsAtom)].map(([id, config]) => [id, config.settings] as const),
    ),
    get(primaryEnvironmentIdAtom),
  ),
).pipe(Atom.withEquality(sameKeys), Atom.withLabel("web-profile-hidden-environment-ids"));

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

/** `environmentId:projectId` keys of projects the active account profile hides. */
export const profileHiddenProjectKeysAtom = Atom.make((get) => {
  const hidden = new Set<string>();
  const hiddenEnvironments = get(profileHiddenEnvironmentIdsAtom);
  const primary = get(primaryAccountProfileSettingsAtom);
  for (const project of get(environmentProjects.projectsAtom)) {
    if (hiddenEnvironments.has(project.environmentId)) {
      hidden.add(`${project.environmentId}:${project.id}`);
      continue;
    }
    const settings = effectiveAccountProfileSettings(
      get(serverEnvironment.settingsValueAtom(project.environmentId)),
      primary,
    );
    if (!isProjectInActiveAccountProfile(settings, project.id, { isScratch: project.isScratch })) {
      hidden.add(`${project.environmentId}:${project.id}`);
    }
  }
  return hidden;
}).pipe(
  // Settings pushes rebuild the set; keep it stable while the hidden projects stay the same.
  Atom.withEquality(sameKeys),
  Atom.withLabel("web-profile-hidden-project-keys"),
);

const profileProjectScratchByKeyAtom = Atom.make((get) => {
  const map = new Map<string, boolean>();
  for (const project of get(environmentProjects.projectsAtom)) {
    map.set(`${project.environmentId}:${project.id}`, project.isScratch === true);
  }
  return map;
}).pipe(Atom.withLabel("web-profile-project-scratch-by-key"));

/** Effective profile settings of each environment whose account profiles separate work. */
export const profileSeparatingSettingsAtom = Atom.make((get) => {
  const primary = get(primaryAccountProfileSettingsAtom);
  const separating = new Map<EnvironmentId, ProfileFilteringSettings>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    const effective = effectiveAccountProfileSettings(config.settings, primary);
    if (effective !== undefined && effective.accountProfiles.length >= 2) {
      separating.set(environmentId, effective);
    }
  }
  return separating;
}).pipe(Atom.withLabel("web-profile-separating-settings"));

export function resolveEffectiveProfileSettings(
  environmentId: EnvironmentId,
  separatingByEnvironment: ReadonlyMap<EnvironmentId, ProfileFilteringSettings>,
  primarySeparating: Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId"> | null,
): ProfileFilteringSettings | undefined {
  return (
    separatingByEnvironment.get(environmentId) ??
    effectiveAccountProfileSettings(undefined, primarySeparating)
  );
}

/** Reads an environment's effective profile settings (primary's profiles + environment's filing). */
export function readEffectiveAccountProfileSettings(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): ProfileFilteringSettings | undefined {
  return effectiveAccountProfileSettings(
    registry.get(serverEnvironment.settingsValueAtom(environmentId)),
    registry.get(primaryAccountProfileSettingsAtom),
  );
}

export interface ActiveProfileThreadVisibility {
  readonly hiddenEnvironments: ReadonlySet<EnvironmentId>;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly projectScratchByKey: ReadonlyMap<string, boolean>;
  readonly separatingByEnvironment: ReadonlyMap<EnvironmentId, ProfileFilteringSettings>;
  readonly primarySeparating: Pick<
    ServerSettings,
    "accountProfiles" | "activeAccountProfileId"
  > | null;
}

/** Combined active-profile visibility state for thread filtering, counts, and notifications. */
export const activeProfileThreadVisibilityAtom = Atom.make(
  (get): ActiveProfileThreadVisibility => ({
    hiddenEnvironments: get(profileHiddenEnvironmentIdsAtom),
    hiddenProjectKeys: get(profileHiddenProjectKeysAtom),
    projectScratchByKey: get(profileProjectScratchByKeyAtom),
    separatingByEnvironment: get(profileSeparatingSettingsAtom),
    primarySeparating: get(primarySeparatingAccountProfileSettingsAtom),
  }),
).pipe(Atom.withLabel("web-active-profile-thread-visibility"));

/** Whether a thread is visible under the active account profile. */
export function isThreadVisibleInActiveProfile(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId | null;
  },
  visibility: ActiveProfileThreadVisibility,
): boolean {
  if (visibility.hiddenEnvironments.has(thread.environmentId)) return false;
  const projectKey =
    thread.projectId === null ? null : `${thread.environmentId}:${thread.projectId}`;
  if (projectKey !== null && visibility.hiddenProjectKeys.has(projectKey)) return false;
  const settings = resolveEffectiveProfileSettings(
    thread.environmentId,
    visibility.separatingByEnvironment,
    visibility.primarySeparating,
  );
  if (settings === undefined) return true;
  const isScratchProject =
    projectKey === null ? true : visibility.projectScratchByKey.get(projectKey);
  return isThreadInActiveAccountProfile(settings, {
    id: thread.id,
    projectId: thread.projectId,
    ...(isScratchProject !== undefined ? { isScratchProject } : {}),
  });
}

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const defaultProjectFallbackReadyAtom = Atom.family((projectKey: string | null) =>
  Atom.make((get) => {
    const remembered = projectKey === null ? null : parseScopedProjectKey(projectKey);
    if (!remembered) return true;
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return false;
    if (
      expectsPrimaryEnvironment() &&
      !Array.from(catalog.entries.values()).some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      )
    )
      return false;
    const entry = catalog.entries.get(remembered.environmentId);
    if (!entry?.enabled || entry.unsupportedReason !== undefined) return true;
    if (get(environmentShell.statusAtom(remembered.environmentId)) === "live") return true;
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(remembered.environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    return (
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2)
    );
  }).pipe(Atom.withLabel(`web-default-project-fallback-ready:${projectKey}`)),
);
