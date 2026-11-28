import {
  AccountProfileId,
  type DeployOverview,
  type DeployCliStatus,
  type DeployCliLoginEvent,
  EnvironmentId,
  PluginId,
  type PluginInfo,
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

const VERCEL_PLUGIN: PluginInfo = {
  manifest: {
    id: PluginId.make("vercel"),
    name: "Vercel",
    description: "Deploy web apps to Vercel.",
    version: "2.1.0",
    unofficial: false,
    externalServices: ["api.vercel.com"],
    capabilities: ["deploy:provider", "network:outbound"],
    httpRoutes: [],
  },
  origin: "installed",
  enabled: true,
  state: "running",
  message: null,
};

const FLY_PLUGIN: PluginInfo = {
  manifest: {
    id: PluginId.make("fly-io"),
    name: "Fly.io",
    description: "Deploy containers to Fly.io.",
    version: "0.4.0",
    unofficial: true,
    externalServices: ["api.machines.dev"],
    capabilities: ["deploy:provider", "network:outbound"],
    httpRoutes: [],
  },
  origin: "installed",
  enabled: true,
  state: "running",
  message: null,
};

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

const EMPTY_OVERVIEW: DeployOverview = {
  activeProfileId: null,
  providers: [],
  accounts: [],
  mappings: {},
  deployments: [],
  approvals: [],
};

const mocks = vi.hoisted(() => ({
  overview: null as DeployOverview | null,
  cliStatus: null as DeployCliStatus | null,
  cliLogin: null as DeployCliLoginEvent | null,
  plugins: [] as ReadonlyArray<PluginInfo>,
  commandCalls: [] as Array<{ readonly name: string; readonly input: unknown }>,
  refreshCalls: [] as Array<string>,
  linkResponse: {
    _tag: "Success" as const,
    value: {
      accountId: "acc-new",
      result: {
        _tag: "linked" as const,
        accountLabel: "new-team",
      },
    },
  } as
    | {
        readonly _tag: "Success";
        readonly value: {
          readonly accountId: string;
          readonly result:
            | { readonly _tag: "linked"; readonly accountLabel: string }
            | { readonly _tag: "pending"; readonly authorizeUrl: string };
        };
      }
    | { readonly _tag: "Failure"; readonly cause: unknown },
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
      cliStatus: () => ({ __query: "cli-status" }),
      cliLogin: () => ({ __query: "cli-login" }),
      cliLoginPermissions: makeCommand("cli-login"),
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

vi.mock("../../state/server", async () => {
  const { Atom: ReactAtom } = await import("effect/reactivity");
  const allow = ReactAtom.make(true);
  return {
    serverEnvironment: {
      plugins: () => ({ __query: "plugins" }),
      pluginsSetEnabled: {
        __name: "pluginsSetEnabled",
        permissionAtom: () => allow,
      },
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
        refresh: () => mocks.refreshCalls.push("overview"),
      };
    }
    if (atom?.__query === "plugins") {
      return {
        data: { plugins: mocks.plugins },
        error: null,
        isPending: false,
        isSuccess: true,
        refresh: () => mocks.refreshCalls.push("plugins"),
      };
    }
    if (atom?.__query === "cli-status" || atom?.__query === "cli-login") {
      return {
        data: atom.__query === "cli-status" ? mocks.cliStatus : mocks.cliLogin,
        error: null,
        isPending: false,
        refresh: () => {},
      };
    }
    if (atom?.__query === "domains") {
      return { data: [], error: null, isPending: false, isSuccess: true, refresh: () => {} };
    }
    if (atom?.__query === "logs") {
      return {
        data: ["Building...", "Deployment ready"],
        error: null,
        isPending: false,
        isSuccess: true,
        refresh: () => {},
      };
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
      if (name === "link") return mocks.linkResponse;
      if (name === "rollback") {
        return { _tag: "Success" as const, value: { deploymentId: "dpl-prev" } };
      }
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

function setup(
  overview: DeployOverview = OVERVIEW,
  plugins: ReadonlyArray<PluginInfo> = [VERCEL_PLUGIN],
) {
  mocks.overview = overview;
  mocks.cliStatus = null;
  mocks.cliLogin = null;
  mocks.plugins = plugins;
  mocks.commandCalls = [];
  mocks.refreshCalls = [];
  mocks.linkResponse = {
    _tag: "Success",
    value: {
      accountId: "acc-new",
      result: {
        _tag: "linked",
        accountLabel: "new-team",
      },
    },
  };
}

describe("DeploySettingsPanel", () => {
  it("shows built-in catalog slots as unavailable and non-linkable when no backends exist", async () => {
    setup(EMPTY_OVERVIEW, []);
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    const listbox = page.getByRole("listbox", { name: "Deploy providers" });
    await expect.element(listbox).toBeVisible();
    await expect.element(listbox.getByRole("option", { name: "Vercel" })).toBeVisible();
    await expect.element(listbox.getByRole("option", { name: "Cloudflare" })).toBeVisible();
    await expect
      .element(listbox.getByRole("option", { name: "Own server (Docker)" }))
      .toBeVisible();

    // Unavailable built-ins keep a dead switch and offer no way to link.
    await expect
      .element(page.getByRole("switch", { name: "Vercel is not available yet" }).first())
      .toBeDisabled();
    await expect
      .element(page.getByText("Vercel is not available in this version yet and cannot be linked."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Add account" }).elements()).toHaveLength(0);

    // Own server stays unavailable: the unwired p0deploy stub is never presented as working.
    await userEvent.click(listbox.getByRole("option", { name: "Own server (Docker)" }));
    await expect
      .element(
        page.getByText(
          "Own server (Docker) is not available in this version yet and cannot be linked.",
        ),
      )
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Add deploy provider" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Built-in", { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("Plugin-provided", { exact: true })).toBeVisible();
    expect(dialog.getByRole("button", { name: "Link", exact: true }).elements()).toHaveLength(0);
    await expect.element(dialog.getByRole("link", { name: "Plugins" })).toBeVisible();
  });

  it("links a built-in the server backs without a plugin, with no plugin toggle", async () => {
    setup(
      {
        ...EMPTY_OVERVIEW,
        providers: [
          {
            pluginId: PluginId.make("cloudflare"),
            label: "Cloudflare",
            icon: "cloud",
            running: true,
          },
        ],
      },
      [],
    );
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await expect
      .element(page.getByRole("option", { name: "Cloudflare", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    expect(page.getByRole("switch", { name: /Cloudflare/ }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Add account" }));
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Link account" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "link",
      input: { pluginId: PluginId.make("cloudflare") },
    });
  });

  it("shows install guidance and a collapsed token fallback when Wrangler is missing", async () => {
    setup(
      {
        ...EMPTY_OVERVIEW,
        providers: [
          {
            pluginId: PluginId.make("cloudflare"),
            label: "Cloudflare",
            icon: null,
            running: true,
            cliAuth: true,
          },
        ],
      },
      [],
    );
    mocks.cliStatus = { state: "missing" };
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Add account" }));
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByText("Install wrangler on the deploy host, then check again."))
      .toBeVisible();
    await expect.element(dialog.getByLabelText("Cloudflare access token")).not.toBeVisible();
    await userEvent.click(dialog.getByText("Advanced: use an access token instead"));
    await userEvent.fill(dialog.getByLabelText("Cloudflare access token"), "test-token");
    await userEvent.click(dialog.getByRole("button", { name: "Link with access token" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "link",
      input: { pluginId: PluginId.make("cloudflare"), token: "test-token" },
    });
  });

  it("can start, cancel and finish Vercel browser sign-in", async () => {
    setup(
      {
        ...EMPTY_OVERVIEW,
        providers: [
          {
            pluginId: PluginId.make("vercel"),
            label: "Vercel",
            icon: null,
            running: true,
            cliAuth: true,
          },
        ],
      },
      [],
    );
    mocks.cliStatus = { state: "signed-out" };
    mocks.cliLogin = { state: "waiting" };
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Add account" }));
    const dialog = page.getByRole("dialog");
    const signIn = dialog.getByRole("button", { name: "Sign in with Vercel" });
    await userEvent.click(signIn);
    await expect
      .element(dialog.getByText("Complete sign-in in the browser on the deploy host."))
      .toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Cancel sign-in" }));
    await expect.element(signIn).toBeVisible();

    mocks.cliLogin = { state: "linked", accountId: "acc-new" };
    await userEvent.click(signIn);
    await expect.element(dialog).not.toBeInTheDocument();
    expect(mocks.refreshCalls).toContain("overview");
  });

  it("links an existing CLI session without manual account fields", async () => {
    setup(
      {
        ...EMPTY_OVERVIEW,
        providers: [
          {
            pluginId: PluginId.make("vercel"),
            label: "Vercel",
            icon: null,
            running: true,
            cliAuth: true,
          },
        ],
      },
      [],
    );
    mocks.cliStatus = { state: "signed-in", label: "Example Team", teamId: "team_example" };
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Add account" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Signed in as Example Team")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Link CLI account" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "link",
      input: { pluginId: PluginId.make("vercel"), auth: "cli" },
    });
  });

  it("keeps disabled and failed providers visible and labels the plugin toggle as affecting all accounts", async () => {
    const disabledPlugin: PluginInfo = {
      ...FLY_PLUGIN,
      enabled: false,
      state: "disabled",
    };
    const failedPlugin: PluginInfo = {
      manifest: {
        id: PluginId.make("railway"),
        name: "Railway",
        description: "Deploy services to Railway.",
        version: "0.9.1",
        unofficial: true,
        externalServices: ["backboard.railway.app"],
        capabilities: ["deploy:provider"],
        httpRoutes: [],
      },
      origin: "installed",
      enabled: true,
      state: "failed",
      message: "Railway CLI missing.",
    };
    setup(
      {
        ...EMPTY_OVERVIEW,
        providers: [
          { pluginId: PluginId.make("fly-io"), label: "Fly.io", icon: "cloud", running: false },
          { pluginId: PluginId.make("railway"), label: "Railway", icon: null, running: false },
        ],
      },
      [disabledPlugin, failedPlugin],
    );
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    const listbox = page.getByRole("listbox", { name: "Deploy providers" });
    await expect.element(listbox.getByRole("option", { name: "Fly.io" })).toBeVisible();
    await expect.element(listbox.getByRole("option", { name: "Railway" })).toBeVisible();
    await expect.element(page.getByText("v0.4.0").first()).toBeVisible();
    await expect.element(page.getByText("Failed · Railway CLI missing.")).toBeVisible();

    // Toggling the Fly.io switch clearly says it affects all its accounts and calls pluginsSetEnabled.
    const flyToggle = page
      .getByRole("switch", { name: "Enable Fly.io (affects all its accounts)" })
      .first();
    await expect.element(flyToggle).not.toBeChecked();
    await userEvent.click(flyToggle);
    expect(mocks.commandCalls).toContainEqual({
      name: "pluginsSetEnabled",
      input: { pluginId: PluginId.make("fly-io"), enabled: true },
    });
    expect(mocks.refreshCalls).toContain("overview");

    // Selecting Railway displays its failure detail.
    await userEvent.click(listbox.getByRole("option", { name: "Railway" }));
    await expect.element(page.getByText("Railway CLI missing.", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Turning Railway on or off affects all of its accounts."))
      .toBeVisible();
  });

  it("renders multi-account cards with warnings, rename, independent relink, unlink, and profile tags", async () => {
    setup();
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    const detail = page.getByRole("region", { name: "Vercel settings" });
    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(2);
    await expect.element(detail.getByText("Business-A", { exact: true })).toBeVisible();
    await expect.element(detail.getByText("Legacy", { exact: true })).toBeVisible();
    await expect.element(detail.getByText("Sign-in expired")).toBeVisible();
    await expect.element(page.getByText("Token lacks the domains scope.")).toBeVisible();
    await expect.element(page.getByText("v2.1.0").first()).toBeVisible();

    // Toggling Home profile on Business-A calls updateAccount with [work, home].
    const homeButtons = page.getByRole("button", { name: "Home" });
    await userEvent.click(homeButtons.first());
    expect(mocks.commandCalls).toContainEqual({
      name: "updateAccount",
      input: { accountId: "acc-biz", profileIds: [WORK, HOME] },
    });

    // Editing account display name commits on Enter.
    const nameInput = page.getByRole("textbox", { name: "Display name for Business-A" });
    await userEvent.clear(nameInput);
    await userEvent.fill(nameInput, "Business Primary");
    await userEvent.keyboard("{Enter}");
    expect(mocks.commandCalls).toContainEqual({
      name: "updateAccount",
      input: { accountId: "acc-biz", label: "Business Primary" },
    });

    // Relinking Legacy sends accountId and token.
    await userEvent.fill(page.getByLabelText("Legacy access token"), "tok_relink");
    await userEvent.click(page.getByRole("button", { name: "Relink" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "link",
      input: { pluginId: PluginId.make("vercel"), accountId: "acc-old", token: "tok_relink" },
    });

    // Unlinking Legacy calls unlink.
    await userEvent.click(page.getByRole("button", { name: "Unlink" }).nth(1));
    expect(mocks.commandCalls).toContainEqual({
      name: "unlink",
      input: { accountId: "acc-old" },
    });
  });

  it("supports selecting rows by click and keyboard across built-ins and plugins", async () => {
    const flyOverview: DeployOverview = {
      ...OVERVIEW,
      providers: [
        ...OVERVIEW.providers,
        { pluginId: PluginId.make("fly-io"), label: "Fly.io", icon: "cloud", running: true },
      ],
      accounts: [
        ...OVERVIEW.accounts,
        {
          id: "acc-fly",
          pluginId: PluginId.make("fly-io"),
          label: "Fly Prod",
          teamId: null,
          profileIds: [],
          createdAt: "2026-11-27T00:00:00.000Z",
          status: { state: "linked", accountLabel: "fly-org", message: null },
        },
      ],
    };
    setup(flyOverview, [VERCEL_PLUGIN, FLY_PLUGIN]);
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    const listbox = page.getByRole("listbox", { name: "Deploy providers" });
    const vercelOption = listbox.getByRole("option", { name: "Vercel", exact: true });
    const flyOption = listbox.getByRole("option", { name: "Fly.io", exact: true });
    const legacyOption = listbox.getByRole("option", { name: "Vercel account Legacy" });

    await expect.element(vercelOption).toHaveAttribute("aria-selected", "true");
    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(2);

    // An account row narrows the detail to that account.
    await userEvent.click(legacyOption);
    await expect.element(legacyOption).toHaveAttribute("aria-selected", "true");
    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(1);

    await userEvent.click(flyOption);
    await expect.element(flyOption).toHaveAttribute("aria-selected", "true");
    await expect
      .element(
        page
          .getByRole("region", { name: "Fly.io settings" })
          .getByText("Fly Prod", { exact: true }),
      )
      .toBeVisible();

    await userEvent.keyboard("{Home}");
    await expect.element(vercelOption).toHaveAttribute("aria-selected", "true");
  });

  it("shows active profile filtering banner and updates when profile changes", async () => {
    setup();
    await using screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await expect
      .element(page.getByText("Showing accounts in profile Work and untagged accounts."))
      .toBeVisible();
    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(2);

    // Switching to Home profile hides Work-only Business-A and keeps untagged Legacy.
    mocks.overview = {
      ...OVERVIEW,
      activeProfileId: HOME,
      accounts: [OVERVIEW.accounts[1]!],
    };
    await screen.rerender(<DeploySettingsPanel preselect={{}} />);

    await expect
      .element(page.getByText("Showing accounts in profile Home and untagged accounts."))
      .toBeVisible();
    expect(page.getByTestId("deploy-account-card").elements()).toHaveLength(1);
    expect(page.getByRole("option", { name: "Vercel account Business-A" }).elements()).toHaveLength(
      0,
    );
  });

  it("opens Add deploy provider dialog with built-ins first, plugins second, and completes link flow", async () => {
    const multiOverview: DeployOverview = {
      ...OVERVIEW,
      providers: [
        ...OVERVIEW.providers,
        { pluginId: PluginId.make("fly-io"), label: "Fly.io", icon: "cloud", running: true },
      ],
    };
    setup(multiOverview, [VERCEL_PLUGIN, FLY_PLUGIN]);
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Add deploy provider" }).first());
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Built-ins section precedes Plugins section in DOM order.
    const builtInsEl = dialog.getByTestId("add-deploy-provider-builtins").element();
    const pluginsEl = dialog.getByTestId("add-deploy-provider-plugins").element();
    expect(builtInsEl.compareDocumentPosition(pluginsEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // Choose Fly.io and link an account.
    await userEvent.click(
      dialog.getByTestId("add-deploy-provider-item-fly-io").getByRole("button", {
        name: "Link",
      }),
    );
    await expect.element(dialog.getByText("Link Fly.io account")).toBeVisible();

    await userEvent.fill(dialog.getByPlaceholder("Account name"), "Staging");
    await userEvent.fill(dialog.getByPlaceholder("Team ID (optional)"), "org_fly");
    await userEvent.fill(dialog.getByPlaceholder("Access token (optional)"), "fly_secret");
    await userEvent.click(dialog.getByRole("button", { name: "Link account" }));

    expect(mocks.commandCalls).toContainEqual({
      name: "link",
      input: {
        pluginId: PluginId.make("fly-io"),
        label: "Staging",
        teamId: "org_fly",
        token: "fly_secret",
      },
    });
  });

  it("stays usable at narrow dialog widths without hiding controls", async () => {
    setup();
    const container = document.createElement("div");
    container.style.width = "420px";
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      container,
      router: "/settings/deploy",
    });

    await expect.element(page.getByRole("listbox", { name: "Deploy providers" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Env vars" })).toBeVisible();
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

  it("preserves approval queue, deployment logs, and rollback workflows", async () => {
    setup({
      ...OVERVIEW,
      approvals: [
        {
          id: "appr-queue-1",
          projectId: PROJECT,
          pluginId: PluginId.make("vercel"),
          accountId: "acc-biz",
          targetName: "acme-web",
          environment: "production",
          branch: "main",
          directory: "/work/acme",
          threadId: THREAD,
          requestedAt: "2026-11-27T02:00:00.000Z",
        },
      ],
      deployments: [
        {
          pluginId: PluginId.make("vercel"),
          accountId: "acc-biz",
          deploymentId: "dpl-1",
          projectId: PROJECT,
          threadId: null,
          targetKind: "vercel-project",
          targetName: "acme-web",
          environment: "production",
          branch: "main",
          url: "https://acme.vercel.app",
          state: "ready",
          createdAt: "2026-11-27T01:00:00.000Z",
        },
      ],
    });
    await using _screen = await render(<DeploySettingsPanel preselect={{}} />, {
      router: "/settings/deploy",
    });

    await userEvent.click(page.getByRole("button", { name: "Approve and deploy" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "decideApproval",
      input: { approvalId: "appr-queue-1", approve: true },
    });

    await userEvent.click(page.getByRole("button", { name: "Roll back to this" }));
    expect(mocks.commandCalls).toContainEqual({
      name: "rollback",
      input: { projectId: PROJECT, deploymentId: "dpl-1" },
    });

    await userEvent.click(page.getByRole("button", { name: "Logs" }));
    await expect.element(page.getByText(/Deployment ready/)).toBeVisible();
  });

  it("parses KEY=value env lines cleanly", () => {
    expect(parseEnvLines("A=1\n# ignored\n\nB=two=2\nINVALID")).toEqual({ A: "1", B: "two=2" });
  });
});
