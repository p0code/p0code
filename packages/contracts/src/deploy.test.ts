import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DeployLinkResult,
  DeployOverview,
  DeployProviderDeployInput,
  DeployStartInput,
  DeployStartResult,
  isFinalDeploymentState,
} from "./deploy.ts";
import { PluginCapability } from "./plugins.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

/** Wire data arrives untyped, so each case decodes it as `unknown`. */
const decode =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (wire: unknown): S["Type"] =>
    Schema.decodeUnknownSync(schema)(wire);

describe("deploy contracts", () => {
  it("decodes a provider deploy input and refuses an unknown source kind", () => {
    expect(
      decode(DeployProviderDeployInput)({
        projectId: "prj_1",
        source: { kind: "git", branch: "main", env: { NODE_ENV: "production" } },
        environment: "production",
        envVars: { API_URL: "https://api.example.test" },
      }),
    ).toMatchObject({ projectId: "prj_1", source: { kind: "git", branch: "main" } });
    expect(() =>
      decode(DeployProviderDeployInput)({
        projectId: "prj_1",
        source: { kind: "ftp" },
        environment: "preview",
      }),
    ).toThrow();
    expect(() =>
      decode(DeployProviderDeployInput)({
        projectId: "prj_1",
        source: { kind: "git" },
        environment: "staging",
      }),
    ).toThrow();
  });

  it("decodes both link outcomes", () => {
    expect(decode(DeployLinkResult)({ _tag: "linked", accountLabel: "acme" })).toEqual({
      _tag: "linked",
      accountLabel: "acme",
    });
    expect(decode(DeployLinkResult)({ _tag: "pending", authorizeUrl: "https://x.test" })._tag).toBe(
      "pending",
    );
    expect(() => decode(DeployLinkResult)({ _tag: "linked", accountLabel: " " })).toThrow();
  });

  it("decodes start inputs and results, including an approval request", () => {
    expect(
      decode(DeployStartInput)({
        projectId: "project-1",
        environment: "preview",
        sourceKind: "git",
        threadId: "thread-1",
      }),
    ).toMatchObject({ threadId: "thread-1" });
    const held = decode(DeployStartResult)({
      _tag: "approval-required",
      approval: {
        id: "a1",
        projectId: "project-1",
        pluginId: "vercel",
        providerProjectName: "web",
        environment: "production",
        branch: null,
        threadId: "thread-1",
        requestedAt: "2026-11-27T00:00:00.000Z",
      },
    });
    expect(held._tag).toBe("approval-required");
  });

  it("has no token field anywhere in the overview", () => {
    const overview = decode(DeployOverview)({
      providers: [
        {
          pluginId: "vercel",
          label: "Vercel",
          icon: null,
          running: true,
          status: { state: "expired", accountLabel: "acme", message: null },
          token: "should-be-dropped",
        },
      ],
      mappings: {},
      deployments: [],
      approvals: [],
    });
    expect(JSON.stringify(overview)).not.toContain("should-be-dropped");
  });

  it("adds deploy:provider as a capability and deployProjects as a setting", () => {
    expect(decode(PluginCapability)("deploy:provider")).toBe("deploy:provider");
    expect(decode(ServerSettings)({}).deployProjects).toEqual({});
    expect(
      decode(ServerSettingsPatch)({ deployProjects: { "project-1": null } }).deployProjects,
    ).toEqual({ "project-1": null });
  });

  it("knows which deployment states are final", () => {
    expect(isFinalDeploymentState("ready")).toBe(true);
    expect(isFinalDeploymentState("building")).toBe(false);
  });
});
