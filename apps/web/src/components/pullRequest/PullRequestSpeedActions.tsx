import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type PullRequestAction,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { SquarePenIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { createContext, use, type ReactNode } from "react";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentScope } from "~/state/session";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  pullRequestStartAgentDisabledReason,
  resolvePullRequestMergeMethod,
  resolvePullRequestRowCheckoutTarget,
  type PullRequestRowCheckoutEnvironment,
  type PullRequestRowCheckoutProject,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestQuickActions, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
  usePullRequestHandoffs,
} from "./usePullRequestActions";

import { changeRequestTermKind } from "./changeRequestTerm";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

type PullRequestSpeedActionEntry = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number" | "state" | "isDraft"
> & { readonly stack?: object | undefined };

export interface PullRequestSpeedActionResult<Entry = EnvironmentPullRequestEntry> {
  readonly entry: Entry;
  readonly action: PullRequestAction;
  readonly reply?: PullRequestSummary | undefined;
}

export function PullRequestSpeedActions<Entry extends PullRequestSpeedActionEntry>({
  entry,
  hostActions,
  terminology,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: Entry;
  hostActions: ReadonlySet<PullRequestAction>;
  terminology: ChangeRequestTerminology;
  onActed?: (result: PullRequestSpeedActionResult<Entry>) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: Entry, event: PointerEvent) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const canWrite = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(entry.environmentId),
  );
  const resolveProjectDefault = usePullRequestDefaultMergeMethodResolver(
    entry.environmentId,
    entry.projectId,
  );
  const reference = {
    projectId: entry.projectId,
    host: entry.host,
    repository: entry.repository,
    number: entry.number,
  };
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    terminology,
    onSuccess: (action, reply) => onActed?.({ entry, action, reply }),
    resolveMergeMethod: (detail) => {
      const allowed = detail.capabilities.mergeMethods.filter(
        (method) => detail.mergeCapabilities[method],
      );
      if (allowed.length === 0)
        throw new Error(m(msg("No merge method is available for this repository.")));
      return resolvePullRequestMergeMethod(
        allowed,
        null,
        resolveProjectDefault(),
        useUiStateStore.getState().pullRequestMergeMethod,
      );
    },
  });
  const actions = pullRequestQuickActions(entry, hostActions);
  const busy = actionPending || closing || sweeping;
  if (actions.length === 0) return null;
  return (
    <SpeedModeGroup
      busy={busy}
      pending={actionPending || closing}
      label={gt(
        "Quick actions for {term, select, mr {merge request} cr {change request} other {pull request}} #{number}",
        {
          term: changeRequestTermKind(terminology),
          number: entry.number,
        },
      )}
    >
      {actions.map((action) => {
        const label = resolve(ACTIONS[action].label);
        const Icon = ACTIONS[action].Icon;
        return (
          <SharedTooltipTrigger
            key={action}
            render={
              <Button
                variant={action === "close" ? "destructive-outline" : "outline"}
                size="xs"
                disabled={!canWrite || busy || (action === "merge" && entry.stack !== undefined)}
                aria-label={resolve(ACTIONS[action].numbered, { number: entry.number })}
                onClick={() => void perform(action)}
                onPointerDown={(event) => {
                  if (action !== "close" || !event.isPrimary || event.button !== 0) return;
                  event.stopPropagation();
                  onCloseSweepStart?.(entry, event.nativeEvent);
                }}
              />
            }
            label={
              action === "merge" && entry.stack
                ? gt(
                    "Open this {term, select, mr {merge request} cr {change request} other {pull request}} to merge its stack",
                    { term: changeRequestTermKind(terminology) },
                  )
                : action === "close" && onCloseSweepStart
                  ? gt("Close immediately, or drag across rows to close several")
                  : resolve(ACTIONS[action].immediate)
            }
          >
            {busy ? <Spinner size="xs" /> : <Icon aria-hidden className="size-3" />}
            {label}
          </SharedTooltipTrigger>
        );
      })}
    </SpeedModeGroup>
  );
}

interface PullRequestRowWorkspaceSnapshot {
  readonly projects: ReadonlyArray<PullRequestRowCheckoutProject>;
  readonly environments: ReadonlyArray<PullRequestRowCheckoutEnvironment>;
}

const PullRequestRowWorkspaceContext = createContext<PullRequestRowWorkspaceSnapshot | null>(null);

/**
 * Whether Shift is held, as context rather than a row prop: a Shift press then re-renders each
 * row's action group, not the rows or their buttons, in one commit.
 */
export const PullRequestSpeedModeContext = createContext(false);

/** Tracks Shift and workspace lookups once for the rows below it. */
export function PullRequestSpeedModeProvider({ children }: { children: ReactNode }) {
  const modifiers = useShortcutModifierState(true);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  return (
    <PullRequestRowWorkspaceContext value={{ projects, environments }}>
      <PullRequestSpeedModeContext value={speedMode}>{children}</PullRequestSpeedModeContext>
    </PullRequestRowWorkspaceContext>
  );
}

