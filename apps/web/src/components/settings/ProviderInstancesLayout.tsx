import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";

export type ProviderInstanceRowStatusTone = "neutral" | "ready" | "warning" | "error" | "disabled";

export interface ProviderInstanceListRow {
  readonly id: string;
  readonly icon: ReactNode;
  readonly name: string;
  readonly version?: string | null;
  readonly status: ReactNode;
  readonly statusTone?: ProviderInstanceRowStatusTone;
  /** Dimmed when disabled; returns to full contrast on hover or while selected. */
  readonly dimmed?: boolean;
  /** Accessible name for the selectable option. Defaults to `name`. */
  readonly ariaLabel?: string;
  /** Trailing controls (e.g. an enable Switch), rendered outside the option button. */
  readonly trailing?: ReactNode;
  /** Indents the row under the row above it (e.g. an account under its provider). */
  readonly nested?: boolean;
  readonly testId?: string;
}

export interface ProviderInstanceListGroup {
  readonly id: string;
  /** Optional subtle group heading shown above this group's rows. */
  readonly label?: string;
  readonly rows: ReadonlyArray<ProviderInstanceListRow>;
}

export interface ProviderInstancesLayoutProps {
  readonly title: string;
  /** Control placed next to the section heading (e.g. a `+` add button). */
  readonly titleAction?: ReactNode;
  /** Optional compact bar above the card (e.g. a profile scope note). */
  readonly toolbar?: ReactNode;
  /** Optional banner above the card (e.g. an error). */
  readonly banner?: ReactNode;
  /** Selectable rows, optionally grouped under headings in the left list. */
  readonly groups: ReadonlyArray<ProviderInstanceListGroup>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly listLabel: string;
  /** Right-hand (or stacked on narrow containers) detail pane. */
  readonly detail: ReactNode;
  readonly detailLabel: string;
}

const STATUS_DOT_CLASS: Partial<Record<ProviderInstanceRowStatusTone, string>> = {
  warning: "bg-warning",
  error: "bg-destructive",
};

/**
 * Container-relative master/detail layout for provider and account lists in Settings.
 * Side-by-side at >= 48rem container width and stacked on narrower dialogs or phones.
 */
export function ProviderInstancesLayout({
  title,
  titleAction,
  toolbar,
  banner,
  groups,
  selectedId,
  onSelect,
  listLabel,
  detail,
  detailLabel,
}: ProviderInstancesLayoutProps) {
  const baseId = useId();
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const nonEmptyGroups = groups.filter((group) => group.rows.length > 0);
  const flatRowIds = nonEmptyGroups.flatMap((group) => group.rows.map((row) => row.id));
  const activeOptionId =
    selectedId !== null && flatRowIds.includes(selectedId) ? selectedId : (flatRowIds[0] ?? null);

  const focusAndSelect = (nextId: string | undefined) => {
    if (nextId === undefined) return;
    onSelect(nextId);
    optionRefs.current.get(nextId)?.focus();
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "option") {
      return;
    }
    const currentId = event.target.dataset.optionId;
    const currentIndex = currentId === undefined ? -1 : flatRowIds.indexOf(currentId);
    if (currentIndex === -1) return;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        focusAndSelect(flatRowIds[Math.min(flatRowIds.length - 1, currentIndex + 1)]);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        focusAndSelect(flatRowIds[Math.max(0, currentIndex - 1)]);
        break;
      }
      case "Home": {
        event.preventDefault();
        focusAndSelect(flatRowIds[0]);
        break;
      }
      case "End": {
        event.preventDefault();
        focusAndSelect(flatRowIds[flatRowIds.length - 1]);
        break;
      }
    }
  };

  const renderRow = (row: ProviderInstanceListRow) => {
    const selected = row.id === selectedId;
    const isTabStop = row.id === activeOptionId;
    const dotClass = row.statusTone ? STATUS_DOT_CLASS[row.statusTone] : undefined;

    return (
      <div
        key={row.id}
        role="presentation"
        data-slot="settings-row"
        data-selected={selected ? "" : undefined}
        data-testid={row.testId}
        className={cn(
          "group relative flex items-center gap-3 px-3 transition-colors sm:px-4",
          row.nested ? "min-h-12 py-2 pl-8 sm:pl-9" : "min-h-18 py-3",
          selected ? "bg-foreground/[0.06]" : "hover:bg-muted/25",
        )}
      >
        <div
          className={cn(
            "pointer-events-none flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
            row.dimmed && !selected && "opacity-60 group-hover:opacity-100",
          )}
        >
          <button
            ref={(element) => {
              if (element) optionRefs.current.set(row.id, element);
              else optionRefs.current.delete(row.id);
            }}
            type="button"
            role="option"
            data-option-id={row.id}
            aria-selected={selected}
            aria-label={row.ariaLabel ?? row.name}
            tabIndex={isTabStop ? 0 : -1}
            className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => onSelect(row.id)}
          />
          <span className="flex size-5 shrink-0 items-center justify-center">{row.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
              {row.version ? (
                <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {row.version}
                </code>
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground/80">
              {dotClass ? (
                <span className="flex h-[1.45em] shrink-0 items-center">
                  <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden />
                </span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">{row.status}</span>
            </span>
          </span>
        </div>
        {row.trailing ? (
          <span className="pointer-events-none relative flex h-5 shrink-0 items-center gap-1 *:pointer-events-auto">
            {row.trailing}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="@container/provider-instances">
      <SettingsSection title={title} titleAction={titleAction} variant="plain">
        {toolbar}
        {banner}
        <SettingsGroup
          divided={false}
          className="overflow-hidden @min-[48rem]/provider-instances:grid @min-[48rem]/provider-instances:max-h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/provider-instances:min-h-[24rem] @min-[48rem]/provider-instances:grid-cols-[17rem_minmax(0,1fr)]"
        >
          <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/provider-instances:flex @min-[48rem]/provider-instances:min-h-0 @min-[48rem]/provider-instances:flex-col @min-[48rem]/provider-instances:border-r @min-[48rem]/provider-instances:border-b-0">
            <ScrollArea
              scrollFade
              chainVerticalScroll
              className="@min-[48rem]/provider-instances:min-h-0 @min-[48rem]/provider-instances:flex-1"
            >
              <div
                role="listbox"
                aria-label={listLabel}
                aria-orientation="vertical"
                className="divide-y divide-border/50"
                onKeyDown={handleListKeyDown}
              >
                {nonEmptyGroups.map((group) => {
                  if (!group.label) {
                    return group.rows.map(renderRow);
                  }
                  const headingId = `${baseId}-group-${group.id}`;
                  return (
                    <div
                      key={group.id}
                      role="group"
                      aria-labelledby={headingId}
                      className="divide-y divide-border/50"
                    >
                      <div
                        id={headingId}
                        className="bg-muted/20 px-3 py-1.5 text-2xs font-medium text-muted-foreground sm:px-4"
                      >
                        {group.label}
                      </div>
                      {group.rows.map(renderRow)}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          <div
            data-provider-detail
            role="region"
            aria-label={detailLabel}
            className="min-w-0 @min-[48rem]/provider-instances:min-h-0"
          >
            <ScrollArea
              scrollFade
              chainVerticalScroll
              className="@min-[48rem]/provider-instances:h-full"
            >
              <div className="space-y-6 py-4">{detail}</div>
            </ScrollArea>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
