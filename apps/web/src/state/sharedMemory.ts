import { createSharedMemoryAtoms } from "@t3tools/client-runtime/state/sharedMemory";
import { connectionAtomRuntime } from "../connection/runtime";
export const sharedMemory = createSharedMemoryAtoms(connectionAtomRuntime);
