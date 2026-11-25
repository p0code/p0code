import { createAccountProfileSync } from "@t3tools/client-runtime/state/account-profile-sync";
import { isAtomCommandInterrupted, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useState } from "react";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentsWithScope } from "../state/session";
import { toastManager } from "./ui/toast";

/** Keeps every connected environment's account profiles in step with the primary's. */
export function AccountProfileSyncCoordinator() {
  const primaryId = usePrimaryEnvironmentId();
  const connected = useEnvironments().environments.filter(supportsSharedSettingsSync);
  const writable = useEnvironmentsWithScope(connected, AuthSettingsWriteScope);
  const [sync] = useState(() =>
    createAccountProfileSync({
      write: async (environmentId, patch) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          serverEnvironment.updateSettings,
          { environmentId, input: { patch } },
          { label: "sync account profiles" },
        );
        return result._tag === "Success" || isAtomCommandInterrupted(result);
      },
      onFailed: (environmentId) =>
        toastManager.add({
          type: "warning",
          title: m(
            msg("Couldn't sync profiles to {environment}", {
              environment: readEnvironment(environmentId)?.label ?? environmentId,
            }),
          ),
        }),
    }),
  );
  const source =
    connected.find((environment) => environment.environmentId === primaryId)?.serverConfig
      ?.settings ?? null;
  const targets = connected.flatMap((environment) =>
    environment.environmentId !== primaryId &&
    writable.has(environment.environmentId) &&
    environment.serverConfig
      ? [{ environmentId: environment.environmentId, settings: environment.serverConfig.settings }]
      : [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pushes the primary's profiles to other environments' servers as connections and settings change.
  useEffect(() => sync.update({ source, targets }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels a pending sync when the app shell unmounts.
  useEffect(() => () => sync.dispose(), [sync]);
  return null;
}
