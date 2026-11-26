import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const AccountProfileId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("AccountProfileId"),
);
export type AccountProfileId = typeof AccountProfileId.Type;

/**
 * A named profile over provider instances and settings, such as "Personal" or "Work". Profiles
 * live in the environment's server settings, not in a client, because the server acts on the
 * active one: it restricts disallowed accounts, applies profile defaults, routes MCP- and
 * schedule-launched threads, and fails a limited thread over to the next allowed account.
 */
export const AccountProfile = Schema.Struct({
  id: AccountProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Highest priority first. Order only matters among one driver's instances; unlisted ones follow in settings order. */
  instanceOrder: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** Provider accounts hidden/disallowed while this profile is active (e.g. keep work Claude/Codex accounts out of Personal). */
  excludedInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /**
   * Machines whose projects and threads show while this profile is active. Empty means every
   * machine. Shared across environments by profile sync, unlike the account fields above.
   */
  linkedEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** When a thread hits a usage limit, continue it on the next account instead of waiting for the reset. */
  autoSwitchOnLimit: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Optional per-profile default permission mode override (absent = inherit environment setting). */
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  /** Optional per-profile default model & account override (absent = inherit environment setting). */
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type AccountProfile = typeof AccountProfile.Type;

export const DEFAULT_ACCOUNT_PROFILES: ReadonlyArray<AccountProfile> = [];

export const DEFAULT_ACTIVE_ACCOUNT_PROFILE_ID: AccountProfileId | null = null;

export const resolveActiveAccountProfile = (settings: {
  readonly accountProfiles?: ReadonlyArray<AccountProfile> | undefined;
  readonly activeAccountProfileId?: AccountProfileId | null | undefined;
}): AccountProfile | undefined => {
  if (!settings.activeAccountProfileId || !settings.accountProfiles) return undefined;
  return settings.accountProfiles.find((profile) => profile.id === settings.activeAccountProfileId);
};

export const isProviderInstanceAllowedInActiveProfile = (
  settings: {
    readonly accountProfiles?: ReadonlyArray<AccountProfile> | undefined;
    readonly activeAccountProfileId?: AccountProfileId | null | undefined;
  },
  instanceId: ProviderInstanceId,
): boolean => {
  const profile = resolveActiveAccountProfile(settings);
  if (!profile) return true;
  return !profile.excludedInstanceIds.includes(instanceId);
};

type ActiveProfileSettings = {
  readonly accountProfiles?: ReadonlyArray<AccountProfile> | undefined;
  readonly activeAccountProfileId?: AccountProfileId | null | undefined;
};

/** The machines the active profile limits the app to, or null when every machine shows. */
export const environmentsAllowedInActiveProfile = (
  settings: ActiveProfileSettings,
): ReadonlyArray<EnvironmentId> | null => {
  const linked = resolveActiveAccountProfile(settings)?.linkedEnvironmentIds;
  return linked === undefined || linked.length === 0 ? null : linked;
};

/** Whether a machine's projects and threads show (and accept new threads) under the active profile. */
export const isEnvironmentAllowedInActiveProfile = (
  settings: ActiveProfileSettings,
  environmentId: EnvironmentId,
): boolean => environmentsAllowedInActiveProfile(settings)?.includes(environmentId) ?? true;
