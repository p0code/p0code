import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { collectExpiredCredentialAccounts, providerSettingsHref } from "./expiredCredentials";

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_paid");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity Paid",
  enabled: true,
  installed: true,
  version: "test-version",
  status: "warning",
  auth: {
    status: "authenticated",
    type: "oauth-personal",
    label: "Google account",
    email: "paid@example.com",
    credentialStatus: "expired",
    canRenewCredential: true,
  },
  checkedAt: "2026-11-25T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

const presentations = (providers: readonly ServerProvider[]): LimitPresentations =>
  new Map([
    [
      environmentId,
      {
        entry: { target: { label: "Remote Google device" } },
        serverConfig: { providers },
      },
    ],
  ]);

describe("expired credential accounts", () => {
  it("keeps an expired account with the email and whether a turn renews it", () => {
    expect(collectExpiredCredentialAccounts(presentations([provider]))).toEqual([
      {
        environmentId,
        instanceId,
        name: "Antigravity Paid",
        email: "paid@example.com",
        canRenew: true,
      },
    ]);
  });

  it("leaves healthy and signed-out accounts out of the warning", () => {
    expect(
      collectExpiredCredentialAccounts(
        presentations([
          { ...provider, auth: { ...provider.auth, credentialStatus: "valid" } },
          { ...provider, auth: { ...provider.auth, credentialStatus: "unknown" } },
        ]),
      ),
    ).toEqual([]);
  });

  it("links the warning to the exact provider settings row", () => {
    expect(providerSettingsHref(environmentId, instanceId)).toBe(
      "/settings/providers?environmentId=remote-google&instanceId=antigravity_paid",
    );
  });
});
