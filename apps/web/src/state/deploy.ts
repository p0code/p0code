import { createDeployEnvironmentAtoms } from "@t3tools/client-runtime/state/deploy";

import { connectionAtomRuntime } from "../connection/runtime";

export const deployEnvironment = createDeployEnvironmentAtoms(connectionAtomRuntime);
