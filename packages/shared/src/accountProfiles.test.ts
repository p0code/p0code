import {
  AccountProfileId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeProfileUnloadedScratchLimit,
  effectiveAccountProfileSettings,
  explicitProjectAccountProfile,
  isListedProfileAccount,
  isProjectInActiveAccountProfile,
  isThreadInActiveAccountProfile,
  limitFailoverSelection,
  listedProfileDrivers,
  moveProfileInstance,
  newProjectAccountProfilePatch,
  newThreadAccountProfilePatch,
  nextAccountProfile,
  projectAccountProfile,
  routeSelectionToAccountProfile,
  threadAccountProfile,
} from "./accountProfiles.ts";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const claude = ProviderDriverKind.make("claudeAgent");
const personal = ProviderInstanceId.make("claudePersonal");
const second = ProviderInstanceId.make("claudeSecond");
const company = ProviderInstanceId.make("claudeCompany");

function provider(instanceId: ProviderInstanceId, overrides: Partial<ServerProvider> = {}) {
  const snapshot: ServerProvider = {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-25T11:00:00.000Z",
    models: [{ slug: "claude-opus", name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
  return snapshot;
}

const limited = {
  usageLimits: {
    checkedAt: "2026-11-25T11:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session" as const,
        label: "Session",
        usedPercent: 100,
        resetsAt: "2026-11-25T14:00:00.000Z",
      },
    ],
  },
};

const settings = (activeAccountProfileId: string | null) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    [personal, second, company].map((id) => [id, { driver: claude, enabled: true }]),
  ),
  accountProfiles: [
    {
      id: AccountProfileId.make("personal"),
      name: "Personal",
      instanceOrder: [personal, second, company],
      excludedInstanceIds: [],
      linkedEnvironmentIds: [],
      autoSwitchOnLimit: true,
    },
    {
      id: AccountProfileId.make("work"),
      name: "Work",
      instanceOrder: [company],
      excludedInstanceIds: [],
      linkedEnvironmentIds: [],
      autoSwitchOnLimit: false,
    },
  ],
  activeAccountProfileId:
    activeAccountProfileId === null ? null : AccountProfileId.make(activeAccountProfileId),
});

// Settings order puts the company account first, so only the profile can explain the results.
const providers = [provider(company), provider(personal), provider(second)];
const opusOn = (instanceId: ProviderInstanceId) => ({ instanceId, model: "claude-opus" });

describe("listedProfileDrivers", () => {
  const cursor = ProviderDriverKind.make("cursor");
  const cursorMain = ProviderInstanceId.make("cursorMain");

  it("lists each driver with an existing account, in settings order", () => {
    expect(
      listedProfileDrivers([provider(cursorMain, { driver: cursor }), provider(personal)]),
    ).toEqual([cursor, claude]);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
    ["signed out", { auth: { status: "unauthenticated" as const } }],
    ["unavailable", { availability: "unavailable" as const }],
  ])("omits a driver whose only account is %s", (_case, overrides) => {
    const snapshot = provider(personal, overrides);
    expect(isListedProfileAccount(snapshot)).toBe(false);
    expect(listedProfileDrivers([snapshot])).toEqual([]);
  });

  it("keeps a driver once one of its accounts exists", () => {
    expect(
      listedProfileDrivers([
        provider(personal, { enabled: false }),
        provider(company, { installed: false }),
        provider(second),
      ]),
    ).toEqual([claude]);
  });

  it("keeps an expired Antigravity account listed whether or not a turn renews it", () => {
    for (const canRenewCredential of [true, false]) {
      const expired = provider(personal, {
        auth: {
          status: "authenticated",
          credentialStatus: "expired",
          canRenewCredential,
          email: "paid@example.com",
        },
      });
      expect(isListedProfileAccount(expired)).toBe(true);
      expect(listedProfileDrivers([expired])).toEqual([claude]);
    }
  });
});

