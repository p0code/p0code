import {
  type DeployOverview,
  type DeployProjectMapping,
  type DeployProviderSummary,
  isFinalDeploymentState,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";

/** Lines kept in a logs drawer; older ones scroll away. */
const MAX_LOG_LINES = 2_000;

/**
 * Settings → Deploy per environment. One overview query carries providers, project mappings,
 * recent deploys and pending approvals; every write refreshes it.
 */
export function createDeployEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const overview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:deploy:overview",
    tag: WS_METHODS.deployOverview,
  });
  const refreshOverview = {
    onSettled: (
      target: { readonly environmentId: Parameters<typeof overview>[0]["environmentId"] },
      registry: { readonly refresh: (atom: Atom.Atom<unknown>) => void },
    ) =>
      Effect.sync(() =>
        registry.refresh(overview({ environmentId: target.environmentId, input: {} })),
      ),
  };
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const command = <TTag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    label: string,
    tag: TTag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:deploy:${label}`,
      tag,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      ...refreshOverview,
    });
  return {
    overview,
    providerProjects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:deploy:provider-projects",
      tag: WS_METHODS.deployListProjects,
    }),
    deploymentStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:deploy:status",
      tag: WS_METHODS.deployStatus,
      refreshIntervalMs: 5_000,
      isFinal: (status) => isFinalDeploymentState(status.state),
    }),
    domains: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:deploy:domains",
      tag: WS_METHODS.deployDomains,
    }),
    /** The log so far, growing as the provider sends lines. */
    logs: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:deploy:logs",
      tag: WS_METHODS.deployLogs,
      transform: (lines) =>
        lines.pipe(
          Stream.scan(
            (): Array<string> => [],
            (kept: Array<string>, line: string) =>
              kept.length < MAX_LOG_LINES ? [...kept, line] : [...kept.slice(1), line],
          ),
        ),
    }),
    link: command("link", WS_METHODS.deployLink),
    unlink: command("unlink", WS_METHODS.deployUnlink),
    mapProject: command("map-project", WS_METHODS.deployMapProject),
    start: command("start", WS_METHODS.deployStart),
    decideApproval: command("decide-approval", WS_METHODS.deployDecideApproval),
    rollback: command("rollback", WS_METHODS.deployRollback),
    setEnv: command("set-env", WS_METHODS.deploySetEnv),
  };
}

/** The provider a project deploys to, when it is mapped to one this server still lists. */
export function deployTargetFor(
  overview: DeployOverview | null,
  projectId: ProjectId,
): {
  readonly mapping: DeployProjectMapping;
  readonly provider: DeployProviderSummary | null;
} | null {
  const mapping = overview?.mappings[projectId];
  if (mapping === undefined) return null;
  return {
    mapping,
    provider:
      overview?.providers.find((provider) => provider.pluginId === mapping.pluginId) ?? null,
  };
}

/** Whether a provider can take a deploy now: running and signed in. */
export const isDeployProviderReady = (provider: DeployProviderSummary | null): boolean =>
  provider !== null && provider.running && provider.status.state === "linked";
