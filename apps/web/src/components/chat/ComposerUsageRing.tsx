import { useGT } from "gt-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";
import {
  ThreadDetailsContext,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function contextUsedPercent(
  contextWindow: ThreadDetailsUsageInput["contextWindow"],
): number | null {
  if (!contextWindow || contextWindow.usedPercentage === null) return null;
  if (contextWindow.maxTokens == null || contextWindow.maxTokens <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, contextWindow.usedPercentage)));
}

/** A ring that fills as the thread's context is used; it opens the context and limit details. */
export function ComposerUsageRing({
  usage,
  size,
}: {
  readonly usage: ThreadDetailsUsageInput;
  readonly size: ComposerControlSize;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const used = contextUsedPercent(usage.contextWindow);
  const hasLimits =
    resolveThreadDetailsLimits(
      usage.providerInstanceId,
      usage.model,
      usage.providers,
      usage.sources,
      Date.parse(`${nowMinute}:00Z`),
    ) !== null;
  if (usage.contextWindow === null && !hasLimits) return null;
  const label =
    used === null ? gt("Context and usage") : gt("Context {used}% used, show usage", { used });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={label}
            data-composer-usage-ring={used ?? "unknown"}
            className="px-1.5"
          />
        }
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-foreground/15"
          />
          {used !== null ? (
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - used / 100)}
              transform="rotate(-90 8 8)"
              className={cn(
                used >= 90
                  ? "stroke-destructive"
                  : used >= 80
                    ? "stroke-warning"
                    : "stroke-muted-foreground",
              )}
            />
          ) : null}
        </svg>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-80">
        <div className="flex flex-col gap-3">
          {usage.contextWindow ? <ThreadDetailsContext usage={usage.contextWindow} /> : null}
          <ThreadDetailsUsage
            providerInstanceId={usage.providerInstanceId}
            model={usage.model}
            providers={usage.providers}
            sources={usage.sources}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