export type PullRequestRowStartAgentEntry = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "provider" | "url"
> & {
  readonly headRepositoryNameWithOwner?: string | null | undefined;
};

export function PullRequestRowStartAgentButton({
  entry,
  hidden = false,
}: {
  entry: PullRequestRowStartAgentEntry;
  hidden?: boolean;
}) {
  const workspace = use(PullRequestRowWorkspaceContext);
  if (workspace === null) {
    return <StandalonePullRequestRowStartAgentButton entry={entry} hidden={hidden} />;
  }
  return <PullRequestRowStartAgentButtonBody entry={entry} hidden={hidden} workspace={workspace} />;
}

function StandalonePullRequestRowStartAgentButton({
  entry,
  hidden,
}: {
  entry: PullRequestRowStartAgentEntry;
  hidden: boolean;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  return (
    <PullRequestRowStartAgentButtonBody
      entry={entry}
      hidden={hidden}
      workspace={{ projects, environments }}
    />
  );
}

function PullRequestRowStartAgentButtonBody({
  entry,
  hidden,
  workspace,
}: {
  entry: PullRequestRowStartAgentEntry;
  hidden: boolean;
  workspace: PullRequestRowWorkspaceSnapshot;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const speedMode = use(PullRequestSpeedModeContext);
  const target = resolvePullRequestRowCheckoutTarget(
    entry,
    workspace.projects,
    workspace.environments,
  );
  const canWriteSourceControl = useEnvironmentScope(
    target.environmentId,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const { handoff, startHandoff } = usePullRequestHandoffs({
    environmentId: target.environmentId,
    detail:
      target.checkoutRoot === null
        ? null
        : {
            projectId: target.projectId,
            workspaceRoot: target.checkoutRoot,
            url: entry.url,
          },
  });
  const disabledReason = pullRequestStartAgentDisabledReason(
    {
      environmentConnected: target.environmentConnected,
      checkoutRoot: target.checkoutRoot,
      headRepositoryNameWithOwner: entry.headRepositoryNameWithOwner,
      provider: entry.provider,
      repository: entry.repository,
      canWriteSourceControl,
      canOperateThread,
    },
    resolve,
  );
  const checkingOut = handoff !== null;
  const label = checkingOut ? gt("Checking out...") : gt("Start agent on this branch");
  return (
    <div
      className={cn(
        "flex shrink-0 items-center pr-2 transition-opacity",
        checkingOut || speedMode
          ? "pointer-events-auto opacity-100"
          : [
              "pointer-events-none opacity-0",
              "group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
              "focus-within:pointer-events-auto focus-within:opacity-100",
              "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
              "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
            ],
        hidden && "hidden",
      )}
      data-pull-request-action-pending={checkingOut}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex">
              <Button
                variant="ghost-muted"
                size="icon-xs"
                disabled={checkingOut || disabledReason !== null}
                aria-description={disabledReason ?? undefined}
                aria-label={label}
                onClick={() => void startHandoff("checkout:worktree", null, "worktree")}
              >
                {checkingOut ? (
                  <Spinner size="xs" />
                ) : (
                  <SquarePenIcon aria-hidden className="size-3.5" />
                )}
              </Button>
            </span>
          }
        />
        <TooltipPopup>{disabledReason ?? label}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function SpeedModeGroup({
  busy,
  pending,
  label,
  children,
}: {
  busy: boolean;
  pending: boolean;
  label: string;
  children: ReactNode;
}) {
  const speedMode = use(PullRequestSpeedModeContext);
  return (
    <div
      className="shrink-0 items-center gap-1 pr-3"
      style={{ display: speedMode || busy ? "flex" : "none" }}
      role="group"
      aria-label={label}
      data-pull-request-action-pending={pending}
    >
      {children}
    </div>
  );
}

const ACTIONS = {
  close: {
    label: msg("Close", { $context: "verb, close a pull request" }),
    numbered: msg("Close #{number}"),
    immediate: msg("Close immediately"),
    Icon: PullRequestGlyph.closed,
  },
  merge: {
    label: msg("Merge", { $context: "verb, merge a pull request" }),
    numbered: msg("Merge #{number}"),
    immediate: msg("Merge immediately"),
    Icon: PullRequestGlyph.merged,
  },
  ready: {
    label: msg("Ready for review"),
    numbered: msg("Ready for review #{number}"),
    immediate: msg("Ready for review immediately"),
    Icon: PullRequestGlyph.pullRequest,
  },
  reopen: {
    label: msg("Reopen"),
    numbered: msg("Reopen #{number}"),
    immediate: msg("Reopen immediately"),
    Icon: PullRequestGlyph.reopen,
  },
} as const;
