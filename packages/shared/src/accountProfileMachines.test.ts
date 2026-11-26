import {
  type AccountProfile,
  AccountProfileId,
  EnvironmentId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  newAccountProfile,
  profileHiddenEnvironmentIds,
  setProfileEnvironmentLinked,
} from "./accountProfiles.ts";

type ProfileSettings = Pick<ServerSettings, "accountProfiles" | "activeAccountProfileId">;

const laptop = EnvironmentId.make("environment:laptop");
const school = EnvironmentId.make("environment:school");
const vps = EnvironmentId.make("environment:vps");
const known = [laptop, school, vps];
const personalId = AccountProfileId.make("personal");
const schoolId = AccountProfileId.make("school");

const profile = (
  id: AccountProfileId,
  linkedEnvironmentIds: AccountProfile["linkedEnvironmentIds"],
) => ({ ...newAccountProfile(id, id, []), linkedEnvironmentIds }) satisfies AccountProfile;

const settings = (
  active: AccountProfileId | null,
  profiles: ReadonlyArray<AccountProfile> = [
    profile(personalId, [laptop, vps]),
    profile(schoolId, [school]),
  ],
): ProfileSettings => ({ accountProfiles: profiles, activeAccountProfileId: active });

const everywhere = (value: ProfileSettings) =>
  new Map(known.map((environmentId) => [environmentId, value] as const));

describe("profileHiddenEnvironmentIds", () => {
  it("hides machines the active profile does not link", () => {
    expect([...profileHiddenEnvironmentIds(everywhere(settings(personalId)), laptop)]).toEqual([
      school,
    ]);
  });

  it("changes the visible set when the profile switches", () => {
    expect([...profileHiddenEnvironmentIds(everywhere(settings(schoolId)), laptop)]).toEqual([
      laptop,
      vps,
    ]);
  });

  it("shows every machine for an empty list or no active profile", () => {
    const empty = settings(personalId, [profile(personalId, [])]);
    expect(profileHiddenEnvironmentIds(everywhere(empty), laptop).size).toBe(0);
    expect(profileHiddenEnvironmentIds(everywhere(settings(null)), laptop).size).toBe(0);
  });

  it("follows the primary's profiles even before a peer's synced copy catches up", () => {
    const byEnvironment = new Map<EnvironmentId, ProfileSettings>([
      [laptop, settings(schoolId)],
      [school, settings(personalId)],
    ]);
    expect([...profileHiddenEnvironmentIds(byEnvironment, laptop)]).toEqual([laptop]);
    // Without a primary, each machine's own copy decides.
    expect([...profileHiddenEnvironmentIds(byEnvironment, null)]).toEqual([laptop, school]);
  });
});

describe("profile machine editing", () => {
  it("links every known machine on a new profile, so nothing vanishes", () => {
    const created = newAccountProfile(personalId, "Personal", known);
    expect(created.linkedEnvironmentIds).toEqual(known);
    const active = settings(personalId, [created]);
    expect(profileHiddenEnvironmentIds(everywhere(active), laptop).size).toBe(0);
  });

  it("narrows from all machines on the first uncheck and saves the result", () => {
    const narrowed = setProfileEnvironmentLinked(profile(personalId, []), known, school, false);
    expect(narrowed.linkedEnvironmentIds).toEqual([laptop, vps]);
    const relinked = setProfileEnvironmentLinked(narrowed, known, school, true);
    expect(relinked.linkedEnvironmentIds).toEqual([laptop, vps, school]);
  });

  it("returns to all machines when the last one is unchecked", () => {
    const one = profile(personalId, [laptop]);
    expect(setProfileEnvironmentLinked(one, known, laptop, false).linkedEnvironmentIds).toEqual([]);
  });
});
