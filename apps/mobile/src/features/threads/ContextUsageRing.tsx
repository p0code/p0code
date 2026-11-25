import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_USAGE_DISPLAY_MODE } from "@t3tools/contracts/settings";
import { formatContextWindowLabel } from "@t3tools/shared/usageLimitsCopy";
import { AsyncResult } from "effect/reactivity";
import { useMessages } from "gt-react-native";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { mobilePreferencesAtom } from "../../state/preferences";

const ThemedSvg = withUniwind(Svg);
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextUsageRingInput {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}

export function contextUsageUsedPercent(
  usage: ContextUsageRingInput | null | undefined,
): number | null {
  if (!usage || usage.maxTokens == null || usage.maxTokens <= 0) return null;
  const raw = (usage.usedTokens / usage.maxTokens) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** Small context-window ring for subagent rows; hidden when context usage is unknown. */
export function SubagentContextRing(props: {
  readonly usage: ContextUsageRingInput | null | undefined;
  readonly size?: number;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const usageDisplayMode = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.usageDisplayMode ?? DEFAULT_USAGE_DISPLAY_MODE)
    : DEFAULT_USAGE_DISPLAY_MODE;
  const m = useMessages();
  const usedPercent = contextUsageUsedPercent(props.usage);
  if (!props.usage || usedPercent === null) return null;
  const size = props.size ?? 14;
  const label = formatContextWindowLabel(props.usage, usageDisplayMode, m);
  const colorClassName =
    usedPercent >= 90
      ? "accent-red-500"
      : usedPercent >= 80
        ? "accent-amber-500"
        : "accent-foreground-muted";
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      className="shrink-0 items-center justify-center"
    >
      <ThemedSvg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        colorClassName={colorClassName}
        accessible={false}
      >
        <Circle
          cx={8}
          cy={8}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={2}
        />
        <Circle
          cx={8}
          cy={8}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - usedPercent / 100)}
          rotation={-90}
          originX={8}
          originY={8}
        />
      </ThemedSvg>
    </View>
  );
}
