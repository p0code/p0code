import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { profileSettingsScopeEnvironments } from "./SettingsScopeContext";

const laptop = EnvironmentId.make("environment:laptop");
const school = EnvironmentId.make("environment:school");

describe("profileSettingsScopeEnvironments", () => {
  it("keeps archived threads and scheduled tasks scoped to linked machines only", () => {
    const environments = [{ environmentId: laptop }, { environmentId: school }];
    expect(
      profileSettingsScopeEnvironments(environments, new Set([school])).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([laptop]);
  });

  it("leaves every machine in place when the profile hides none", () => {
    const environments = [{ environmentId: laptop }, { environmentId: school }];
    expect(profileSettingsScopeEnvironments(environments, new Set())).toBe(environments);
  });
});
