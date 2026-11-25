import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * The scopes the current RPC caller holds, so a handler can enforce a scope that depends on
 * decoded input the static per-method table cannot see.
 */
export class RpcCallerScopes extends Context.Service<
  RpcCallerScopes,
  { readonly scopes: ReadonlyArray<AuthEnvironmentScope> }
>()("p0/auth/RpcCallerScopes") {}
