import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginInfo } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const T3_CONNECT_BRIDGE_ID = "t3-connect-bridge";

/** Turns bundled plugins on and off; their own settings live in web and desktop. */
export function PluginsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const config = useEnvironmentServerConfig(environmentId);
  const canManage = useAtomValue(serverEnvironment.pluginsSetEnabled.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.plugins === true && canManage;
  const snapshot = useEnvironmentQuery(
    supported ? serverEnvironment.plugins({ environmentId, input: {} }) : null,
  );
  const setEnabled = useAtomCommand(serverEnvironment.pluginsSetEnabled);
  if (!supported || !snapshot.data || snapshot.data.plugins.length === 0) return null;
  const describe = (plugin: PluginInfo) => {
    if (plugin.state === "failed" || plugin.state === "running") {
      if (plugin.message) return plugin.message;
    }
    if (plugin.state === "starting") return gt("Starting…");
    return plugin.manifest.id === T3_CONNECT_BRIDGE_ID
      ? gt(
          "Unofficial. Not end-to-end encrypted: Cloudflare ends TLS and T3's relay sees connection metadata.",
        )
      : plugin.manifest.description;
  };
  return (
    <SettingsSection title={gt("Plugins")}>
      {snapshot.data.plugins.map((plugin) => (
        <ListToggleRow
          key={plugin.manifest.id}
          label={plugin.manifest.name}
          description={describe(plugin)}
          disabled={!canManage || plugin.state === "starting"}
          value={plugin.enabled}
          onValueChange={(enabled) =>
            void setEnabled({ environmentId, input: { pluginId: plugin.manifest.id, enabled } })
          }
        />
      ))}
    </SettingsSection>
  );
}
