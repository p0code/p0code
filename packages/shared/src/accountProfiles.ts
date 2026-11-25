import {
  type AccountProfile,
  type AccountProfileId,
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";

import { exhaustedUsageWindow } from "./usageLimits.ts";

type ProfileSettings = Pick<
  ServerSettings,
  "accountProfiles" | "activeAccountProfileId" | "providerInstances" | "projectSettingsOverrides"
>;

function activeAccountProfile(
  settings: Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId">,
): AccountProfile | undefined {
  return settings.accountProfiles.find((profile) => profile.id === settings.activeAccountProfileId);
}

/** The driver's instances, highest priority first: the profile's list, then the rest in settings order. */
export function orderInstancesForDriver(
  profile: Pick<AccountProfile, "instanceOrder"> | undefined,
  providers: ReadonlyArray<ServerProvider>,
  driver: ProviderDriverKind,
): ServerProvider[] {
  const rank = (instanceId: ProviderInstanceId) => {
    const index = profile?.instanceOrder.indexOf(instanceId) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return providers
    .filter((provider) => provider.driver === driver)
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider.instanceId) - rank(b.provider.instanceId) || a.index - b.index)
    .map(({ provider }) => provider);
}

interface RouteInput {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ProfileSettings;
  readonly projectId: ProjectId | null;
  readonly now: number;
}

function canRun(provider: ServerProvider, input: RouteInput): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId) &&
    // Accounts of one driver can still differ in plan; never route a model the target lacks.
    (provider.models.length === 0 ||
      provider.models.some((model) => model.slug === input.selection.model)) &&
    !exhaustedUsageWindow(provider, input.now, input.selection.model)
  );
}

function candidates(input: RouteInput): ServerProvider[] {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  if (!current) return [];
  return orderInstancesForDriver(
    activeAccountProfile(input.settings),
    input.providers,
    current.driver,
  );
}

/**
 * The instance a new thread on this model should start on: the active profile's first account of
 * the same driver that can run it now. Keeps the selection when none can, so the limit shows.
 */
export function routeSelectionToAccountProfile(input: RouteInput): ModelSelection {
  const profile = activeAccountProfile(input.settings);
  const driver = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  )?.driver;
  if (!profile) return input.selection;
  const currentExcluded = profile.excludedInstanceIds.includes(input.selection.instanceId);
  const hasOrder = profile.instanceOrder.some((id) =>
    input.providers.some((provider) => provider.instanceId === id && provider.driver === driver),
  );
  if (!currentExcluded && !hasOrder) return input.selection;
  const target = candidates(input).find((provider) => canRun(provider, input));
  return target === undefined || target.instanceId === input.selection.instanceId
    ? input.selection
    : { ...input.selection, instanceId: target.instanceId };
}

/**
 * Where a thread limited on `selection` can continue: the next account after it in the active
 * profile's order. Only later accounts qualify, so a chain of limits ends instead of cycling.
 */
export function limitFailoverSelection(input: RouteInput): ModelSelection | null {
  const ordered = candidates(input);
  const index = ordered.findIndex((provider) => provider.instanceId === input.selection.instanceId);
  if (index === -1) return null;
  const target = ordered.slice(index + 1).find((provider) => canRun(provider, input));
  return target === undefined ? null : { ...input.selection, instanceId: target.instanceId };
}

/** Whether the server should fail limited threads over on its own, rather than only offer it. */
export function autoSwitchesAccountOnLimit(
  settings: Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId">,
): boolean {
  return activeAccountProfile(settings)?.autoSwitchOnLimit === true;
}

/**
 * Moves one instance `steps` places among its driver's accounts. `driverOrder` is that driver's
 * current order; other drivers' entries keep their places in the stored list.
 */
export function moveProfileInstance(
  profile: AccountProfile,
  driverOrder: ReadonlyArray<ProviderInstanceId>,
  instanceId: ProviderInstanceId,
  steps: number,
): AccountProfile {
  const from = driverOrder.indexOf(instanceId);
  if (from === -1) return profile;
  const to = Math.max(0, Math.min(driverOrder.length - 1, from + steps));
  const next = driverOrder.filter((id) => id !== instanceId);
  next.splice(to, 0, instanceId);
  const others = profile.instanceOrder.filter((id) => !driverOrder.includes(id));
  return { ...profile, instanceOrder: [...others, ...next] };
}

