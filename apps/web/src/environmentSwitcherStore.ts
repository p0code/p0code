import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";
import type { EnvironmentOption } from "./components/BranchToolbar.logic";

interface EnvironmentSwitcherContext {
  readonly environmentId: EnvironmentId;
  readonly availableEnvironments: readonly EnvironmentOption[];
  readonly onEnvironmentChange: ((id: EnvironmentId) => void) | undefined;
}

export const useEnvironmentSwitcherStore = create<{
  context: EnvironmentSwitcherContext | null;
  open: boolean;
}>(() => ({ context: null, open: false }));

export function useRegisterEnvironmentSwitcher(
  enabled: boolean,
  environmentId: EnvironmentId,
  availableEnvironments: readonly EnvironmentOption[],
  onEnvironmentChange: ((id: EnvironmentId) => void) | undefined,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the main chat routing handler with the app chrome only while this chat is mounted
  useEffect(() => {
    if (!enabled) return;
    const context = { environmentId, availableEnvironments, onEnvironmentChange };
    useEnvironmentSwitcherStore.setState({ context });
    return () => {
      if (useEnvironmentSwitcherStore.getState().context === context) {
        useEnvironmentSwitcherStore.setState({ context: null });
      }
    };
  }, [enabled, environmentId, availableEnvironments, onEnvironmentChange]);
}
