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
  isProjectInActiveAccountProfile,
  isThreadInActiveAccountProfile,
  limitFailoverSelection,
  moveProfileInstance,
  newProjectAccountProfilePatch,
  newThreadAccountProfilePatch,
  nextAccountProfile,
  routeSelectionToAccountProfile,
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
      autoSwitchOnLimit: true,
    },
    {
      id: AccountProfileId.make("work"),
      name: "Work",
      instanceOrder: [company],
      excludedInstanceIds: [],
      autoSwitchOnLimit: false,
    },
  ],
  activeAccountProfileId:
    activeAccountProfileId === null ? null : AccountProfileId.make(activeAccountProfileId),
});

// Settings order puts the company account first, so only the profile can explain the results.
const providers = [provider(company), provider(personal), provider(second)];
const opusOn = (instanceId: ProviderInstanceId) => ({ instanceId, model: "claude-opus" });

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
  });
});

describe("project separation", () => {
  const work = AccountProfileId.make("work");
  const workProject = ProjectId.make("project-work");
  const sharedProject = ProjectId.make("project-shared");
  const orphanedProject = ProjectId.make("project-orphaned");
  const projectSettings = (activeAccountProfileId: string) => ({
    ...DEFAULT_SERVER_SETTINGS,
    activeAccountProfileId: AccountProfileId.make(activeAccountProfileId),
    projectAccountProfileIds: {
      [workProject]: work,
      [orphanedProject]: AccountProfileId.make("deleted"),
    },
  });

  it("shows a project only under its profile, and unassigned ones everywhere", () => {
    expect(isProjectInActiveAccountProfile(projectSettings("work"), workProject)).toBe(true);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), workProject)).toBe(false);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), sharedProject)).toBe(true);
    expect(isProjectInActiveAccountProfile(projectSettings("personal"), orphanedProject)).toBe(
      true,
    );
  });

  it("hides nothing with a single profile", () => {
    const single = {
      ...projectSettings("personal"),
      accountProfiles: DEFAULT_SERVER_SETTINGS.accountProfiles.slice(0, 1),
    };
    expect(isProjectInActiveAccountProfile(single, workProject)).toBe(true);
    expect(newProjectAccountProfilePatch(single, sharedProject)).toBeUndefined();
  });

  it("files a new project under the active profile", () => {
    expect(newProjectAccountProfilePatch(projectSettings("work"), sharedProject)).toEqual({
      projectAccountProfileIds: { [sharedProject]: work },
    });
  });

  it("files a thread by its project, else by its own profile, else everywhere", () => {
    const thread = ThreadId.make("thread-1");
    const filed = {
      ...projectSettings("personal"),
      threadAccountProfileIds: { [thread]: work },
    };
    expect(isThreadInActiveAccountProfile(filed, { id: thread, projectId: sharedProject })).toBe(
      false,
    );
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, activeAccountProfileId: work },
        { id: thread, projectId: sharedProject },
      ),
    ).toBe(true);
    // The project's profile wins over the thread's own.
    expect(
      isThreadInActiveAccountProfile(
        { ...filed, threadAccountProfileIds: { [thread]: AccountProfileId.make("personal") } },
        { id: thread, projectId: workProject },
      ),
    ).toBe(false);
    expect(
      isThreadInActiveAccountProfile(filed, { id: ThreadId.make("other"), projectId: null }),
    ).toBe(true);
  });

  it("files a new thread only when its project does not place it", () => {
    const thread = ThreadId.make("thread-new");
    expect(
      newThreadAccountProfilePatch(projectSettings("work"), {
        id: thread,
        projectId: sharedProject,
      }),
    ).toEqual({ threadAccountProfileIds: { [thread]: work } });
    expect(
      newThreadAccountProfilePatch(projectSettings("work"), { id: thread, projectId: workProject }),
    ).toBeUndefined();
  });
});
