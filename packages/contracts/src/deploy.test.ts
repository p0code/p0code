import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AccountProfileId } from "./accountProfile.ts";
import {
  DeployLinkResult,
  DeployOverview,
  DeployProjectMapping,
  DeployProviderDeployInput,
  DeployProviderSetEnvInput,
  DeployProviderStatus,
  DeployStartInput,
  DeployStartResult,
  isDeployAccountInProfile,
  isFinalDeploymentState,
} from "./deploy.ts";
import { PluginCapability } from "./plugins.ts";
import { ServerSettings } from "./settings.ts";

/** Wire data arrives untyped, so each case decodes it as `unknown`. */
const decode =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (wire: unknown): S["Type"] =>
    Schema.decodeUnknownSync(schema)(wire);

const account = { accountId: "acc-1", teamId: "team_42" };

describe("deploy contracts", () => {
  it("decodes a provider deploy input with its account, target and folders", () => {
    expect(
      decode(DeployProviderDeployInput)({
        account,
        target: { kind: "worker", id: "api" },
        source: {
          kind: "local-build",
          projectRoot: "/work/acme",
          directory: "/work/acme/apps/api",
          env: { NODE_ENV: "production" },
        },
        environment: "production",
      }),
    ).toMatchObject({
      account,
      target: { kind: "worker" },
      source: { directory: "/work/acme/apps/api" },
    });
    for (const wrong of [
      {
        account,
        target: { kind: "worker", id: "api" },
        source: { kind: "ftp" },
        environment: "preview",
      },
      {
        account,
        target: { kind: "lambda", id: "api" },
        source: { kind: "git" },
        environment: "preview",
      },
      { target: { kind: "pages", id: "web" }, source: { kind: "git" }, environment: "preview" },
      {
        account,
        target: { kind: "pages", id: "web" },
        source: { kind: "git" },
        environment: "staging",
      },
    ]) {
      expect(() => decode(DeployProviderDeployInput)(wrong)).toThrow();
    }
  });

  it("decodes both link outcomes, with a team id and warnings", () => {
    expect(
      decode(DeployLinkResult)({
        _tag: "linked",
        accountLabel: "acme",
        teamId: "team_42",
        warnings: [{ code: "scope", message: "No DNS scope; domains stay read-only." }],
      }),
    ).toMatchObject({ teamId: "team_42", warnings: [{ code: "scope" }] });
    expect(decode(DeployLinkResult)({ _tag: "pending", authorizeUrl: "https://x.test" })._tag).toBe(
      "pending",
    );
    expect(() => decode(DeployLinkResult)({ _tag: "linked", accountLabel: " " })).toThrow();
    expect(
      decode(DeployProviderStatus)({ state: "linked", accountLabel: "a", message: null }).warnings,
    ).toBeUndefined();
  });

  it("makes the mapping a typed object and the env call name its environment", () => {
    const mapping = decode(DeployProjectMapping)({
      projectId: "project-1",
      accountId: "acc-1",
      targetKind: "pages",
      targetId: "web",
      targetName: "acme-web",
      defaultEnvironment: "preview",
      directory: "apps/web",
    });
    expect(mapping.targetKind).toBe("pages");
    expect(() => decode(DeployProjectMapping)({ ...mapping, targetKind: "prj" })).toThrow();
    expect(
      decode(DeployProviderSetEnvInput)({
        account,
        target: { kind: "vercel-project", id: "prj_1" },
        environment: "development",
        vars: { A: "1" },
        secret: true,
        remove: ["OLD"],
      }),
    ).toMatchObject({ environment: "development", secret: true, remove: ["OLD"] });
    expect(() =>
      decode(DeployProviderSetEnvInput)({
        account,
        target: { kind: "pages", id: "web" },
        environment: "staging",
        vars: {},
        secret: false,
        remove: [],
      }),
    ).toThrow();
  });

  it("requires a deploy to name its account, and decodes an approval request", () => {
    expect(() => decode(DeployStartInput)({ projectId: "project-1", sourceKind: "git" })).toThrow();
    expect(
      decode(DeployStartInput)({
        projectId: "project-1",
        accountId: "acc-1",
        sourceKind: "local-build",
        directory: "apps/api",
        threadId: "thread-1",
      }),
    ).toMatchObject({ accountId: "acc-1", directory: "apps/api" });
    const held = decode(DeployStartResult)({
      _tag: "approval-required",
      approval: {
        id: "a1",
        projectId: "project-1",
        pluginId: "vercel",
        accountId: "acc-1",
        targetName: "web",
        environment: "production",
        branch: null,
        directory: "/work/acme",
        threadId: "thread-1",
        requestedAt: "2026-11-27T00:00:00.000Z",
      },
    });
    expect(held._tag).toBe("approval-required");
  });

  it("has no token field anywhere in the overview", () => {
    const overview = decode(DeployOverview)({
      activeProfileId: null,
      providers: [
        { pluginId: "vercel", label: "Vercel", icon: null, running: true, token: "drop-me" },
      ],
      accounts: [
        {
          id: "acc-1",
          pluginId: "vercel",
          label: "Personal",
          teamId: null,
          profileIds: [],
          createdAt: "2026-11-27T00:00:00.000Z",
          token: "drop-me-too",
          status: { state: "expired", accountLabel: "acme", message: null },
        },
      ],
      mappings: {},
      deployments: [],
      approvals: [],
    });
    expect(JSON.stringify(overview)).not.toContain("drop-me");
  });

  it("shows untagged accounts in every profile and tagged ones only in theirs", () => {
    const work = AccountProfileId.make("work");
    const home = AccountProfileId.make("home");
    expect(isDeployAccountInProfile({ profileIds: [] }, work)).toBe(true);
    expect(isDeployAccountInProfile({ profileIds: [home] }, null)).toBe(true);
    expect(isDeployAccountInProfile({ profileIds: [home] }, work)).toBe(false);
    expect(isDeployAccountInProfile({ profileIds: [home, work] }, work)).toBe(true);
  });

  it("adds deploy:provider as a capability and keeps no mapping in settings", () => {
    expect(decode(PluginCapability)("deploy:provider")).toBe("deploy:provider");
    // A settings file written by deploy-core still decodes; the old field is ignored.
    expect(
      Object.hasOwn(
        decode(ServerSettings)({ deployProjects: { "project-1": {} } }),
        "deployProjects",
      ),
    ).toBe(false);
  });

  it("knows which deployment states are final", () => {
    expect(isFinalDeploymentState("ready")).toBe(true);
    expect(isFinalDeploymentState("building")).toBe(false);
  });
});
