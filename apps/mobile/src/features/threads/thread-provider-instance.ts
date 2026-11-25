import { useMemo } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  normalizeProviderInstanceBadge,
  resolveProviderInstanceBadges,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly badgeLabel: string | undefined;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
}

/** Scope by environment; default instance ids name different accounts on different servers. */
export function resolveThreadProviderInstance(
  providers: ReadonlyArray<ThreadListProvider> | undefined,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  if (providers === undefined) return null;
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
  };
  const instanceBadge = normalizeProviderInstanceBadge(snapshot.instanceBadge);
  return {
    ...entry,
    badgeLabel: resolveProviderInstanceBadges(providers).get(instanceId),
    showBadge: shouldShowInstanceBadge(
      { ...entry, instanceBadge, enabled: snapshot.enabled },
      providers.map((provider) => ({ driverKind: provider.driver, enabled: provider.enabled })),
    ),
  };
}

/** The account a thread runs on, named only when another enabled instance shares its driver. */
export function resolveThreadAccountLabel(
  providers: ReadonlyArray<ThreadListProvider> | undefined,
  thread: Pick<EnvironmentThreadShell, "runtime" | "modelSelection">,
): string | null {
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers?.find((provider) => provider.instanceId === instanceId);
  if (!providers || !snapshot) return null;
  const namesAccount = shouldShowInstanceBadge(
    { driverKind: snapshot.driver, enabled: snapshot.enabled },
    providers.map((provider) => ({ driverKind: provider.driver, enabled: provider.enabled })),
  );
  return namesAccount ? resolveProviderInstanceDisplayName(snapshot) : null;
}

/** Cache per provider-list generation so fresh resolver objects cannot invalidate every memoized row. */
export function createThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cacheKey = `${thread.environmentId}|${instanceId ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function useThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(
    () => createThreadRowProviderInstanceResolver(providersByEnvironmentId),
    [providersByEnvironmentId],
  );
}
