import { type AccountProfileId, type EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { nextAccountProfile } from "@t3tools/shared/accountProfiles";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "./environments";
import { serverEnvironment } from "./server";

/**
 * Quick switches act on the primary environment: it holds the accounts on this machine. Other
 * environments keep their own active profile, edited in their provider settings.
 */
function readPrimaryAccountProfiles() {
  const environmentId = readPrimaryEnvironmentId();
  const settings =
    environmentId === null
      ? null
      : appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  return environmentId === null || settings == null ? null : { environmentId, settings };
}

export async function setActiveAccountProfile(
  environmentId: EnvironmentId,
  activeAccountProfileId: AccountProfileId,
  name: string,
) {
  await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch: { activeAccountProfileId } } },
    { label: "switch account profile", reportFailure: true },
  );
}

export function cycleAccountProfile() {
  const current = readPrimaryAccountProfiles();
  const next = current === null ? undefined : nextAccountProfile(current.settings);
  if (current === null || next === undefined) return;
  void setActiveAccountProfile(current.environmentId, next.id, next.name);
}
