import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
import { AuthEnvironmentMaintainScope, AuthPluginsManageScope } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

/** Any environment whose server enables secret providers; gates the Secrets page, nav and search. */
export function useHasSecretProvidersEnvironment() {
  const { environments } = useEnvironments();
  return environments.some((environment) =>
    hasFeatureFlag(environment.serverConfig, "secretProviders"),
  );
}

export function useHasPluginsEnvironment() {
  const { environments } = useEnvironments();
  const pluginManagers = useEnvironmentsWithScope(environments, AuthPluginsManageScope);
  return environments.some(
    (environment) =>
      environment.serverConfig?.environment.capabilities.plugins === true &&
      pluginManagers.has(environment.environmentId),
  );
}

/** The saved connection catalog could not be read, so no environment's capabilities are known. */
export function useSettingsCatalogUnavailable() {
  return useEnvironments().catalogError !== null;
}

export function useAvailableSettingsSearchItems() {
  const { environments } = useEnvironments();
  // Explicit booleans keep flags out of the filter cache so environment updates do not rebuild the list.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some((environment) =>
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: environment.serverConfig !== null,
      }),
    ) === true;
  // Any machine that offers it; the row then shows for a settings scope where all selected ones do.
  const hasFastWorktreeCheckoutEnvironment =
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout === true,
    ) === true;

  const hasTextGeneratorsEnvironment =
    environments.some(
      (environment) =>
        environment.serverConfig !== null &&
        environment.serverConfig.managedPolicy?.limits?.providers?.allowedDrivers === undefined,
    ) === true;
  const hasSecretProvidersEnvironment = useHasSecretProvidersEnvironment();
  const hasPluginsEnvironment = useHasPluginsEnvironment();
  const catalogUnavailable = useSettingsCatalogUnavailable();
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const hasPeerLinkHost = usePeerLinkHosts().length > 0;
  const managedTunnelActive = false;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
    useMessages(),
  );
  const cloudPublicConfig = false;
  const wslSettingsRowVisible =
    isWslSettingsRowVisible({ state: desktopWsl.data, error: desktopWsl.error }) === true;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasCloudPublicConfig: cloudPublicConfig,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    canManageLocalBackend,
    isWslSettingsRowVisible: wslSettingsRowVisible,
    hasThreadAutoSettlement,
    managedTunnelActive,
    hasPeerLinkHost,
    hasFastWorktreeCheckoutEnvironment,
    hasTextGeneratorsEnvironment,
    hasPrimaryEnvironment: primaryEnvironmentId !== null,
    hasSecretProvidersEnvironment,
    hasPluginsEnvironment,
    catalogUnavailable,
  });
}
