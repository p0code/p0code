import { providerCredentialStatus } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";

export interface ExpiredCredentialAccount {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly email: string | undefined;
  readonly canRenew: boolean;
}

/** Lapsed saved sign-ins that still name an account, so usage can link to the account and renew it. */
export function collectExpiredCredentialAccounts(
  presentations: LimitPresentations,
): readonly ExpiredCredentialAccount[] {
  const seen = new Set<string>();
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.providers ?? []).flatMap((provider) => {
      if (
        !provider.enabled ||
        !provider.installed ||
        providerCredentialStatus(provider.auth, Date.now()) !== "expired"
      ) {
        return [];
      }
      const key = `${environmentId}:${provider.instanceId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          environmentId,
          instanceId: provider.instanceId,
          name: provider.displayName?.trim() || String(provider.driver),
          email: provider.auth.email?.trim() || undefined,
          canRenew: provider.auth.canRenewCredential === true,
        },
      ];
    }),
  );
}

/** The provider settings row for one account, so a warning can open the account it names. */
export function providerSettingsHref(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): string {
  const search = new URLSearchParams({ environmentId, instanceId });
  return `/settings/providers?${search.toString()}`;
}