/** The profile after the active one, wrapping around, for a quick-switch shortcut. */
export function nextAccountProfile(
  settings: Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId">,
): AccountProfile | undefined {
  if (settings.accountProfiles.length === 0) return undefined;
  const index = settings.accountProfiles.findIndex(
    (profile) => profile.id === settings.activeAccountProfileId,
  );
  return settings.accountProfiles[(index + 1) % settings.accountProfiles.length];
}

type ProjectProfileSettings = Pick<
  ServerSettings,
  "accountProfiles" | "activeAccountProfileId" | "projectAccountProfileIds"
>;
type ThreadProfileSettings = ProjectProfileSettings &
  Pick<ServerSettings, "threadAccountProfileIds">;
interface ProfiledThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId | null;
}

function existingProfile(
  settings: Pick<ServerSettings, "accountProfiles">,
  profileId: AccountProfileId | undefined,
): AccountProfile | undefined {
  return profileId === undefined
    ? undefined
    : settings.accountProfiles.find((profile) => profile.id === profileId);
}

function homeAccountProfile(
  settings: Pick<ServerSettings, "accountProfiles">,
): AccountProfile | undefined {
  return settings.accountProfiles[0];
}

/** The existing profile a project is explicitly assigned to, or undefined when unassigned. */
export function explicitProjectAccountProfile(
  settings: ProjectProfileSettings,
  projectId: ProjectId,
): AccountProfile | undefined {
  return existingProfile(settings, settings.projectAccountProfileIds[projectId]);
}

/** The profile a project belongs to: its explicit assignment, else the first (home) profile. */
export function projectAccountProfile(
  settings: ProjectProfileSettings,
  projectId: ProjectId,
): AccountProfile | undefined {
  return explicitProjectAccountProfile(settings, projectId) ?? homeAccountProfile(settings);
}

/** A thread follows its project's explicit profile, else its own profile, else the first (home) profile. */
export function threadAccountProfile(
  settings: ThreadProfileSettings,
  thread: ProfiledThread,
): AccountProfile | undefined {
  return (
    (thread.projectId === null
      ? undefined
      : explicitProjectAccountProfile(settings, thread.projectId)) ??
    existingProfile(settings, settings.threadAccountProfileIds[thread.id]) ??
    homeAccountProfile(settings)
  );
}

function shownUnderActiveProfile(
  settings: Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId">,
  assigned: AccountProfile | undefined,
): boolean {
  if (settings.accountProfiles.length < 2) return true;
  const active = activeAccountProfile(settings);
  return active === undefined || assigned === undefined || assigned.id === active.id;
}

/** Whether a project shows under the active profile. Scratch ("No project") stays in every profile. */
export function isProjectInActiveAccountProfile(
  settings: ProjectProfileSettings | null | undefined,
  projectId: ProjectId,
  options?: { readonly isScratch?: boolean | undefined },
): boolean {
  return (
    settings == null ||
    options?.isScratch === true ||
    shownUnderActiveProfile(settings, projectAccountProfile(settings, projectId))
  );
}

/** Whether a thread shows under the active profile. Never hides with fewer than two profiles. */
export function isThreadInActiveAccountProfile(
  settings: ThreadProfileSettings | null | undefined,
  thread: ProfiledThread,
): boolean {
  return (
    settings == null || shownUnderActiveProfile(settings, threadAccountProfile(settings, thread))
  );
}

function activeProfileWhenSeparating(settings: ProjectProfileSettings) {
  return settings.accountProfiles.length < 2 ? undefined : activeAccountProfile(settings);
}

/** The patch that files a new project under the active profile, or undefined when there is nothing to separate. */
export function newProjectAccountProfilePatch(
  settings: ProjectProfileSettings,
  projectId: ProjectId,
): Pick<ServerSettingsPatch, "projectAccountProfileIds"> | undefined {
  const active = activeProfileWhenSeparating(settings);
  return active === undefined
    ? undefined
    : { projectAccountProfileIds: { [projectId]: active.id } };
}

/** Files a new thread under the active profile unless its project already places it. */
export function newThreadAccountProfilePatch(
  settings: ThreadProfileSettings,
  thread: ProfiledThread,
): Pick<ServerSettingsPatch, "threadAccountProfileIds"> | undefined {
  const active = activeProfileWhenSeparating(settings);
  if (active === undefined) return undefined;
  if (thread.projectId !== null && explicitProjectAccountProfile(settings, thread.projectId))
    return undefined;
  return { threadAccountProfileIds: { [thread.id]: active.id } };
}
