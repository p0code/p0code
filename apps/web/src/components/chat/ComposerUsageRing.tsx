import { formatUsagePercent } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { ContextUsageRing, contextUsageUsedPercent } from "./ContextUsageRing";
import { resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";
import {
  ThreadDetailsContext,
  ThreadDetailsCost,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";

/** A ring that fills as the thread's context is used; it opens the context and limit details. */
export function ComposerUsageRing({
  usage,
  size,
}: {
  readonly usage: ThreadDetailsUsageInput;
  readonly size: ComposerControlSize;
}) {
  const gt = useGT();
  const m = useMessages();
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const nowMinute = useNowMinute();
  const used = contextUsageUsedPercent(usage.contextWindow);
  const hasLimits =
    resolveThreadDetailsLimits(
      usage.providerInstanceId,
      usage.model,
      usage.providers,
      usage.sources,
      Date.parse(`${nowMinute}:00Z`),
    ) !== null;
  if (usage.contextWindow === null && !hasLimits) return null;
  const displayPercent = used === null ? null : usageDisplayMode === "used" ? used : 100 - used;
  const label =
    displayPercent === null
      ? gt("Context and usage")
      : gt("Context {usage}, show usage", {
          usage: formatUsagePercent(displayPercent, usageDisplayMode, m),
        });
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
        <ContextUsageRing usedPercent={used} size="md" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" padding="none">
        {usage.contextWindow ? <ThreadDetailsContext usage={usage.contextWindow} compact /> : null}
        <ThreadDetailsUsage
          providerInstanceId={usage.providerInstanceId}
          model={usage.model}
          providers={usage.providers}
          sources={usage.sources}
          compact
        />
        <ThreadDetailsCost target={usage.costTarget} compact />
      </PopoverPopup>
    </Popover>
  );
}
