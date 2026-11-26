import { createDeployEnvironmentAtoms } from "@t3tools/client-runtime/state/deploy";
import type { DeployOverview, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const activeProfileAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.settingsValueAtom(environmentId))?.activeAccountProfileId ?? null,
  ).pipe(Atom.withLabel(`web-deploy:active-profile:${environmentId}`)),
);

export const deployEnvironment = createDeployEnvironmentAtoms(connectionAtomRuntime, {
  overviewRefreshTrigger: (environmentId) => activeProfileAtom(environmentId),
});

/** Profile-scoped deploy overview for one environment; skips the RPC when plugins are unsupported. */
export function useDeployOverview(environmentId: EnvironmentId | null): DeployOverview | null {
  const configs = useServerConfigs();
  const enabled =
    environmentId !== null &&
    configs.get(environmentId)?.environment?.capabilities?.plugins === true;
  return useEnvironmentQuery(
    enabled ? deployEnvironment.overview({ environmentId, input: {} }) : null,
  ).data;
}
