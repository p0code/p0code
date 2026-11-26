import {
  AccountProfileId,
  type DeployOverview,
  PluginId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deployAccountDisplayName,
  deployTargetFor,
  deployUrlHost,
  isDeployAccountReady,
  projectDeploySummary,
  threadDeploySummary,
} from "./deploy.ts";

const WORK = AccountProfileId.make("work");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const THREAD = ThreadId.make("thread-1");
const OTHER_THREAD = ThreadId.make("thread-2");

const overview: DeployOverview = {
  activeProfileId: WORK,
  providers: [
    { pluginId: PluginId.make("vercel"), label: "Vercel", icon: null, running: true },
    { pluginId: PluginId.make("cloudflare"), label: "Cloudflare", icon: null, running: false },
  ],
  accounts: [
    {
      id: "acc-biz",
      pluginId: PluginId.make("vercel"),
      label: "Business-A",
      teamId: "team_a",
      profileIds: [WORK],
      createdAt: "2026-11-27T00:00:00.000Z",
      status: { state: "linked", accountLabel: "acme-team", message: null },
    },
    {
      id: "acc-cf",
      pluginId: PluginId.make("cloudflare"),
      label: null,
      teamId: null,
      profileIds: [],
      createdAt: "2026-11-27T00:00:00.000Z",
      status: { state: "linked", accountLabel: "cf-personal", message: null },
    },
  ],
  mappings: {
    [PROJECT]: {
      projectId: PROJECT,
      accountId: "acc-biz",
      targetKind: "vercel-project",
      targetId: "prj_1",
      targetName: "acme-web",
      defaultEnvironment: "preview",
    },
  },
  deployments: [
    {
      pluginId: PluginId.make("vercel"),
      accountId: "acc-biz",
      deploymentId: "dpl_new",
      projectId: PROJECT,
      threadId: THREAD,
      targetKind: "vercel-project",
      targetName: "acme-web",
      environment: "preview",
      branch: "feat/deploy",
      url: "https://acme-web-preview.vercel.app/path",
      state: "ready",
      createdAt: "2026-11-27T02:00:00.000Z",
    },
    {
      pluginId: PluginId.make("vercel"),
      accountId: "acc-biz",
      deploymentId: "dpl_old",
      projectId: PROJECT,
      threadId: THREAD,
      targetKind: "vercel-project",
      targetName: "acme-web",
      environment: "preview",
      branch: "feat/deploy",
      url: "https://old.vercel.app",
      state: "ready",
      createdAt: "2026-11-27T01:00:00.000Z",
    },
  ],
  approvals: [],
};

describe("deploy state selectors", () => {
  it("resolves provider, named account, and readiness from the shared mapping", () => {
    const target = deployTargetFor(overview, PROJECT);
    expect(target).not.toBeNull();
    expect(target?.providerLabel).toBe("Vercel");
    expect(target?.accountName).toBe("Business-A");
    expect(isDeployAccountReady(target?.account ?? null, target?.provider ?? null)).toBe(true);
    expect(deployTargetFor(overview, OTHER_PROJECT)).toBeNull();
    expect(deployAccountDisplayName(overview.accounts[1]!)).toBe("cf-personal");
    expect(isDeployAccountReady(overview.accounts[1]!, overview.providers[1]!)).toBe(false);
  });

  it("derives both the sidebar project summary and thread chip from the same mapping", () => {
    const projectSummary = projectDeploySummary(overview, PROJECT);
    expect(projectSummary?.providerLabel).toBe("Vercel");
    expect(projectSummary?.accountName).toBe("Business-A");
    expect(projectSummary?.latestDeployment?.deploymentId).toBe("dpl_new");
    expect(deployUrlHost(projectSummary?.latestDeployment?.url)).toBe(
      "acme-web-preview.vercel.app",
    );

    const threadSummary = threadDeploySummary(overview, PROJECT, THREAD);
    expect(threadSummary?.mapping).toBe(projectSummary?.mapping);
    expect(threadSummary?.deployment.deploymentId).toBe("dpl_new");
    expect(threadDeploySummary(overview, PROJECT, OTHER_THREAD)).toBeNull();

    // When the project mapping is absent (e.g. hidden by profile switch), neither shows.
    const hiddenOverview: DeployOverview = { ...overview, mappings: {} };
    expect(projectDeploySummary(hiddenOverview, PROJECT)).toBeNull();
    expect(threadDeploySummary(hiddenOverview, PROJECT, THREAD)).toBeNull();
  });
});