describe("routeSelectionToAccountProfile", () => {
  it.each([
    ["personal", providers, personal],
    ["work", providers, company],
    ["personal", [provider(company), provider(personal, limited), provider(second)], second],
    [
      "personal",
      [provider(company), provider(personal, { enabled: false }), provider(second)],
      second,
    ],
    // Every account limited: keep the pick so the composer shows the limit.
    [
      "personal",
      [provider(company, limited), provider(personal, limited), provider(second, limited)],
      company,
    ],
    [
      "personal",
      [
        provider(company),
        provider(personal, {
          auth: { status: "authenticated", credentialStatus: "expired", canRenewCredential: true },
        }),
        provider(second),
      ],
      personal,
    ],
    [
      "personal",
      [
        provider(company),
        provider(personal, {
          auth: { status: "authenticated", credentialStatus: "expired", canRenewCredential: false },
        }),
        provider(second),
      ],
      second,
    ],
  ] as const)("profile %s routes to its first usable account", (profile, list, expected) => {
    expect(
      routeSelectionToAccountProfile({
        selection: opusOn(company),
        providers: list,
        settings: settings(profile),
        projectId: null,
        now,
      }).instanceId,
    ).toBe(expected);
  });

  it("keeps an existing selection when the active profile has no explicit driver order", () => {
    const preferences = settings("personal");
    expect(
      routeSelectionToAccountProfile({
        selection: opusOn(second),
        providers,
        settings: {
          ...preferences,
          accountProfiles: preferences.accountProfiles.map((profile) => ({
            ...profile,
            instanceOrder: [],
          })),
        },
        projectId: null,
        now,
      }).instanceId,
    ).toBe(second);
  });

  it("leaves the pick alone without an active profile", () => {
    expect(
      routeSelectionToAccountProfile({
        selection: opusOn(company),
        providers,
        settings: settings(null),
        projectId: null,
        now,
      }).instanceId,
    ).toBe(company);
  });
});

