import { formatContextWindowLabel } from "@t3tools/shared/usageLimitsCopy";
import { useMessages } from "gt-react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextUsageRingInput {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
  readonly usedPercentage?: number | null | undefined;
}

export function contextUsageUsedPercent(
  usage: ContextUsageRingInput | null | undefined,
): number | null {
  if (!usage || usage.maxTokens == null || usage.maxTokens <= 0) return null;
  const raw =
    usage.usedPercentage != null
      ? usage.usedPercentage
      : (usage.usedTokens / usage.maxTokens) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** A circular context-window fill indicator shared by the composer ring and subagent rows. */
export function ContextUsageRing({
  usedPercent,
  size = "md",
  className,
}: {
  readonly usedPercent: number | null;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(size === "sm" ? "size-3.5" : "size-4", "shrink-0", className)}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-foreground/15"
      />
      {usedPercent !== null ? (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - usedPercent / 100)}
          transform="rotate(-90 8 8)"
          className={cn(
            usedPercent >= 90
              ? "stroke-destructive"
              : usedPercent >= 80
                ? "stroke-warning"
                : "stroke-muted-foreground",
          )}
        />
      ) : null}
    </svg>
  );
}

/** Small context ring for subagent rows; hidden when the child's context usage is unknown. */
export function SubagentContextRing({
  usage,
  onTooltipOpenChange,
}: {
  readonly usage: ContextUsageRingInput | null | undefined;
  readonly onTooltipOpenChange?: (open: boolean) => void;
}) {
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const m = useMessages();
  const usedPercent = contextUsageUsedPercent(usage);
  if (!usage || usedPercent === null) return null;
  const label = formatContextWindowLabel(usage, usageDisplayMode, m);
  return (
    <Tooltip onOpenChange={onTooltipOpenChange}>
      <TooltipTrigger
        delay={150}
        render={
          <span
            role="img"
            aria-label={label}
            data-subagent-context-ring={usedPercent}
            className="inline-flex shrink-0 items-center justify-center rounded-full"
          />
        }
      >
        <ContextUsageRing usedPercent={usedPercent} size="sm" />
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}
