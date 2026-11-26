import type { EnvironmentId } from "@t3tools/contracts";
import { withoutHiddenEnvironmentIds } from "@t3tools/shared/accountProfiles";

import { useProfileHiddenEnvironmentIds, useServerConfigs } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";

/** Connected machines with workflows on, minus the ones the active profile leaves out. */
export function workflowEnvironmentIds(
  connectedIds: ReadonlyArray<EnvironmentId>,
  workflowsEnabled: ReadonlySet<EnvironmentId>,
  hiddenEnvironments: ReadonlySet<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  return withoutHiddenEnvironmentIds(connectedIds, hiddenEnvironments).filter((id) =>
    workflowsEnabled.has(id),
  );
}

/** The connected environments whose server has workflows turned on in Labs. */
export function useWorkflowEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const connectedIds = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const hiddenEnvironments = useProfileHiddenEnvironmentIds();
  return workflowEnvironmentIds(
    connectedIds,
    new Set(connectedIds.filter((id) => configs.get(id)?.settings.workflowsEnabled === true)),
    hiddenEnvironments,
  );
}
