import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AccountProfile,
  AccountProfileId,
  environmentsAllowedInActiveProfile,
  isEnvironmentAllowedInActiveProfile,
} from "./accountProfile.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { ServerSettings } from "./settings.ts";

const decodeProfile = Schema.decodeUnknownSync(AccountProfile);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

const laptop = EnvironmentId.make("environment:laptop");
const school = EnvironmentId.make("environment:school");

describe("AccountProfile linkedEnvironmentIds", () => {
  it("decodes a profile saved before machine links as linking every machine", () => {
    const profile = decodeProfile({ id: "personal", name: "Personal" });
    expect(profile.linkedEnvironmentIds).toEqual([]);
    const settings = { accountProfiles: [profile], activeAccountProfileId: profile.id };
    expect(environmentsAllowedInActiveProfile(settings)).toBeNull();
    expect(isEnvironmentAllowedInActiveProfile(settings, school)).toBe(true);
  });

  it("allows only the linked machines while the profile is active", () => {
    const personal = decodeProfile({
      id: "personal",
      name: "Personal",
      linkedEnvironmentIds: [laptop],
    });
    const work = decodeProfile({ id: "school", name: "School", linkedEnvironmentIds: [school] });
    const active = (id: string) => ({
      accountProfiles: [personal, work],
      activeAccountProfileId: AccountProfileId.make(id),
    });
    expect(isEnvironmentAllowedInActiveProfile(active("personal"), laptop)).toBe(true);
    expect(isEnvironmentAllowedInActiveProfile(active("personal"), school)).toBe(false);
    expect(isEnvironmentAllowedInActiveProfile(active("school"), laptop)).toBe(false);
    expect(isEnvironmentAllowedInActiveProfile(active("school"), school)).toBe(true);
    // No active profile restricts nothing.
    expect(
      isEnvironmentAllowedInActiveProfile(
        { accountProfiles: [personal], activeAccountProfileId: null },
        school,
      ),
    ).toBe(true);
  });

  it("round-trips through server settings", () => {
    const settings = decodeServerSettings({
      accountProfiles: [{ id: "personal", name: "Personal", linkedEnvironmentIds: [laptop] }],
      activeAccountProfileId: "personal",
    });
    const again = decodeServerSettings(encodeServerSettings(settings));
    expect(again.accountProfiles[0]?.linkedEnvironmentIds).toEqual([laptop]);
  });
});
