import { type EnvironmentId, isEnvironmentAllowedInActiveProfile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ServerSettings from "./serverSettings.ts";

export const ENVIRONMENT_NOT_IN_PROFILE =
  "This machine is not allowed in the active profile. Link it to the profile in Settings to use it here.";

/** Read the synced server copy on each operation, including after a profile switch. */
export const environmentAllowedInActiveProfile = (
  settings: ServerSettings.ServerSettingsService["Service"],
  environmentId: EnvironmentId,
) =>
  settings.getSettings.pipe(
    Effect.map((value) => isEnvironmentAllowedInActiveProfile(value, environmentId)),
    // Match ThreadLaunchService's behavior when settings cannot be read.
    Effect.orElseSucceed(() => true),
  );
