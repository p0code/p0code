import {
  AccountProfileId,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerSettings,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";
import {
  explicitProjectAccountProfile,
  nextAccountProfile,
  projectAccountProfile,
  threadAccountProfile,
} from "@t3tools/shared/accountProfiles";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "./environments";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";

/**
 * Quick switches act on the primary environment: it holds the accounts on this machine. Other
 * environments keep their own active profile, edited in their provider settings.
 */
function readPrimaryAccountProfiles() {
  const environmentId = readPrimaryEnvironmentId();
  const settings =
    environmentId === null
      ? null
      : appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  return environmentId === null || settings == null ? null : { environmentId, settings };
}

export async function setActiveAccountProfile(
  environmentId: EnvironmentId,
  activeAccountProfileId: AccountProfileId,
) {
  await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch: { activeAccountProfileId } } },
    { label: "switch account profile", reportFailure: true },
  );
}

export function cycleAccountProfile() {
  const current = readPrimaryAccountProfiles();
  const next = current === null ? undefined : nextAccountProfile(current.settings);
  if (current === null || next === undefined) return;
  void setActiveAccountProfile(current.environmentId, next.id);
}

/** The profiles a project can be filed under and its current one; null when there is nothing to pick. */
export function projectAccountProfileChoices(
  settings: ServerSettings | null | undefined,
  projectId: ProjectId,
) {
  if (settings == null || settings.accountProfiles.length < 2) return null;
  return {
    profiles: settings.accountProfiles,
    assignedId: projectAccountProfile(settings, projectId)?.id ?? null,
  };
}

export function readProjectAccountProfileChoices(projectRef: ScopedProjectRef) {
  return projectAccountProfileChoices(
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(projectRef.environmentId)),
    projectRef.projectId,
  );
}

/**
 * Files projects under a profile. Each environment keeps its own profiles, so one lacking the
 * profile leaves its projects alone.
 */
export async function setProjectAccountProfile(
  projectRefs: ReadonlyArray<ScopedProjectRef>,
  profileId: AccountProfileId,
) {
  const byEnvironment = new Map<EnvironmentId, ScopedProjectRef[]>();
  for (const projectRef of projectRefs) {
    byEnvironment.set(projectRef.environmentId, [
      ...(byEnvironment.get(projectRef.environmentId) ?? []),
      projectRef,
    ]);
  }
  await Promise.all(
    [...byEnvironment].map(([environmentId, refs]) => {
      const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
      if (!settings?.accountProfiles.some((profile) => profile.id === profileId)) {
        return undefined;
      }
      return runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateSettings,
        {
          environmentId,
          input: {
            patch: {
              projectAccountProfileIds: Object.fromEntries(
                refs.map((projectRef) => [projectRef.projectId, profileId]),
              ),
            },
          },
        },
        { label: "move project to account profile", reportFailure: true },
      );
    }),
  );
}

type AccountProfileChoices = NonNullable<ReturnType<typeof projectAccountProfileChoices>>;

/**
 * The thread's own profile choices; offered only for "No project" (scratch) threads, since
 * every other project belongs to one profile and places its threads.
 */
export function readThreadAccountProfileChoices(
  threadRef: ScopedThreadRef,
  projectId: ProjectId | null,
): AccountProfileChoices | null {
  const settings = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(threadRef.environmentId),
  );
  if (settings == null || settings.accountProfiles.length < 2) return null;
  if (projectId !== null) {
    const project = appAtomRegistry.get(
      environmentProjects.projectAtom({ environmentId: threadRef.environmentId, projectId }),
    );
    if (!project?.isScratch) return null;
    if (explicitProjectAccountProfile(settings, projectId) !== undefined) return null;
  }
  return {
    profiles: settings.accountProfiles,
    assignedId: threadAccountProfile(settings, { id: threadRef.threadId, projectId })?.id ?? null,
  };
}

export async function setThreadAccountProfile(
  threadRef: ScopedThreadRef,
  profileId: AccountProfileId,
) {
  await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    {
      environmentId: threadRef.environmentId,
      input: { patch: { threadAccountProfileIds: { [threadRef.threadId]: profileId } } },
    },
    { label: "move thread to account profile", reportFailure: true },
  );
}

type AccountProfileMenuId = "move-to-profile" | `profile:${string}`;

/** A "Move to profile" submenu; read a pick back with `pickedAccountProfile`. */
export function accountProfileMenuItem(
  choices: AccountProfileChoices,
): ContextMenuItem<AccountProfileMenuId> {
  return {
    id: "move-to-profile",
    label: m(msg("Move to profile")),
    children: choices.profiles.map((profile) => ({
      id: `profile:${profile.id}` as const,
      label: profile.name,
      checked: choices.assignedId === profile.id,
    })),
  };
}

/** Puts the submenu before the thread menu's project settings, when there is a choice. */
export function withAccountProfileMenu<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  choices: AccountProfileChoices | null,
): ReadonlyArray<ContextMenuItem<T | AccountProfileMenuId>> {
  if (choices === null) return items;
  const at = items.findIndex((item) => item.id === "project-settings");
  const index = at === -1 ? items.length : at;
  return [...items.slice(0, index), accountProfileMenuItem(choices), ...items.slice(index)];
}

export function isAccountProfileMenuId(id: string): id is AccountProfileMenuId {
  return id === "move-to-profile" || id.startsWith("profile:");
}

/** The profile a submenu pick chose, or undefined for the submenu itself. */
export function pickedAccountProfile(id: AccountProfileMenuId): AccountProfileId | undefined {
  if (id === "move-to-profile") return undefined;
  const profileId = id.slice("profile:".length);
  return profileId === "" ? undefined : AccountProfileId.make(profileId);
}
