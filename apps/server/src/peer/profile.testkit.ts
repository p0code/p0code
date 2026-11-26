import { AccountProfileId, type EnvironmentId } from "@t3tools/contracts";

import type * as ServerSettings from "../serverSettings.ts";

export const restrictProfileTo = (
  settings: ServerSettings.ServerSettingsService["Service"],
  environmentId: EnvironmentId,
) =>
  settings.updateSettings({
    activeAccountProfileId: AccountProfileId.make("test-profile"),
    accountProfiles: [
      {
        id: AccountProfileId.make("test-profile"),
        name: "Test",
        instanceOrder: [],
        excludedInstanceIds: [],
        linkedEnvironmentIds: [environmentId],
        autoSwitchOnLimit: false,
      },
    ],
  });
