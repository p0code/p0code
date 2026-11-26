import type { EnvironmentId, EnvironmentMachineKind, PeerLinkSummary } from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import type { EnvironmentPresentation } from "../state/environments";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";

export interface EnvironmentSwitcherItem {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly status: "online" | "offline" | "connecting";
  readonly detail: string;
  readonly remote: boolean;
  readonly current: boolean;
  readonly disabled: boolean;
}

export function buildEnvironmentSwitcherItems(
  input: {
    environments: readonly EnvironmentPresentation[];
    links: readonly PeerLinkSummary[];
    currentEnvironmentId: EnvironmentId | null;
    availableEnvironments: readonly EnvironmentOption[];
    canChange: boolean;
  },
  resolve: MessageResolver = m,
): EnvironmentSwitcherItem[] {
  const items: EnvironmentSwitcherItem[] = input.environments.map((environment) => {
    const phase = environment.connection.phase;
    const current = environment.environmentId === input.currentEnvironmentId;
    const eligible = input.availableEnvironments.some(
      (option) => option.environmentId === environment.environmentId,
    );
    const status =
      phase === "connected"
        ? "online"
        : phase === "connecting" || phase === "reconnecting"
          ? "connecting"
          : "offline";
    const canSwitch = input.canChange && eligible && status === "online";
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
      status,
      remote: environment.entry.target._tag !== "PrimaryConnectionTarget",
      current,
      disabled: !current && !canSwitch,
      detail:
        status !== "online"
          ? connectionStatusText(environment.connection, resolve)
          : !current && !input.canChange
            ? resolve(msg("This thread stays on its machine"))
            : !current && !eligible
              ? resolve(msg("Project not on this machine"))
              : connectionStatusText(environment.connection, resolve),
    };
  });
  for (const link of input.links) {
    const existing = items.find((item) => item.environmentId === link.environmentId);
    if (existing) continue;
    items.push({
      environmentId: link.environmentId,
      label: link.label,
      machine: "server",
      status: link.status === "reachable" ? "online" : "offline",
      detail:
        link.status === "expired"
          ? resolve(msg("Link credential expired"))
          : (link.lastError ??
            (link.status === "reachable"
              ? resolve(msg("Add this machine to switch here"))
              : resolve(msg("Offline")))),
      remote: true,
      current: link.environmentId === input.currentEnvironmentId,
      disabled: true,
    });
  }
  return items.sort(
    (a, b) => Number(b.current) - Number(a.current) || a.label.localeCompare(b.label),
  );
}

export function buildEnvironmentSwitchActions(
  items: readonly EnvironmentSwitcherItem[],
  onEnvironmentChange: ((id: EnvironmentId) => void) | undefined,
  resolve: MessageResolver = m,
): CommandPaletteActionItem[] {
  return items.map((item) => ({
    kind: "action",
    value: `action:switch-environment:${item.environmentId}`,
    title: resolve(msg("Switch environment: {label}"), { label: item.label }),
    searchTerms: ["switch", "environment", "machine", item.label],
    description: item.detail,
    icon: null,
    disabled: item.disabled,
    checked: item.current,
    shortcutCommand: "environment.switch",
    run: async () => {
      if (!item.disabled && !item.current) onEnvironmentChange?.(item.environmentId);
    },
  }));
}
