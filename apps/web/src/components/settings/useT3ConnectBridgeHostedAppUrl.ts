import { BridgeStatus, T3_CONNECT_BRIDGE_ID } from "@t3tools/plugin-t3-connect-bridge/actions";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeStatus = Schema.decodeUnknownOption(BridgeStatus);

/**
 * The hosted app the environment's T3 Connect bridge opens, or null when the bridge is off.
 * Pairing QRs stay on the environment unless the bridge opted into a hosted app.
 */
export function useT3ConnectBridgeHostedAppUrl(environmentId: EnvironmentId | null): string | null {
  const plugins = useEnvironmentQuery(
    environmentId ? serverEnvironment.plugins({ environmentId, input: {} }) : null,
  );
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const bridge = plugins.data?.plugins.find(
    (plugin) => plugin.manifest.id === T3_CONNECT_BRIDGE_ID,
  );
  const bridgeRunning = bridge?.enabled === true && bridge.state === "running";
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    hostedAppUrl: string | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the bridge keeps its config behind its status action, not in the plugin snapshot.
  useEffect(() => {
    if (!environmentId || !bridgeRunning) return;

    let cancelled = false;
    void invoke({
      environmentId,
      input: { pluginId: T3_CONNECT_BRIDGE_ID, action: "status", input: {} },
    }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      const decoded = decodeStatus(result.value);
      setLoaded({
        environmentId,
        hostedAppUrl: Option.isSome(decoded)
          ? decoded.value.config.hostedAppUrl.trim() || null
          : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeRunning, environmentId, invoke]);

  return bridgeRunning && loaded?.environmentId === environmentId ? loaded.hostedAppUrl : null;
}
