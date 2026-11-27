import {
  AccountProfileId,
  type DeployOverview,
  EnvironmentId,
  PluginId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { DeploySettingsPanel, parseEnvLines } from "./DeploySettings";

const ENV = EnvironmentId.make("local");
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-ask");
const WORK = AccountProfileId.make("work");
const HOME = AccountProfileId.make("home");

const OVERVIEW: DeployOverview = {
  activeProfileId: WORK,
  providers: [{ pluginId: PluginId.make("vercel"), label: "Vercel", icon: null, running: true }],
  accounts: [
    {
      id: "acc-biz",
      pluginId: PluginId.make("vercel"),
      label: "Business-A",
      teamId: "team_a",
      profileIds: [WORK],
      createdAt: "2026-11-27T00:00:00.000Z",
      status: {
        state: "linked",
        accountLabel: "acme-team",
        message: null,
        warnings: [{ code: "scope", message: "Token lacks the domains scope." }],
      },
    },
    {
      id: "acc-old",
      pluginId: PluginId.make("vercel"),
      label: "Legacy",
      teamId: null,
      profileIds: [],
      createdAt: "2026-11-27T00:00:00.000Z",
      status: { state: "expired", accountLabel: "old-user", message: "Sign in again." },
    },
  ],
  mappings: {
    [PROJECT]: {
      projectId: PROJECT,
      accountId: "acc-biz",
      targetKind: "vercel-project",
      targetId: "prj_1",
      targetName: "acme-web",
      defaultEnvironment: "production",
    },
  },
  deployments: [],
  approvals: [],
};

const mocks = vi.hoisted(() => ({
  overview: null as DeployOverview | null,
  commandCalls: [] as Array<{ readonly name: string; readonly input: unknown }>,
  startResponse: {
    _tag: "Success" as const,
    value: {
      _tag: "approval-required" as const,
      approval: {
        id: "appr-1",
        projectId: "project-1",
        pluginId: "vercel",
        accountId: "acc-biz",
        targetName: "acme-web",
        environment: "production",
        branch: "feat/v2",
        directory: "/work/acme",
        threadId: "thread-ask",
        requestedAt: "2026-11-27T02:00:00.000Z",
      },
    },
  },
}));

vi.mock("../../state/deploy", async () => {
  const { Atom: ReactAtom } = await import("effect/reactivity");
  const allow = ReactAtom.make(true);
  const makeCommand = (name: string) => ({
    __name: name,
    permissionAtom: () => allow,
  });
  return {
    deployEnvironment: {
      overview: () => ({ __query: "overview" }),
      providerProjects: () => ({ __query: "providerProjects" }),
      deploymentStatus: () => ({ __query: "deploymentStatus" }),
      domains: () => ({ __query: "domains" }),
      logs: () => ({ __query: "logs" }),
      link: makeCommand("link"),
      unlink: makeCommand("unlink"),
      updateAccount: makeCommand("updateAccount"),
      mapProject: makeCommand("mapProject"),
      start: makeCommand("start"),
      decideApproval: makeCommand("decideApproval"),
      rollback: makeCommand("rollback"),
      setEnv: makeCommand("setEnv"),
    },
  };
});

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { readonly __query?: string } | null) => {
    if (atom?.__query === "overview") {
      return {
        data: mocks.overview,
        error: null,
        isPending: false,
        isSuccess: true,
        refresh: () => {},
      };
    }
    if (atom?.__query === "domains") {
      return { data: [], error: null, isPending: false, isSuccess: true, refresh: () => {} };
    }
    return { data: [], error: null, isPending: false, isSuccess: true, refresh: () => {} };
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (cmd: { readonly __name?: string }) => async (arg: { readonly input: unknown }) => {
      const name = cmd.__name ?? "unknown";
      mocks.commandCalls.push({ name, input: arg.input });
      if (name === "start") return mocks.startResponse;
      return { _tag: "Success" as const, value: undefined };
    },
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: {
      environmentId: ENV,
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { plugins: true } } },
    },
  }),
  useOptionalSettingsScope: () => null,
}));

vi.mock("../../state/entities", () => ({
  useProfileProjects: <T,>(projects: ReadonlyArray<T>) => projects,
  useProjects: () => [
    {
      id: PROJECT,
      environmentId: ENV,
      title: "Acme Web",
      workspaceRoot: "/work/acme",
      archivedAt: null,
    },
  ],
  useServerConfigs: () => new Map(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    select: (settings: {
      accountProfiles: ReadonlyArray<{ id: AccountProfileId; name: string }>;
    }) => unknown,
  ) =>
    select({
      accountProfiles: [
        { id: WORK, name: "Work" },
        { id: HOME, name: "Home" },
      ],
    }),
  usePrimarySettingsAvailable: () => true,
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "",
}));

function setup(overview: DeployOverview = OVERVIEW) {
  mocks.overview = overview;
  mocks.commandCalls = [];
}

describe("DeploySettingsPanel", () => {
  it("renders multi-account cards with warnings, independent relink, and profile tags", async () => {
    setup();
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(2);
    await expect.element(page.getByText("Business-A", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Legacy", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Sign-in expired")).toBeVisible();
    await expect.element(page.getByText("Token lacks the domains scope.")).toBeVisible();

    // Toggling Home profile on Business-A calls updateAccount with [work, home].
    const homeButtons = page.getByRole("button", { name: "Home" });
    await userEvent.click(homeButtons.first());
    expect(mocks.commandCalls).toContainEqual({
      name: "updateAccount",
      input: { accountId: "acc-biz", profileIds: [WORK, HOME] },
    });
  });

  it("sends setEnv with environment, secret flag, vars and removals", async () => {
    setup();
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Env vars" }));
    await userEvent.fill(
      page.getByPlaceholder("API_URL=https://api.example.com"),
      "API_URL=https://prod.example.com\n# comment\nFLAG=1",
    );
    await userEvent.fill(page.getByPlaceholder("OLD_KEY, LEGACY_TOKEN"), "OLD_KEY");
    await userEvent.click(page.getByRole("button", { name: "Save variables" }));

    expect(mocks.commandCalls).toContainEqual({
      name: "setEnv",
      input: {
        projectId: PROJECT,
        environment: "production",
        vars: { API_URL: "https://prod.example.com", FLAG: "1" },
        secret: true,
        remove: ["OLD_KEY"],
      },
    });
  });

  it("passes accountId on deploy and shows approval gating for non-full-access threads", async () => {
    setup();
    await using _screen = await render(
      <DeploySettingsPanel
        preselect={{ projectId: PROJECT, branch: "feat/v2", threadId: THREAD }}
      />,
      { router: "/settings/deploy" },
    );

    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Deploy" }));

    expect(mocks.commandCalls).toContainEqual({
      name: "start",
      input: {
        projectId: PROJECT,
        accountId: "acc-biz",
        environment: "production",
        sourceKind: "git",
        branch: "feat/v2",
        threadId: THREAD,
      },
    });
    await expect.element(dialog.getByRole("button", { name: "Approve and deploy" })).toBeVisible();
  });

  it("parses KEY=value env lines cleanly", () => {
    expect(parseEnvLines("A=1\n# ignored\n\nB=two=2\nINVALID")).toEqual({ A: "1", B: "two=2" });
  });
});
