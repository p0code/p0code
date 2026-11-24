import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSharedMemoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "shared-memory:status",
      tag: WS_METHODS.sharedMemoryStatus,
      refreshIntervalMs: 5000,
    }),
    vaults: createEnvironmentRpcCommand(runtime, {
      label: "shared-memory:vaults",
      tag: WS_METHODS.sharedMemoryVaults,
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "shared-memory:command",
      tag: WS_METHODS.sharedMemoryCommand,
    }),
  };
}
