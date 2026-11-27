import { BACKUP_PLUGIN_ID } from "@t3tools/plugin-backup/actions";
import { BackupDisclosure, BackupPanel } from "./BackupPanel";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginInfo } from "@t3tools/contracts";
import { OBSIDIAN_SHARED_MEMORY_ID } from "@t3tools/plugin-obsidian-shared-memory/actions";
import { T3_CONNECT_BRIDGE_ID } from "@t3tools/plugin-t3-connect-bridge/actions";
import { T, useGT, useMessages } from "gt-react";
import { type ComponentType, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { desktopLocalBackendId } from "../../connection/desktopLocal";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  ObsidianSharedMemoryDisclosure,
  ObsidianSharedMemoryPanel,
} from "./ObsidianSharedMemoryPanel";
import { T3ConnectBridgeDisclosure, T3ConnectBridgePanel } from "./T3ConnectBridgePanel";
import { pluginCapabilityCopy } from "./pluginCapabilityCopy";
import { PluginInstaller } from "./PluginInstaller";
import { PluginShopTab } from "./PluginShopTab";
import { pluginInstallError } from "./pluginInstall.logic";

interface PluginPanel {
  /** Shown whether or not the plugin runs, so nobody turns it on unwarned. */
  readonly Disclosure?: ComponentType;
  readonly Panel?: ComponentType<{ readonly environmentId: EnvironmentId }>;
}

/** Settings panels for bundled plugins, by plugin id. */
const PLUGIN_PANELS: Readonly<Record<string, PluginPanel>> = {
  [BACKUP_PLUGIN_ID]: { Disclosure: BackupDisclosure, Panel: BackupPanel },
  [T3_CONNECT_BRIDGE_ID]: { Disclosure: T3ConnectBridgeDisclosure, Panel: T3ConnectBridgePanel },
  [OBSIDIAN_SHARED_MEMORY_ID]: {
    Disclosure: ObsidianSharedMemoryDisclosure,
    Panel: ObsidianSharedMemoryPanel,
  },
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
        <AuthorizedEnvironmentPlugins
          key={environment.environmentId}
          environmentId={environment.environmentId}
          nativeTarget={desktopLocalBackendId(environment.entry.target)}
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

function AuthorizedEnvironmentPlugins({
  environmentId,
  nativeTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly nativeTarget: string | null;
}) {
  const gt = useGT();
  const canManage = useAtomValue(serverEnvironment.pluginsSetEnabled.permissionAtom(environmentId));
  if (!canManage) {
    return (
      <SettingsSection title={gt("Plugins")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Managing plugins requires owner access on this environment.</T>
        </p>
      </SettingsSection>
    );
  }
  return <EnvironmentPlugins environmentId={environmentId} nativeTarget={nativeTarget} />;
}

function EnvironmentPlugins({
  environmentId,
  nativeTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly nativeTarget: string | null;
}) {
  const gt = useGT();
  const snapshot = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const m = useMessages();
  const [tab, setTab] = useState<"installed" | "shop">("installed");
  return (
    <>
      <div className="px-4">
        <ToggleGroup
          aria-label={gt("Plugins view")}
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            if (next[0] === "installed" || next[0] === "shop") setTab(next[0]);
          }}
        >
          <Toggle value="installed">
            <T>Installed</T>
          </Toggle>
          <Toggle value="shop">
            <T>Shop</T>
          </Toggle>
        </ToggleGroup>
      </div>
      {tab === "installed" ? (
        <PluginInstaller
          environmentId={environmentId}
          nativeTarget={nativeTarget}
          onChange={snapshot.refresh}
        />
      ) : (
        <SettingsSection title={gt("Plugin shop")}>
          <div className="px-4 py-3">
            <PluginShopTab environmentId={environmentId} onChange={snapshot.refresh} />
          </div>
        </SettingsSection>
      )}
      {tab === "installed" ? (
        <>
          {snapshot.error ? (
            <p role="alert">{m(pluginInstallError(snapshot.failure ?? snapshot.error))}</p>
          ) : null}
          {snapshot.data?.plugins.map((plugin) => (
            <PluginSection key={plugin.manifest.id} environmentId={environmentId} plugin={plugin} />
          ))}
        </>
      ) : null}
    </>
  );
}

function PluginSection({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginInfo;
}) {
  const gt = useGT();
  const m = useMessages();
  const canManage = useAtomValue(serverEnvironment.pluginsSetEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(serverEnvironment.pluginsSetEnabled);
  const panel = PLUGIN_PANELS[plugin.manifest.id];
  const status =
    plugin.state === "failed"
      ? m(pluginInstallError(plugin.message))
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
        <p className="font-mono text-xs text-muted-foreground">
          {plugin.manifest.id} · {plugin.manifest.version}
        </p>
        {panel?.Disclosure ? <panel.Disclosure /> : <p>{plugin.manifest.description}</p>}
        {plugin.manifest.capabilities.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {plugin.manifest.capabilities.map((capability) => (
              <li key={capability}>{m(pluginCapabilityCopy[capability])}</li>
            ))}
          </ul>
        ) : null}
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
