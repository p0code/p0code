import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ServerSettings, WS_METHODS } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell, environmentSnapshotAtom, expectsPrimaryEnvironment } from "./shell";
import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { isProjectInActiveAccountProfile } from "@t3tools/shared/accountProfiles";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
/** `environmentId:projectId` keys of projects their environment's active account profile hides. */
export const profileHiddenProjectKeysAtom = Atom.make((get) => {
  const hidden = new Set<string>();
  for (const project of get(environmentProjects.projectsAtom)) {
    const settings = get(serverEnvironment.settingsValueAtom(project.environmentId));
    if (!isProjectInActiveAccountProfile(settings, project.id, { isScratch: project.isScratch })) {
      hidden.add(`${project.environmentId}:${project.id}`);
    }
  }
  return hidden;
}).pipe(
  // Settings pushes rebuild the set; keep it stable while the hidden projects stay the same.
  Atom.withEquality(
    (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
      a.size === b.size && [...a].every((key) => b.has(key)),
  ),
  Atom.withLabel("web-profile-hidden-project-keys"),
);

/** Settings of each environment whose account profiles separate projects and threads. */
export const profileSeparatingSettingsAtom = Atom.make((get) => {
  const separating = new Map<EnvironmentId, ServerSettings>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.settings.accountProfiles.length >= 2) separating.set(environmentId, config.settings);
  }
  return separating;
}).pipe(Atom.withLabel("web-profile-separating-settings"));

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
