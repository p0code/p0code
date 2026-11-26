import {
  type DeployAccountSummary,
  type DeployOverview,
  type DeployProjectMapping,
  type DeployProviderSummary,
  type DeployRecord,
  type EnvironmentId,
  isFinalDeploymentState,
  type ProjectId,
  type ThreadId,
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
 * Settings → Deploy per environment. One overview query carries providers, accounts in the active
 * profile, project mappings, recent deploys and pending approvals; every write refreshes it.
 */
export function createDeployEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
  options?: {
    /** Refreshes the overview when a profile switch changes what accounts are visible. */
    readonly overviewRefreshTrigger?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<unknown> | undefined;
  },
) {
  const commandScheduler = createAtomCommandScheduler();
  const overviewRefreshTrigger = options?.overviewRefreshTrigger;
  const overview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:deploy:overview",
    tag: WS_METHODS.deployOverview,
    refreshTrigger: ({ environmentId }) => overviewRefreshTrigger?.(environmentId),
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
    updateAccount: command("update-account", WS_METHODS.deployUpdateAccount),
    mapProject: command("map-project", WS_METHODS.deployMapProject),
    start: command("start", WS_METHODS.deployStart),
    decideApproval: command("decide-approval", WS_METHODS.deployDecideApproval),
    rollback: command("rollback", WS_METHODS.deployRollback),
    setEnv: command("set-env", WS_METHODS.deploySetEnv),
  };
}

/** What to call a linked account in the UI: the person's name, then the provider's label. */
export const deployAccountDisplayName = (
  account: Pick<DeployAccountSummary, "id" | "label" | "status">,
): string => account.label ?? account.status.accountLabel ?? account.id;

/** Whether an account can take a deploy now: its provider plugin is on and the account is linked. */
export const isDeployAccountReady = (
  account: DeployAccountSummary | null,
  provider: DeployProviderSummary | null,
): boolean =>
  provider !== null && provider.running && account !== null && account.status.state === "linked";

export interface ResolvedDeployTarget {
  readonly mapping: DeployProjectMapping;
  readonly account: DeployAccountSummary | null;
  readonly provider: DeployProviderSummary | null;
  readonly accountName: string;
  readonly providerLabel: string;
}

/**
 * The account and provider a project deploys to, reading the profile-scoped mapping once so
 * Settings → Deploy, sidebar project rows and thread chips always agree.
 */
export function deployTargetFor(
  overview: DeployOverview | null,
  projectId: ProjectId,
): ResolvedDeployTarget | null {
  const mapping = overview?.mappings[projectId];
  if (mapping === undefined || overview === null) return null;
  const account = overview.accounts.find((candidate) => candidate.id === mapping.accountId) ?? null;
  const provider =
    account === null
      ? null
      : (overview.providers.find((candidate) => candidate.pluginId === account.pluginId) ?? null);
  return {
    mapping,
    account,
    provider,
    accountName: account === null ? mapping.accountId : deployAccountDisplayName(account),
    providerLabel: provider?.label ?? account?.pluginId ?? mapping.accountId,
  };
}

export interface ProjectDeploySummary extends ResolvedDeployTarget {
  readonly latestDeployment: DeployRecord | null;
}

/** Mapping + newest deployment for a sidebar project row. */
export function projectDeploySummary(
  overview: DeployOverview | null,
  projectId: ProjectId,
): ProjectDeploySummary | null {
  const target = deployTargetFor(overview, projectId);
  if (target === null || overview === null) return null;
  const latestDeployment =
    overview.deployments.find(
      (record) => record.projectId === projectId && record.accountId === target.mapping.accountId,
    ) ?? null;
  return { ...target, latestDeployment };
}

export interface ThreadDeploySummary extends ResolvedDeployTarget {
  readonly deployment: DeployRecord;
}

/** The deployment a thread shipped, reading the same project mapping as the project row. */
export function threadDeploySummary(
  overview: DeployOverview | null,
  projectId: ProjectId,
  threadId: ThreadId,
): ThreadDeploySummary | null {
  const target = deployTargetFor(overview, projectId);
  if (target === null || overview === null) return null;
  const deployment =
    overview.deployments.find(
      (record) =>
        record.threadId === threadId &&
        record.projectId === projectId &&
        record.accountId === target.mapping.accountId,
    ) ?? null;
  return deployment === null ? null : { ...target, deployment };
}

/** Compact host for a deployment URL in a sidebar row or chip. */
export function deployUrlHost(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}
