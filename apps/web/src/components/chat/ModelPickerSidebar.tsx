import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { msg, T, useMessages } from "gt-react";
import { StarIcon } from "lucide-react";
import {
  displayUsagePercent,
  remainingPercent,
  tightestSubscriptionWindow,
} from "@t3tools/shared/usageLimits";
import { formatResetsIn, formatUsagePercent } from "@t3tools/shared/usageLimitsCopy";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
import {
  isProviderInstancePickerReady,
  providerInstanceAccountName,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerCredentialStatusLabel } from "../settings/providerStatus";

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  resolve: MessageResolver,
): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return resolve(msg("{label}: Disabled in settings.", { label }));
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const auth = entry.snapshot.auth;
  if (auth.credentialStatus === "expired" && auth.canRenewCredential !== true) {
    return resolve(
      msg("{label}: Sign-in expired. Sign in again in provider settings to use this account.", {
        label,
      }),
    );
  }
  const message = entry.snapshot.message?.trim();
  if (message) {
    return resolve(
      entry.status === "error"
        ? msg("{label}: Unavailable. {message}", { label, message })
        : entry.status === "warning"
          ? msg("{label}: Limited. {message}", { label, message })
          : msg("{label}: Not ready. {message}", { label, message }),
    );
  }
  return resolve(
    entry.status === "error"
      ? msg("{label}: Unavailable.", { label })
      : entry.status === "warning"
        ? msg("{label}: Limited.", { label })
        : msg("{label}: Not ready.", { label }),
  );
}

function describeUsage(
  windowLabel: string,
  usageText: string,
  resetsIn: string | null,
  resolve: MessageResolver,
): string {
  return resetsIn === null
    ? resolve(msg("{window}: {usage}", { window: windowLabel, usage: usageText }))
    : resolve(
        msg("{window}: {usage}, {resetsIn}", { window: windowLabel, usage: usageText, resetsIn }),
      );
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const m = useMessages();
  const usageDisplayMode = useClientSettings((settings) => settings.usageDisplayMode);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [
    // Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label={m(msg("Providers"))}
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label={m(msg("Favorites"))}
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    <T>Favorites</T>
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

            const usageWindow = isUnavailable ? null : tightestSubscriptionWindow(entry.snapshot);
            const usageLeft = usageWindow === null ? null : remainingPercent(usageWindow);
            const usageDisplayed =
              usageWindow === null ? null : displayUsagePercent(usageWindow, usageDisplayMode);
            const usageSummary =
              usageWindow === null || usageDisplayed === null
                ? null
                : describeUsage(
                    usageWindow.label,
                    formatUsagePercent(usageDisplayed, usageDisplayMode, m),
                    formatResetsIn(usageWindow, now, m),
                    m,
                  );
            const baseTooltip = isUnavailable
              ? describeUnavailableInstance(entry, m)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : providerInstanceAccountName(
                    entry,
                    providerCredentialStatusLabel(entry.snapshot.auth, m),
                  );
            const tooltip =
              usageSummary === null ? baseTooltip : `${baseTooltip} · ${usageSummary}`;

            const button = (
              <Toolbar.Button
                className={cn(
                  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={
                  isUnavailable || isContextDisabled || usageSummary !== null
                    ? tooltip
                    : entry.displayName
                }
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  badgeLabel={entry.badgeLabel}
                  accentColor={entry.accentColor}
                  acpRegistryAgentId={entry.acpRegistryAgentId}
                  acpRegistryIconUrl={entry.acpRegistryIconUrl}
                  showBadge={showInstanceBadge}
                  className="size-6 z-30"
                  iconClassName="size-5"
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
                />
                {usageLeft !== null && usageDisplayed !== null ? (
                  <span
                    aria-hidden
                    data-model-picker-usage-left={usageLeft}
                    data-model-picker-usage-displayed={usageDisplayed}
                    className="pointer-events-none absolute inset-x-1.5 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-foreground/15"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        usageLeft <= 10
                          ? "bg-destructive"
                          : usageLeft <= 25
                            ? "bg-warning"
                            : "bg-success",
                      )}
                      style={{ width: `${usageDisplayed}%` }}
                    />
                  </span>
                ) : null}
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className="relative w-full"
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
