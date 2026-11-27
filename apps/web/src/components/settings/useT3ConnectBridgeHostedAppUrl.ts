import { BridgeStatus, T3_CONNECT_BRIDGE_ID } from "@t3tools/plugin-t3-connect-bridge/actions";
import { AuthPluginsManageScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { hostedAppUrlFromBridgeStatus } from "./bridgeHostedAppUrl";

const decodeStatus = Schema.decodeUnknownOption(BridgeStatus);

/**
 * The hosted app the environment's T3 Connect bridge opens, or null when the bridge is off.
 * Pairing QRs stay on the environment unless the bridge opted into a hosted app.
 */
export function useT3ConnectBridgeHostedAppUrl(environmentId: EnvironmentId | null): string | null {
  const canManagePlugins = useEnvironmentScope(environmentId, AuthPluginsManageScope);
  const plugins = useEnvironmentQuery(
    environmentId && canManagePlugins
      ? serverEnvironment.plugins({ environmentId, input: {} })
      : null,
  );
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const bridge = canManagePlugins
    ? plugins.data?.plugins.find((plugin) => plugin.manifest.id === T3_CONNECT_BRIDGE_ID)
    : undefined;
  const bridgeRunning = bridge?.enabled === true && bridge.state === "running";
  // The bridge keeps its config behind its status action, not in the plugin snapshot, so each
  // snapshot push (a config edit republishes one) and running change needs a fresh status read.
  const refreshKey = `${environmentId ?? ""}:${plugins.dataUpdatedAt}:${bridgeRunning ? "on" : "off"}`;
  const [loaded, setLoaded] = useState<{ key: string; hostedAppUrl: string | null } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the status action returns the bridge's config; the snapshot only says it changed.
  useEffect(() => {
    if (!environmentId || !canManagePlugins || !bridgeRunning) return;

    let cancelled = false;
    void invoke({
      environmentId,
      input: { pluginId: T3_CONNECT_BRIDGE_ID, action: "status", input: {} },
    }).then((result) => {
      if (cancelled) return;
      const decoded = result._tag === "Success" ? decodeStatus(result.value) : Option.none();
      setLoaded({
        key: refreshKey,
        hostedAppUrl: Option.isSome(decoded) ? hostedAppUrlFromBridgeStatus(decoded.value) : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeRunning, canManagePlugins, environmentId, invoke, refreshKey]);

  return canManagePlugins && bridgeRunning && loaded?.key === refreshKey
    ? loaded.hostedAppUrl
    : null;
}
