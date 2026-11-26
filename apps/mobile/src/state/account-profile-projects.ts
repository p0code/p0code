import { useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  type EnvironmentId,
  isEnvironmentAllowedInActiveProfile,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  isProjectInActiveAccountProfile,
  isThreadInActiveAccountProfile,
  withoutHiddenEnvironments,
} from "@t3tools/shared/accountProfiles";
import { Atom } from "effect/reactivity";

import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells, steadyNavigationThreadShellsAtom } from "./threads";

/** Machines the active account profile leaves out of lists and pickers. */
export const profileHiddenEnvironmentIdsAtom = Atom.make((get) => {
  const hidden = new Set<EnvironmentId>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (!isEnvironmentAllowedInActiveProfile(config.settings, environmentId)) {
      hidden.add(environmentId);
    }
  }
  return hidden;
}).pipe(Atom.withLabel("mobile-profile-hidden-environment-ids"));

export function useProfileHiddenEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(profileHiddenEnvironmentIdsAtom);
}

/** `items` minus those on machines the active account profile leaves out. */
export function useProfileEnvironments<T extends { readonly environmentId: EnvironmentId }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const hidden = useAtomValue(profileHiddenEnvironmentIdsAtom);
  return withoutHiddenEnvironments(items, hidden);
}

/** Keeps the rows shown under their environment's active account profile, on its linked machines. */
function inActiveProfileAtom<A extends { readonly environmentId: EnvironmentId }>(
  label: string,
  source: Atom.Atom<ReadonlyArray<A>>,
  shown: (settings: ServerSettings | null, item: A) => boolean,
) {
  let previous: ReadonlyArray<A> = [];
  return Atom.make((get) => {
    const items = get(source);
    const next = items.filter((item) => {
      const settings = get(serverEnvironment.settingsValueAtom(item.environmentId));
      return (
        (settings === null || isEnvironmentAllowedInActiveProfile(settings, item.environmentId)) &&
        shown(settings, item)
      );
    });
    if (next.length === items.length) return (previous = items);
    if (arrayElementsEqual(previous, next)) return previous;
    return (previous = next);
  }).pipe(Atom.withLabel(label));
}

export const profileProjectsAtom = inActiveProfileAtom(
  "mobile-profile-projects",
  environmentProjects.projectsAtom,
  (settings, project) =>
    isProjectInActiveAccountProfile(settings, project.id, { isScratch: project.isScratch }),
);

export const profileNavigationThreadShellsAtom = inActiveProfileAtom(
  "mobile-profile-navigation-thread-shells",
  steadyNavigationThreadShellsAtom,
  (settings, thread) =>
    isThreadInActiveAccountProfile(settings, { id: thread.id, projectId: thread.projectId }),
);

const profileVisibleThreadShellsAtom = inActiveProfileAtom(
  "mobile-profile-visible-thread-shells",
  environmentThreadShells.visibleThreadShellsAtom,
  (settings, thread) =>
    isThreadInActiveAccountProfile(settings, { id: thread.id, projectId: thread.projectId }),
);

/** Projects to browse and pick: those in each environment's active account profile. */
export function useProfileProjects() {
  return useAtomValue(profileProjectsAtom);
}

/** Visible thread shells shown under their environment's active account profile. */
export function useProfileVisibleThreadShells() {
  return useAtomValue(profileVisibleThreadShellsAtom);
}
