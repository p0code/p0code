import { msg } from "gt-react-native";
import {
  PROVIDER_INSTANCE_BADGE_MAX_LENGTH,
  providerInstanceBadgeLength,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isManagedSettingPath,
  type ManagedPolicySummary,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";

import { m } from "../../i18n/messages";

/** Sets or clears an instance's badge, keeping every other field of its config. */
export function planProviderInstanceBadgeSave(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly policy: ManagedPolicySummary | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly badge: string;
}): { readonly mutation: ProviderInstanceMutation } | { readonly error: string } {
  const badge = input.badge.trim();
  if (providerInstanceBadgeLength(badge) > PROVIDER_INSTANCE_BADGE_MAX_LENGTH) {
    return {
      error: m(msg("Use up to {count} characters.", { count: PROVIDER_INSTANCE_BADGE_MAX_LENGTH })),
    };
  }
  if (input.policy && isManagedSettingPath(input.policy, `providerInstances.${input.instanceId}`)) {
    return {
      error: m(msg("Managed by {organization}.", { organization: input.policy.organization })),
    };
  }
  const current: ProviderInstanceConfig = Object.hasOwn(input.providerInstances, input.instanceId)
    ? input.providerInstances[input.instanceId]!
    : { driver: input.driver };
  const { instanceBadge: _instanceBadge, ...rest } = current;
  return {
    mutation: {
      operation: "upsert",
      instanceId: input.instanceId,
      instance: badge ? { ...rest, instanceBadge: badge } : rest,
    },
  };
}
