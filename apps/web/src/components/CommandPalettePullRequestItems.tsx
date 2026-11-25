import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT, useMessages } from "gt-react";
import { SquarePenIcon } from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import {
  pullRequestStartAgentDisabledReason,
  readPullRequestDetailSnapshot,
  resolvePullRequestReferenceHost,
  resolvePullRequestRowCheckoutTarget,
  type PullRequestRowCheckoutEnvironment,
  type PullRequestRowCheckoutProject,
} from "./pullRequest/pullRequestDetail.logic";
import { executePullRequestHandoff } from "./pullRequest/usePullRequestActions";

export function useCommandPalettePullRequestStartAgentItem({
  referenceThreadRef,
  openPanelPullRequestUrl,
  projects,
  environments,
}: {
  readonly referenceThreadRef: ScopedThreadRef | null;
  readonly openPanelPullRequestUrl: string | null | undefined;
  readonly projects: ReadonlyArray<PullRequestRowCheckoutProject>;
  readonly environments: ReadonlyArray<PullRequestRowCheckoutEnvironment>;
}): CommandPaletteActionItem | null {
  const gt = useGT();
  const resolve = useMessages();
  const [pending, setPending] = useState(false);
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, referenceThreadRef),
  );
  const prSurface = surface?.kind === "pull-request" && openPanelPullRequestUrl ? surface : null;
  const surfaceEnvironmentId = prSurface
    ? ((prSurface.environmentId
        ? EnvironmentId.make(prSurface.environmentId)
        : referenceThreadRef?.environmentId) ?? null)
    : null;
  const surfaceProjectId = prSurface ? ProjectId.make(prSurface.projectId) : null;
  const target =
    prSurface && surfaceEnvironmentId && surfaceProjectId
      ? resolvePullRequestRowCheckoutTarget(
          {
            environmentId: surfaceEnvironmentId,
            projectId: surfaceProjectId,
            repository: prSurface.repository,
            host: prSurface.host,
          },
          projects,
          environments,
        )
      : null;
  const surfaceProject =
    prSurface && surfaceEnvironmentId && surfaceProjectId
      ? projects.find(
          (project) =>
            project.environmentId === surfaceEnvironmentId && project.id === surfaceProjectId,
        )
      : undefined;
  const detailReference =
    prSurface && surfaceProjectId
      ? resolvePullRequestReferenceHost(
          {
            projectId: surfaceProjectId,
            repository: prSurface.repository,
            number: prSurface.number,
            ...(prSurface.host === undefined ? {} : { host: prSurface.host }),
          },
          surfaceProject?.repositoryIdentity,
        )
      : null;
  const liveDetail = useEnvironmentQuery(
    surfaceEnvironmentId && detailReference
      ? pullRequestEnvironment.detail({
          environmentId: surfaceEnvironmentId,
          input: { ...detailReference, allowStale: false },
        })
      : null,
  ).data;
  const cachedDetail =
    surfaceEnvironmentId && detailReference && !liveDetail
      ? readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          surfaceEnvironmentId,
          detailReference,
        )
      : null;
  const detail = liveDetail ?? cachedDetail;
  const canWriteSourceControl = useEnvironmentScope(
    target?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    target?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId: target?.environmentId ?? null,
    cwd: target?.checkoutRoot ?? null,
  });

  if (!prSurface || !openPanelPullRequestUrl || !target) return null;

  const parsedProvider = sourceControlClients.findByChangeRequestUrl(openPanelPullRequestUrl);
  const disabledReason = pullRequestStartAgentDisabledReason(
    {
      environmentConnected: target.environmentConnected,
      checkoutRoot: target.checkoutRoot,
      headRepositoryNameWithOwner: detail?.headRepositoryNameWithOwner,
      provider: detail?.provider ?? parsedProvider?.kind,
      repository: prSurface.repository,
      canWriteSourceControl,
      canOperateThread,
    },
    resolve,
  );
  const terminology = (parsedProvider ?? sourceControlClients.get(detail?.provider)).changeRequest;
  const checkoutRoot = target.checkoutRoot;

  return {
    kind: "action",
    value: "action:start-agent-on-pull-request-branch",
    searchTerms: [
      "start agent",
      "branch",
      "checkout",
      "check out",
      "worktree",
      "pull request",
      "pr",
      "thread",
    ],
    title: gt("Start agent on this branch"),
    description: disabledReason ?? `${prSurface.repository}#${prSurface.number}`,
    disabled: pending || disabledReason !== null,
    icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      if (pending || disabledReason !== null || checkoutRoot === null) return;
      setPending(true);
      await executePullRequestHandoff({
        environmentId: target.environmentId,
        detail: {
          projectId: target.projectId,
          workspaceRoot: checkoutRoot,
          url: openPanelPullRequestUrl,
        },
        terminology,
        newThread,
        prepareThread,
        task: null,
        mode: "worktree",
        onSettle: () => setPending(false),
      });
    },
  };
}
