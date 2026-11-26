import {
  AccountProfileId,
  type DeployOverview,
  EnvironmentId,
  PluginId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarThreadDeployChip, useSidebarThreadDeploySummary } from "./SidebarDeployIndicators";
import { SidebarProjectFolderHeader } from "./SidebarProjectFolderHeader";

const mocks = vi.hoisted(() => ({
  overview: null as DeployOverview | null,
}));

vi.mock("../../state/deploy", () => ({
  useDeployOverview: () => mocks.overview,
}));

const ENV = EnvironmentId.make("local");
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const OTHER_THREAD = ThreadId.make("thread-2");
const WORK = AccountProfileId.make("work");

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
      status: { state: "linked", accountLabel: "acme", message: null },
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
  deployments: [
    {
      pluginId: PluginId.make("vercel"),
      accountId: "acc-biz",
      deploymentId: "dpl_42",
      projectId: PROJECT,
      threadId: THREAD,
      targetKind: "vercel-project",
      targetName: "acme-web",
      environment: "production",
      branch: "main",
      url: "https://acme.example.com",
      state: "ready",
      createdAt: "2026-11-27T02:00:00.000Z",
    },
  ],
  approvals: [],
};

const GROUP: SidebarProjectSnapshot = {
  id: PROJECT,
  environmentId: ENV,
  title: "Acme Web",
  workspaceRoot: "/work/acme",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
  projectKey: "local:project-1",
  displayName: "Acme Web",
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [],
  memberProjectRefs: [{ environmentId: ENV, projectId: PROJECT }],
  remoteEnvironmentLabels: [],
  pinned: false,
  archived: false,
};

function ThreadChipHarness({ threadId }: { readonly threadId: ThreadId }) {
  const summary = useSidebarThreadDeploySummary(ENV, PROJECT, threadId);
  return summary ? <SidebarThreadDeployChip environmentId={ENV} summary={summary} /> : null;
}

describe("sidebar deploy project row and thread chip", () => {
  it("shows provider, account, status and deployment URL on the project row and a matching thread chip", async () => {
    mocks.overview = OVERVIEW;
    await using _screen = await render(
      <ul>
        <SidebarProjectFolderHeader
          group={GROUP}
          collapsed={false}
          hiddenThreads={[]}
          onToggle={() => {}}
          onNewThread={() => {}}
          onContextMenu={() => {}}
        />
        <li>
          <ThreadChipHarness threadId={THREAD} />
          <ThreadChipHarness threadId={OTHER_THREAD} />
        </li>
      </ul>,
      { router: "/" },
    );

    const projectDeploy = page.getByTestId("sidebar-project-deploy");
    await expect.element(projectDeploy).toBeVisible();
    await expect.element(projectDeploy.getByText("Vercel · Business-A")).toBeVisible();
    await expect.element(projectDeploy.getByText("Ready")).toBeVisible();
    const link = projectDeploy.getByRole("link", { name: "acme.example.com" });
    await expect.element(link).toHaveAttribute("href", "https://acme.example.com");

    const chip = page.getByTestId("sidebar-thread-deploy-chip");
    expect(chip.elements()).toHaveLength(1);
    await expect.element(chip).toHaveAttribute("href", "https://acme.example.com");
    await expect
      .element(chip)
      .toHaveAttribute("aria-label", "Deployment on Vercel (Business-A): Ready, acme.example.com");
  });

  it("hides both the project row summary and thread chip when the mapping is outside the active profile", async () => {
    mocks.overview = { ...OVERVIEW, accounts: [], mappings: {}, deployments: [] };
    await using _screen = await render(
      <ul>
        <SidebarProjectFolderHeader
          group={GROUP}
          collapsed={false}
          hiddenThreads={[]}
          onToggle={() => {}}
          onNewThread={() => {}}
          onContextMenu={() => {}}
        />
        <li>
          <ThreadChipHarness threadId={THREAD} />
        </li>
      </ul>,
      { router: "/" },
    );

    expect(page.getByTestId("sidebar-project-deploy").elements()).toHaveLength(0);
    expect(page.getByTestId("sidebar-thread-deploy-chip").elements()).toHaveLength(0);
  });
});
