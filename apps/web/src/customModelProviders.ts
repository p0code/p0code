import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ListCustomProviderModelsInput,
  ListTextGeneratorModelsResult,
  ProviderInstanceId,
  UserModelProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./state/query";
import { serverEnvironment } from "./state/server";

/** Asks the endpoint for its models, or with `test`, has one answer. Resolves to the error to show. */
export async function listCustomProviderModels(
  environmentId: EnvironmentId,
  input: ListCustomProviderModelsInput,
): Promise<ListTextGeneratorModelsResult | { readonly error: string }> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.listCustomProviderModels,
    { environmentId, input },
    { reportFailure: false },
  );
  return result._tag === "Success"
    ? result.value
    : { error: formatEnvironmentQueryError(result.cause) };
}

const userModelProvidersAtom = Atom.family((key: string) => {
  const [environmentId, instanceId] = JSON.parse(key) as [EnvironmentId, ProviderInstanceId];
  return Atom.make((get) =>
    serverEnvironment.listUserModelProviders
      .run(get.registry, { environmentId, input: { instanceId } })
      .pipe(
        Effect.map((result) => result.providers),
        Effect.catchCause((cause) => Effect.fail(formatEnvironmentQueryError(cause))),
      ),
  ).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`user-model-providers:${key}`));
});

/** Providers the user set up in the agent's own config files. */
export function useUserModelProviders(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): AsyncResult.AsyncResult<ReadonlyArray<UserModelProvider>, string> {
  return useAtomValue(userModelProvidersAtom(JSON.stringify([environmentId, instanceId])));
}
