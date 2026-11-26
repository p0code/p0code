import type {
  EnvironmentId,
  ProjectCost,
  ProjectCostAmount,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  contextWindowDisplay,
  displayPoolUsagePercent,
  displayUsagePercent,
  type LimitPace,
  type LimitPoolWindow,
  paceDisplayPercent,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  formatContextWindowValue,
  formatDuration,
  formatPaceWindowPercent,
  formatUsagePercent,
  limitsNotice,
} from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import type { ReactNode } from "react";

import { useClientSettings, usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

/** The thread whose project cost the details show; null for a draft, which has none yet. */
export interface ThreadDetailsCostTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /**
   * No project (scratch) threads, including legacy scratch ids whose project row is gone. Their
   * project figure would total every scratch chat, so the details show only this thread.
   */
  readonly isScratch: boolean;
}

export interface ThreadDetailsUsageInput {
  readonly costTarget: ThreadDetailsCostTarget | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

function limitTone(left: number): UsageTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

/** The selected provider's limit windows. Each row reads as room left and opens the usage page. */
export function ThreadDetailsUsage({
  providerInstanceId,
  model,
  providers,
  sources,
  compact = false,
}: Omit<ThreadDetailsUsageInput, "contextWindow" | "costTarget"> & { readonly compact?: boolean }) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const quotas = resolveThreadHttpQuotas(providerInstanceId, sources);
  if (!resolved && quotas.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
      compact={compact}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved?.kind === "pool"
          ? resolved.windows.map((window) => <PoolRow key={window.id} window={window} now={now} />)
          : resolved &&
            (quotas.length === 0 || limitsNotice(resolved.limits) === null) && (
              <InstanceRows limits={resolved.limits} now={now} />
            )}
        {quotas.map(({ key, accountLabel, window }) => (
          <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function InstanceRows({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const notice = limitsNotice(limits, m);
  if (notice) {
    return (
      <UsageRow
        label={gt("Limits", { $context: "usage limits row label" })}
        fill={null}
        tone={null}
        value={gt("Unavailable")}
        tooltip={<span className="text-foreground">{notice}</span>}
        opensUsage
      />
    );
  }
  return limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />);
}

/** The thread's context window. Bar fill, auto-compaction tick, and value follow usage display mode. */
export function ThreadDetailsContext({
  usage,
  compact = false,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly compact?: boolean;
}) {
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const metrics = contextWindowDisplay(usage, usageDisplayMode);
  const maxTokens = metrics.maxTokens;
  const used = metrics.usedPercent;
  const threshold = usage.autoCompactThreshold ?? null;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const usagePercentLabel =
    metrics.fillPercent !== null
      ? formatUsagePercent(metrics.fillPercent, usageDisplayMode, m)
      : null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
      compact={compact}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={metrics.fillPercent}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={metrics.tickPercent}
          muted
          value={formatContextWindowValue(usage, usageDisplayMode, m)}
          ariaValue={usagePercentLabel ?? gt("{usedTokens} tokens used", { usedTokens })}
          tooltip={
            <>
              <span className="text-foreground">
                {usagePercentLabel !== null
                  ? gt("Context: {usage}", { usage: usagePercentLabel })
                  : gt("Context: {usedTokens} tokens used", { usedTokens })}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usageDisplayMode === "used"
                    ? gt("{used} of {max} tokens used", {
                        used: usage.usedTokens.toLocaleString(locale),
                        max: maxTokens.toLocaleString(locale),
                      })
                    : gt("{remaining} of {max} tokens left", {
                        remaining: (metrics.remainingTokens ?? 0).toLocaleString(locale),
                        max: maxTokens.toLocaleString(locale),
                      })}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/**
 * What the project and this thread cost. The query mounts with the card, so it runs when the
 * popover or panel opens and never in the background.
 */
export function ThreadDetailsCost({
  target,
  compact = false,
}: {
  readonly target: ThreadDetailsCostTarget | null;
  readonly compact?: boolean;
}) {
  const query = useEnvironmentQuery<ProjectCost, unknown>(
    target === null
      ? null
      : serverEnvironment.projectCost({
          environmentId: target.environmentId,
          input: { projectId: target.projectId, threadId: target.threadId },
        }),
  );
  const gt = useGT();
  if (target === null || query.error !== null) return null;
  const cost = query.data;
  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title={gt("Cost")}
      showHeading={false}
      compact={compact}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {target.isScratch ? null : (
          <CostRow label={gt("This project")} amount={cost?.project ?? null} strong />
        )}
        {target.isScratch || cost?.thread ? (
          <CostRow
            label={gt("This thread")}
            amount={cost?.thread ?? null}
            strong={target.isScratch}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function CostRow({
  label,
  amount,
  strong = false,
}: {
  readonly label: string;
  /** Null while the first answer is loading. */
  readonly amount: ProjectCostAmount | null;
  readonly strong?: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const value =
    amount === null ? "…" : `${amount.partial ? "~" : ""}${formatUsd(amount.costUsd, locale)}`;
  return (
    <UsageRow
      label={label}
      fill={null}
      tone={null}
      strong={strong}
      value={value}
      tooltip={
        <>
          <span className="text-foreground">{gt("{label}: {value}", { label, value })}</span>
          <span className="text-muted-foreground">
            {gt("Estimate: token counts at API list prices, whatever you pay your provider")}
          </span>
          {amount?.partial ? (
            <span className="text-muted-foreground">
              {gt("Left out, no known price: {models}", {
                models: amount.unpricedModels.join(", "),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function LimitRow({
  window,
  now,
  accountLabel,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly accountLabel?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const left = remainingPercent(window);
  const displayed = displayUsagePercent(window, usageDisplayMode);
  const pace = paceOf(window, now);
  const pacePosition = paceDisplayPercent(window, now, usageDisplayMode);
  const usageText = formatUsagePercent(displayed, usageDisplayMode, m);
  const paceText =
    pacePosition === null ? null : formatPaceWindowPercent(pacePosition, usageDisplayMode, m);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={displayed}
      tone={limitTone(left)}
      tick={pacePosition}
      value={usageText}
      ariaValue={usageText}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {usage}", { label: window.label, usage: usageText })}
          </span>
          {accountLabel ? <span className="text-muted-foreground">{accountLabel}</span> : null}
          {pace && paceText !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {paceText}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function PoolRow({ window, now }: { readonly window: LimitPoolWindow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const left = window.remainingPercent;
  const displayed = displayPoolUsagePercent(window, usageDisplayMode);
  const usageText = formatUsagePercent(displayed, usageDisplayMode, m);
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;
  return (
    <UsageRow
      label={window.label}
      fill={displayed}
      tone={limitTone(left)}
      value={usageText}
      ariaValue={usageText}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {usage} across {accounts} accounts", {
                  label: window.label,
                  usage: usageText,
                  accounts,
                })
              : gt("{label}: {usage}", { label: window.label, usage: usageText })}
          </span>
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  strong = false,
  opensUsage = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
  /** Text-only rows read as quiet by default; a strong one carries the section. */
  readonly strong?: boolean;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? strong
                    ? "text-foreground/80"
                    : "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
