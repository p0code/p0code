import {
  AccountProfileId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  effectiveAccountProfileSettings,
  newAccountProfile,
  type ProfileFilteringSettings,
} from "@t3tools/shared/accountProfiles";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  olderSettledScopesForProfile,
  unloadedOlderSettledCountForProfile,
} from "./olderSettledShelf";
import { isThreadVisibleInActiveProfile, type ActiveProfileThreadVisibility } from "./projects";

const personal = AccountProfileId.make("personal");
const school = AccountProfileId.make("school");
const mac = EnvironmentId.make("mac");
const remote = EnvironmentId.make("remoteTasker4");
const macScratch = ProjectId.make("mac-scratch");
const remoteScratch = ProjectId.make("remote-scratch");
const personalProject = ProjectId.make("personal-project");
const schoolProject = ProjectId.make("school-project");

const profiles = [
  newAccountProfile(personal, "Personal", []),
  newAccountProfile(school, "School", []),
];

function makeVisibility(input: {
  readonly active: AccountProfileId;
  readonly macThreads?: Record<ThreadId, AccountProfileId>;
  readonly remoteThreads?: Record<ThreadId, AccountProfileId>;
  readonly remoteSynced?: boolean;
}): ActiveProfileThreadVisibility {
  const primary = {
    accountProfiles: profiles,
    activeAccountProfileId: input.active,
  };
  const macSettings: ProfileFilteringSettings = {
    ...primary,
    projectAccountProfileIds: { [schoolProject]: school },
    threadAccountProfileIds: input.macThreads ?? {},
  };
  // Simulates a remote machine whose profiles have not synced (accountProfiles: []) or are stale.
  const remoteRaw = {
    ...DEFAULT_SERVER_SETTINGS,
    ...(input.remoteSynced ? { accountProfiles: profiles, activeAccountProfileId: personal } : {}),
    projectAccountProfileIds: {},
    threadAccountProfileIds: input.remoteThreads ?? {},
  };
  const remoteEffective = effectiveAccountProfileSettings(remoteRaw, primary)!;
  const hiddenProjectKeys = new Set<string>();
  if (input.active === school) {
    hiddenProjectKeys.add(`${mac}:${personalProject}`);
  } else {
    hiddenProjectKeys.add(`${mac}:${schoolProject}`);
  }
  return {
    hiddenEnvironments: new Set(),
    hiddenProjectKeys,
    projectScratchByKey: new Map([
      [`${mac}:${macScratch}`, true],
      [`${remote}:${remoteScratch}`, true],
      [`${mac}:${personalProject}`, false],
      [`${mac}:${schoolProject}`, false],
    ]),
    separatingByEnvironment: new Map([
      [mac, macSettings],
      [remote, remoteEffective],
    ]),
    primarySeparating: primary,
  };
}

function olderRow(environmentId: EnvironmentId, projectId: ProjectId, id: ThreadId) {
  return {
    environmentId,
    id,
    source: {
      id,
      projectId,
      lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
      settledOverride: "settled" as const,
      settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    },
  };
}

