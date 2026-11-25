import { createFileRoute, Navigate } from "@tanstack/react-router";

import { PluginsSettingsPanel } from "../components/settings/PluginsSettings";
import {
  useHasPluginsEnvironment,
  useSettingsCatalogUnavailable,
} from "../components/settings/useAvailableSettingsSearchItems";
import { useEnvironments } from "../state/environments";

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: PluginsSettingsRoute,
});

function PluginsSettingsRoute() {
  const enabled = useHasPluginsEnvironment();
  const catalogUnavailable = useSettingsCatalogUnavailable();
  // Only redirect once every environment reported; a later one may offer plugins.
  const { isReady, environments } = useEnvironments();
  const allReported =
    isReady && environments.every((environment) => environment.serverConfig !== null);
  if (!enabled && allReported && !catalogUnavailable)
    return <Navigate to="/settings/general" replace />;
  return <PluginsSettingsPanel />;
}
