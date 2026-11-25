import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginInfo } from "@t3tools/contracts";
import { OBSIDIAN_SHARED_MEMORY_ID } from "@t3tools/plugin-obsidian-shared-memory/actions";
import { RELAYOO_ID } from "@t3tools/plugin-relayoo/actions";
import { T3_CONNECT_BRIDGE_ID } from "@t3tools/plugin-t3-connect-bridge/actions";
import { T, useGT } from "gt-react";
import type { ComponentType } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  ObsidianSharedMemoryDisclosure,
  ObsidianSharedMemoryPanel,
} from "./ObsidianSharedMemoryPanel";
import { RelayooDisclosure, RelayooPanel } from "./RelayooPanel";
import { T3ConnectBridgeDisclosure, T3ConnectBridgePanel } from "./T3ConnectBridgePanel";

interface PluginPanel {
  /** Shown whether or not the plugin runs, so nobody turns it on unwarned. */
  readonly Disclosure?: ComponentType;
  readonly Panel?: ComponentType<{ readonly environmentId: EnvironmentId }>;
}

/** Settings panels for bundled plugins, by plugin id. */
const PLUGIN_PANELS: Readonly<Record<string, PluginPanel>> = {
  [T3_CONNECT_BRIDGE_ID]: { Disclosure: T3ConnectBridgeDisclosure, Panel: T3ConnectBridgePanel },
  [OBSIDIAN_SHARED_MEMORY_ID]: {
    Disclosure: ObsidianSharedMemoryDisclosure,
    Panel: ObsidianSharedMemoryPanel,
  },
  [RELAYOO_ID]: { Disclosure: RelayooDisclosure, Panel: RelayooPanel },
};

export function PluginsSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const supported =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.plugins === true;
  return (
    <SettingsPageContainer>
      {supported ? (
        <EnvironmentPlugins
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsSection title={gt("Plugins")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment running this version to manage its plugins.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentPlugins({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const snapshot = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  if (snapshot.error) return <p role="alert">{snapshot.error}</p>;
  return snapshot.data?.plugins.map((plugin) => (
    <PluginSection key={plugin.manifest.id} environmentId={environmentId} plugin={plugin} />
  ));
}

function PluginSection({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginInfo;
}) {
  const gt = useGT();
  const canManage = useAtomValue(serverEnvironment.pluginsSetEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(serverEnvironment.pluginsSetEnabled);
  const panel = PLUGIN_PANELS[plugin.manifest.id];
  const status =
    plugin.state === "failed"
      ? plugin.message
      : plugin.state === "starting"
        ? gt("Starting…")
        : plugin.state === "running"
          ? plugin.message
          : null;
  return (
    <SettingsSection
      id={`plugin-${plugin.manifest.id}`}
      title={plugin.manifest.name}
      headerAction={
        <Switch
          checked={plugin.enabled}
          disabled={!canManage || plugin.state === "starting"}
          aria-label={plugin.manifest.name}
          onCheckedChange={(enabled) =>
            void setEnabled({ environmentId, input: { pluginId: plugin.manifest.id, enabled } })
          }
        />
      }
    >
      <div className="space-y-3 px-3 py-3 text-sm sm:px-4">
        {panel?.Disclosure ? <panel.Disclosure /> : <p>{plugin.manifest.description}</p>}
        {status && !(plugin.state === "running" && panel?.Panel) ? (
          <p
            role={plugin.state === "failed" ? "alert" : "status"}
            className={plugin.state === "failed" ? "text-destructive" : "text-muted-foreground"}
          >
            {status}
          </p>
        ) : null}
        {plugin.state === "running" && panel?.Panel ? (
          <panel.Panel environmentId={environmentId} />
        ) : null}
      </div>
    </SettingsSection>
  );
}
