import type { P0Namespace } from "./api.ts";
import { usageNamespace, type UsageServices } from "./usage.ts";

/** Add a namespace here to give agents more of p0code to read from `p0_code`. */
export const P0_NAMESPACES: ReadonlyArray<P0Namespace<P0Services>> = [usageNamespace];

/** The services the namespaces' methods read; `p0_code` declares them as its dependencies. */
export type P0Services = UsageServices;
