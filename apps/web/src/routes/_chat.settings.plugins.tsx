import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { PluginsSettingsPanel } from "../components/settings/PluginsSettings";
import {
  useHasPluginsEnvironment,
  useSettingsCatalogUnavailable,
} from "../components/settings/useAvailableSettingsSearchItems";
import { environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironments } from "../state/environments";
import { environmentSessionStatesAtom } from "../state/session";

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: PluginsSettingsRoute,
});

function PluginsSettingsRoute() {
  const enabled = useHasPluginsEnvironment();
  const catalogUnavailable = useSettingsCatalogUnavailable();
  // Only redirect once every environment reported config and session scopes.
  const { isReady, environments } = useEnvironments();
  const sessionStates = useAtomValue(
    environmentSessionStatesAtom(
      environmentIdsKey(environments.map(({ environmentId }) => environmentId)),
    ),
  );
  const allReported =
    isReady &&
    environments.every(
      (environment, index) =>
        environment.serverConfig !== null &&
        sessionStates[index] !== undefined &&
        sessionStates[index]._tag !== "Initial",
    );
  if (!enabled && allReported && !catalogUnavailable)
    return <Navigate to="/settings/general" replace />;
  return <PluginsSettingsPanel />;
}
