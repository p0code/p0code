import {
  AuthGrantScope,
  AuthPluginsManageScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { Flag } from "effect/cli";

const localSessionScopes = [...AuthGrantScope.literals, AuthPluginsManageScope] as const;

const scopesFlag = <const T extends ReadonlyArray<AuthEnvironmentScope>>(
  allowed: T,
  defaults: ReadonlyArray<T[number]>,
) =>
  Flag.Literals("scope", allowed).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes.length > 0 ? scopes : defaults)]),
  );

export const authScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  scopesFlag(AuthGrantScope.literals, defaults);

/** Local operator sessions may opt into host-only permissions such as `plugins:manage`. */
export const localSessionScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  scopesFlag(localSessionScopes, defaults);