describe("profile isolation for threads and older settled counts", () => {
  it("hides unsynced remote legacy scratch threads under a non-home profile", () => {
    const zyxel = ThreadId.make("zyxel");
    const inkling = ThreadId.make("inkling");
    const schoolScratch = ThreadId.make("school-scratch");
    const schoolVisibility = makeVisibility({
      active: school,
      remoteThreads: { [schoolScratch]: school },
    });
    const personalVisibility = makeVisibility({
      active: personal,
      remoteThreads: { [schoolScratch]: school },
    });

    expect(
      isThreadVisibleInActiveProfile(
        { environmentId: remote, id: zyxel, projectId: remoteScratch },
        schoolVisibility,
      ),
    ).toBe(false);
    expect(
      isThreadVisibleInActiveProfile(
        { environmentId: remote, id: inkling, projectId: remoteScratch },
        schoolVisibility,
      ),
    ).toBe(false);
    expect(
      isThreadVisibleInActiveProfile(
        { environmentId: remote, id: schoolScratch, projectId: remoteScratch },
        schoolVisibility,
      ),
    ).toBe(true);

    expect(
      isThreadVisibleInActiveProfile(
        { environmentId: remote, id: zyxel, projectId: remoteScratch },
        personalVisibility,
      ),
    ).toBe(true);
    expect(
      isThreadVisibleInActiveProfile(
        { environmentId: remote, id: schoolScratch, projectId: remoteScratch },
        personalVisibility,
      ),
    ).toBe(false);
  });

  it("omits scratch projects from older-settled scopes and counts 0 legacy scratch threads in non-home profiles", () => {
    const visibility = makeVisibility({ active: school });
    const projects = [
      { environmentId: mac, id: macScratch, isScratch: true },
      { environmentId: remote, id: remoteScratch, isScratch: true },
      { environmentId: mac, id: personalProject, isScratch: false },
      { environmentId: mac, id: schoolProject, isScratch: false },
    ];
    const scopes = olderSettledScopesForProfile({
      environmentIds: [mac, remote],
      scopedProjectKeys: new Set([
        `${mac}:${macScratch}`,
        `${mac}:${schoolProject}`,
        `${remote}:${remoteScratch}`,
      ]),
      projects,
      loadedThreads: [],
      visibility,
    });
    expect(scopes).toEqual([{ environmentId: mac, projectIds: [schoolProject] }]);

    const before = "2026-06-01T00:00:00.000Z";
    const beforeMs = Date.parse(before);
    const unloaded = unloadedOlderSettledCountForProfile({
      olderSettled: (envId) =>
        envId === mac
          ? {
              before,
              beforeMs,
              counts: new Map([
                [macScratch, 200],
                [personalProject, 240],
                [schoolProject, 3],
              ]),
            }
          : { before, beforeMs, counts: new Map([[remoteScratch, 206]]) },
      scopes,
      allLoadedThreads: [],
      visibility,
    });
    expect(unloaded).toBe(3);

    // Even when scopedProjectKeys is null (all projects are scratch), legacy scratch threads count as 0.
    const scratchOnlyScopes = olderSettledScopesForProfile({
      environmentIds: [remote],
      scopedProjectKeys: null,
      projects: [{ environmentId: remote, id: remoteScratch, isScratch: true }],
      loadedThreads: [],
      visibility,
    });
    expect(scratchOnlyScopes).toEqual([]);
  });

  it("caps non-home unloaded scratch count to unloaded explicit threads and subtracts cross-profile loaded rows for home", () => {
    const loadedSchool = ThreadId.make("school-loaded");
    const unloadedSchool1 = ThreadId.make("school-unloaded-1");
    const unloadedSchool2 = ThreadId.make("school-unloaded-2");
    const before = "2026-06-01T00:00:00.000Z";
    const beforeMs = Date.parse(before);
    const olderSettled = (envId: EnvironmentId) =>
      envId === mac ? { before, beforeMs, counts: new Map([[macScratch, 200]]) } : null;

    const schoolVisibility = makeVisibility({
      active: school,
      macThreads: {
        [loadedSchool]: school,
        [unloadedSchool1]: school,
        [unloadedSchool2]: school,
      },
    });
    const allLoadedThreads = [olderRow(mac, macScratch, loadedSchool)];
    const schoolScopes = olderSettledScopesForProfile({
      environmentIds: [mac],
      scopedProjectKeys: new Set([`${mac}:${macScratch}`]),
      projects: [{ environmentId: mac, id: macScratch, isScratch: true }],
      loadedThreads: allLoadedThreads,
      visibility: schoolVisibility,
    });
    expect(schoolScopes).toEqual([{ environmentId: mac, projectIds: [macScratch] }]);
    expect(
      unloadedOlderSettledCountForProfile({
        olderSettled,
        scopes: schoolScopes,
        allLoadedThreads,
        visibility: schoolVisibility,
      }),
    ).toBe(2);

    // Under the home (Personal) profile, the loaded School row is still subtracted from the server count.
    const personalVisibility = makeVisibility({
      active: personal,
      macThreads: { [loadedSchool]: school },
    });
    expect(
      unloadedOlderSettledCountForProfile({
        olderSettled,
        scopes: [{ environmentId: mac, projectIds: [macScratch] }],
        allLoadedThreads,
        visibility: personalVisibility,
      }),
    ).toBe(199);
  });
});
