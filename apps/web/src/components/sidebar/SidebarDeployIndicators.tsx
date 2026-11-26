import {
  deployUrlHost,
  projectDeploySummary,
  threadDeploySummary,
  type ThreadDeploySummary,
} from "@t3tools/client-runtime/state/deploy";
import type { DeploymentState, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ExternalLinkIcon, RocketIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useDeployOverview } from "../../state/deploy";
import { ThreadLinkBadge } from "../ThreadStatusIndicators";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DEPLOY_STATE_DOT: Record<DeploymentState, string> = {
  queued: "bg-muted-foreground",
  building: "bg-info",
  ready: "bg-success",
  error: "bg-destructive",
  canceled: "bg-muted-foreground",
};

const DEPLOY_STATE_TONE: Record<DeploymentState, string> = {
  queued: "text-muted-foreground",
  building: "text-info",
  ready: "text-success",
  error: "text-destructive",
  canceled: "text-muted-foreground",
};

function deploymentStateLabel(gt: ReturnType<typeof useGT>, state: DeploymentState): string {
  switch (state) {
    case "queued":
      return gt("Queued");
    case "building":
      return gt("Building");
    case "ready":
      return gt("Ready", { $context: "deployment state" });
    case "error":
      return gt("Failed", { $context: "deployment state" });
    case "canceled":
      return gt("Canceled");
  }
}

/**
 * Compact deploy metadata under a sidebar project row: provider + account + latest deployment
 * status and clickable URL, reading the same profile-scoped mapping as Settings → Deploy and the
 * thread chip.
 */
export function SidebarProjectDeployRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const overview = useDeployOverview(props.environmentId);
  const summary = projectDeploySummary(overview, props.projectId);
  if (summary === null) return null;

  const latest = summary.latestDeployment;
  const host = deployUrlHost(latest?.url);
  const statusText = latest ? deploymentStateLabel(gt, latest.state) : null;

  return (
    <div
      data-testid="sidebar-project-deploy"
      className="flex min-w-0 items-center gap-1.5 pb-1 ps-9 pe-2.5 text-2xs text-sidebar-muted-foreground"
    >
      <span className="truncate">
        {summary.providerLabel} · {summary.accountName}
      </span>
      {latest ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", DEPLOY_STATE_DOT[latest.state])}
          />
          <span className={cn("shrink-0", DEPLOY_STATE_TONE[latest.state])}>{statusText}</span>
        </span>
      ) : null}
      {latest?.url && host ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={latest.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                className="ml-auto inline-flex min-w-0 items-center gap-0.5 truncate font-mono text-sidebar-foreground/80 hover:text-sidebar-foreground hover:underline"
              />
            }
          >
            <span className="truncate">{host}</span>
            <ExternalLinkIcon aria-hidden className="size-2.5 shrink-0" />
          </TooltipTrigger>
          <TooltipPopup>{latest.url}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="ml-auto truncate font-mono opacity-75">{summary.mapping.targetName}</span>
      )}
    </div>
  );
}

/** Resolves the deployment a thread shipped from the same project mapping as the project row. */
export function useSidebarThreadDeploySummary(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): ThreadDeploySummary | null {
  const overview = useDeployOverview(environmentId);
  return threadDeploySummary(overview, projectId, threadId);
}

/** Chip on a sidebar thread row for the deployment that thread shipped. */
export function SidebarThreadDeployChip(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: ThreadDeploySummary;
}) {
  const gt = useGT();
  const router = useRouter();
  const { summary } = props;
  const { deployment } = summary;
  const stateLabel = deploymentStateLabel(gt, deployment.state);
  const host = deployUrlHost(deployment.url);
  const ariaLabel = host
    ? gt("Deployment on {provider} ({account}): {state}, {host}", {
        provider: summary.providerLabel,
        account: summary.accountName,
        state: stateLabel,
        host,
      })
    : gt("Deployment on {provider} ({account}): {state}", {
        provider: summary.providerLabel,
        account: summary.accountName,
        state: stateLabel,
      });

  const control = deployment.url ? (
    <InlineButton
      data-testid="sidebar-thread-deploy-chip"
      render={<a href={deployment.url} target="_blank" rel="noopener noreferrer" />}
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    />
  ) : (
    <InlineButton
      data-testid="sidebar-thread-deploy-chip"
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void router.navigate({
          to: "/settings/deploy",
          search: { environmentId: props.environmentId, projectId: deployment.projectId },
        });
      }}
    />
  );

  return (
    <ThreadLinkBadge
      control={control}
      Icon={RocketIcon}
      toneClassName={DEPLOY_STATE_TONE[deployment.state]}
      text={stateLabel}
    >
      <div className="space-y-1 p-1 text-xs">
        <div className="font-medium text-foreground">
          {summary.providerLabel} · {summary.accountName}
        </div>
        <div className="text-muted-foreground">
          {summary.mapping.targetName} · {deployment.environment} · {stateLabel}
        </div>
        {deployment.url ? (
          <a
            href={deployment.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 font-mono text-foreground underline"
          >
            {deployment.url}
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
          </a>
        ) : null}
      </div>
    </ThreadLinkBadge>
  );
}
