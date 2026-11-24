import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AccountProfileId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("AccountProfileId"),
);
export type AccountProfileId = typeof AccountProfileId.Type;

/**
 * A named priority order over provider instances, such as "Personal" or "Work". Profiles live in
 * the environment's server settings, not in a client, because the server acts on the active one:
 * it routes MCP- and schedule-launched threads and fails a limited thread over to the next account.
 */
export const AccountProfile = Schema.Struct({
  id: AccountProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Highest priority first. Order only matters among one driver's instances; unlisted ones follow in settings order. */
  instanceOrder: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** When a thread hits a usage limit, continue it on the next account instead of waiting for the reset. */
  autoSwitchOnLimit: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type AccountProfile = typeof AccountProfile.Type;

export const DEFAULT_ACCOUNT_PROFILES: ReadonlyArray<AccountProfile> = [
  {
    id: AccountProfileId.make("personal"),
    name: "Personal",
    instanceOrder: [],
    autoSwitchOnLimit: false,
  },
  { id: AccountProfileId.make("work"), name: "Work", instanceOrder: [], autoSwitchOnLimit: false },
];

export const DEFAULT_ACTIVE_ACCOUNT_PROFILE_ID = AccountProfileId.make("personal");