describe("limitFailoverSelection", () => {
  const failover = (from: ProviderInstanceId, list = providers, profile = "personal") =>
    limitFailoverSelection({
      selection: opusOn(from),
      providers: list,
      settings: settings(profile),
      projectId: null,
      now,
    })?.instanceId ?? null;

  it("continues on the next account in profile order, skipping limited ones", () => {
    expect(failover(personal)).toBe(second);
    expect(
      failover(personal, [provider(company), provider(personal), provider(second, limited)]),
    ).toBe(company);
  });

  it("never moves back up the order, so a chain of limits ends", () => {
    expect(failover(company)).toBeNull();
    // The Work profile lists only the company account; the others follow in settings order.
    expect(failover(company, providers, "work")).toBe(personal);
  });

  it("skips an account whose catalog lacks the model", () => {
    expect(
      failover(personal, [
        provider(company),
        provider(personal),
        provider(second, {
          models: [{ slug: "claude-sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
        }),
      ]),
    ).toBe(company);
  });
});

describe("profile editing", () => {
  it("reorders one driver's accounts and keeps other drivers' entries", () => {
    const codex = ProviderInstanceId.make("codexMain");
    const profile = {
      ...settings("personal").accountProfiles[0]!,
      instanceOrder: [codex, personal],
    };
    const moved = moveProfileInstance(profile, [personal, second, company], company, -2);
    expect(moved.instanceOrder).toEqual([codex, company, personal, second]);
  });

  it("cycles to the next profile and wraps", () => {
    expect(nextAccountProfile(settings("personal"))?.id).toBe("work");
    expect(nextAccountProfile(settings("work"))?.id).toBe("personal");
    expect(nextAccountProfile(settings(null))?.id).toBe("personal");
    expect(nextAccountProfile(DEFAULT_SERVER_SETTINGS)).toBeUndefined();
  });
});

describe("project separation", () => {
  const personalProfile = AccountProfileId.make("personal");
  const work = AccountProfileId.make("work");
  const workProject = ProjectId.make("project-work");
  const unassignedProject = ProjectId.make("project-unassigned");
  const scratchProject = ProjectId.make("project-scratch");
  const orphanedProject = ProjectId.make("project-orphaned");
  const projectSettings = (activeAccountProfileId: string) => ({
    ...settings(activeAccountProfileId),
    projectAccountProfileIds: {
      [workProject]: work,
      [orphanedProject]: AccountProfileId.make("deleted"),
    },
  });

  it("defaults to no profiles and hides nothing", () => {
    expect(DEFAULT_SERVER_SETTINGS.accountProfiles).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.activeAccountProfileId).toBeNull();
    expect(projectAccountProfile(DEFAULT_SERVER_SETTINGS, unassignedProject)).toBeUndefined();
    expect(
      threadAccountProfile(DEFAULT_SERVER_SETTINGS, {
        id: ThreadId.make("thread-default"),
        projectId: unassignedProject,
      }),
    ).toBeUndefined();
    expect(isProjectInActiveAccountProfile(DEFAULT_SERVER_SETTINGS, unassignedProject)).toBe(true);
    expect(
      isThreadInActiveAccountProfile(DEFAULT_SERVER_SETTINGS, {
        id: ThreadId.make("thread-default"),
        projectId: unassignedProject,
      }),
    ).toBe(true);
    expect(
      newProjectAccountProfilePatch(DEFAULT_SERVER_SETTINGS, unassignedProject),
    ).toBeUndefined();
  });

  it("assigns unassigned and orphaned projects to the first (home) profile, keeping scratch in every profile", () => {
    expect(projectAccountProfile(projectSettings("work"), workProject)?.id).toBe(work);
    expect(projectAccountProfile(projectSettings("work"), unassignedProject)?.id).toBe(
      personalProfile,
    );
    expect(projectAccountProfile(projectSettings("work"), orphanedProject)?.id).toBe(
      personalProfile,
    );
    expect(
      explicitProjectAccountProfile(projectSettings("work"), unassignedProject),
    ).toBeUndefined();

    expect(isProjectInActiveAccountProfile(projectSettings("work"), workProject)).toBe(true);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), workProject)).toBe(false);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), unassignedProject)).toBe(
      true,
    );
    expect(isProjectInActiveAccountProfile(projectSettings("work"), unassignedProject)).toBe(false);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), orphanedProject)).toBe(
      true,
    );
    expect(isProjectInActiveAccountProfile(projectSettings("work"), orphanedProject)).toBe(false);
    expect(
      isProjectInActiveAccountProfile(projectSettings("personal"), scratchProject, {
        isScratch: true,
      }),
    ).toBe(true);
    expect(
      isProjectInActiveAccountProfile(projectSettings("work"), scratchProject, { isScratch: true }),
    ).toBe(true);
  });

  it("hides nothing with a single profile", () => {
    const single = {
      ...projectSettings("personal"),
      accountProfiles: settings("personal").accountProfiles.slice(0, 1),
    };
    expect(isProjectInActiveAccountProfile(single, workProject)).toBe(true);
    expect(newProjectAccountProfilePatch(single, unassignedProject)).toBeUndefined();
  });

  it("files a new project under the active profile", () => {
    expect(newProjectAccountProfilePatch(projectSettings("work"), unassignedProject)).toEqual({
      projectAccountProfileIds: { [unassignedProject]: work },
    });
  });

  it("files a thread by its project's explicit profile, else its own profile, else the home profile", () => {
    const thread = ThreadId.make("thread-1");
    const other = ThreadId.make("other");
    const filed = {
      ...projectSettings("personal"),
      threadAccountProfileIds: { [thread]: work },
    };
    // Explicit thread profile wins when project has no explicit assignment (e.g. scratch).
    expect(threadAccountProfile(filed, { id: thread, projectId: scratchProject })?.id).toBe(work);
    expect(isThreadInActiveAccountProfile(filed, { id: thread, projectId: scratchProject })).toBe(
      false,
    );
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, activeAccountProfileId: work },
        { id: thread, projectId: scratchProject },
      ),
    ).toBe(true);
    // The project's explicit profile wins over the thread's own.
    expect(
      threadAccountProfile(
        { ...filed, threadAccountProfileIds: { [thread]: personalProfile } },
        { id: thread, projectId: workProject },
      )?.id,
    ).toBe(work);
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, threadAccountProfileIds: { [thread]: personalProfile } },
        { id: thread, projectId: workProject },
      ),
    ).toBe(false);
    // Unassigned threads belong to the first (home) profile, not to all profiles.
    expect(threadAccountProfile(filed, { id: other, projectId: scratchProject })?.id).toBe(
      personalProfile,
    );
    expect(isThreadInActiveAccountProfile(filed, { id: other, projectId: scratchProject })).toBe(
      true,
    );
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, activeAccountProfileId: work },
        { id: other, projectId: scratchProject },
      ),
    ).toBe(false);
    expect(isThreadInActiveAccountProfile(filed, { id: other, projectId: null })).toBe(true);
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, activeAccountProfileId: work },
        { id: other, projectId: null },
      ),
    ).toBe(false);
  });

  it("files a new thread only when its project has no explicit profile", () => {
    const thread = ThreadId.make("thread-new");
    expect(
      newThreadAccountProfilePatch(projectSettings("work"), {
        id: thread,
        projectId: scratchProject,
      }),
    ).toEqual({ threadAccountProfileIds: { [thread]: work } });
    expect(
      newThreadAccountProfilePatch(projectSettings("work"), { id: thread, projectId: workProject }),
    ).toBeUndefined();
  });

  it("locks non-scratch legacy project threads to the home profile even with a thread override", () => {
    const thread = ThreadId.make("thread-legacy-project");
    const withOverride = {
      ...projectSettings("work"),
      threadAccountProfileIds: { [thread]: work },
    };
    expect(
      threadAccountProfile(withOverride, {
        id: thread,
        projectId: unassignedProject,
        isScratchProject: false,
      })?.id,
    ).toBe(personalProfile);
    expect(
      isThreadInActiveAccountProfile(withOverride, {
        id: thread,
        projectId: unassignedProject,
        isScratchProject: false,
      }),
    ).toBe(false);
    expect(
      isThreadInActiveAccountProfile(
        { ...withOverride, activeAccountProfileId: personalProfile },
        { id: thread, projectId: unassignedProject, isScratchProject: false },
      ),
    ).toBe(true);
  });

  it("overlays primary profiles onto remote settings while keeping remote filing", () => {
    const remoteThread = ThreadId.make("remote-work-thread");
    const legacyRemoteThread = ThreadId.make("remote-legacy-thread");
    const primary = settings("work");
    const unsyncedRemote = {
      ...DEFAULT_SERVER_SETTINGS,
      projectAccountProfileIds: { [workProject]: work },
      threadAccountProfileIds: { [remoteThread]: work },
    };
    const effective = effectiveAccountProfileSettings(unsyncedRemote, primary);
    expect(effective?.activeAccountProfileId).toBe(work);
    expect(isProjectInActiveAccountProfile(effective, workProject)).toBe(true);
    expect(isProjectInActiveAccountProfile(effective, unassignedProject)).toBe(false);
    expect(
      isThreadInActiveAccountProfile(effective, {
        id: remoteThread,
        projectId: scratchProject,
        isScratchProject: true,
      }),
    ).toBe(true);
    expect(
      isThreadInActiveAccountProfile(effective, {
        id: legacyRemoteThread,
        projectId: scratchProject,
        isScratchProject: true,
      }),
    ).toBe(false);

    // Offline/unloaded remote still isolates legacy items to the home profile.
    const offline = effectiveAccountProfileSettings(null, primary);
    expect(
      isThreadInActiveAccountProfile(offline, {
        id: legacyRemoteThread,
        projectId: scratchProject,
        isScratchProject: true,
      }),
    ).toBe(false);

    // Without a primary (or when primary has no profiles), falls back to the target's own settings.
    expect(effectiveAccountProfileSettings(projectSettings("work"), null)).toEqual(
      projectSettings("work"),
    );
    expect(
      effectiveAccountProfileSettings(projectSettings("work"), DEFAULT_SERVER_SETTINGS),
    ).toEqual(projectSettings("work"));
  });

  it("bounds unloaded scratch settled counts under non-home profiles to explicit unloaded threads", () => {
    const loadedWork = ThreadId.make("work-loaded");
    const unloadedWork = ThreadId.make("work-unloaded");
    const personalThread = ThreadId.make("personal-thread");
    const loaded = new Set<ThreadId>([loadedWork]);

    // No limit when home profile is active or fewer than two profiles exist.
    expect(activeProfileUnloadedScratchLimit(DEFAULT_SERVER_SETTINGS, loaded)).toBeNull();
    expect(activeProfileUnloadedScratchLimit(projectSettings("personal"), loaded)).toBeNull();

    // Under a non-home profile with no explicit threads, limit is 0 (legacy threads never count).
    expect(activeProfileUnloadedScratchLimit(projectSettings("work"), loaded)).toBe(0);

    // Counts only unloaded threads explicitly assigned to the active non-home profile.
    const withThreads = {
      ...projectSettings("work"),
      threadAccountProfileIds: {
        [loadedWork]: work,
        [unloadedWork]: work,
        [personalThread]: personalProfile,
      },
    };
    expect(activeProfileUnloadedScratchLimit(withThreads, loaded)).toBe(1);
    expect(
      activeProfileUnloadedScratchLimit(withThreads, new Set([loadedWork, unloadedWork])),
    ).toBe(0);
  });
});
