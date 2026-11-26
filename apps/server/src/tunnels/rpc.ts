import {
  AuthAccessWriteScope,
  AuthFilesystemReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type PublicTunnelCreateInput,
  type PublicTunnelDecideRequestInput,
  type PublicTunnelId,
  type PublicTunnelIdInput,
  type PublicTunnelListInput,
  type PublicTunnelOperationError,
  type PublicTunnelUpdateInput,
  type PublicTunnelVisitsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { failEnvironmentInternal, requireEnvironmentScope } from "../auth/http.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as PublicTunnels from "./PublicTunnels.ts";

function targetResourceScope(kind: "port" | "file" | "folder"): AuthEnvironmentScope {
  return kind === "port" ? AuthTerminalOperateScope : AuthFilesystemReadScope;
}

const mapInternalTunnelError = (error: PublicTunnelOperationError) =>
  failEnvironmentInternal("internal_error", error);

const mapHttpTunnelError = (error: PublicTunnelOperationError) => {
  switch (error.reason) {
    case "policy":
    case "disabled":
    case "port_refused":
    case "path_refused":
    case "scope_refused":
      return Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
    case "conflict":
      return Effect.fail(new EnvironmentHttpConflictError({ message: error.message }));
    case "invalid_input":
    case "not_found":
    case "relay_unlinked":
    case "relay_unsupported":
      return Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }));
    case "internal":
      return failEnvironmentInternal("internal_error", error);
  }
};

export function createTunnelsWsHandlers(options: {
  readonly publicTunnels: PublicTunnels.PublicTunnels["Service"];
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
}) {
  const { publicTunnels, sessionId, scopes } = options;

  const assertWsScopes = Effect.fn("TunnelsRpc.assertWsScopes")(function* (
    required: ReadonlyArray<AuthEnvironmentScope>,
  ) {
    for (const scope of required) {
      if (!scopes.has(scope)) {
        return yield* rpcAuthorizationError(scope);
      }
    }
  });

  return {
    list: (input: PublicTunnelListInput) => publicTunnels.list(input),
    create: (input: PublicTunnelCreateInput) =>
      publicTunnels.create(input, { kind: "user", sessionId }),
    update: Effect.fn("TunnelsRpc.ws.update")(function* (input: PublicTunnelUpdateInput) {
      if (input.enabled === true || input.expiresAt !== undefined) {
        const existing = yield* publicTunnels.get(input.id);
        yield* assertWsScopes([
          AuthRelayWriteScope,
          AuthAccessWriteScope,
          targetResourceScope(existing.target.kind),
        ]);
      }
      return yield* publicTunnels.update(input);
    }),
    rotate: (input: PublicTunnelIdInput) => publicTunnels.rotate(input.id),
    remove: (input: PublicTunnelIdInput) => publicTunnels.remove(input.id),
    stopAll: () => publicTunnels.stopAll(),
    visits: (input: PublicTunnelVisitsInput) => publicTunnels.visits(input),
    link: (input: PublicTunnelIdInput) => publicTunnels.link(input.id),
    decideRequest: Effect.fn("TunnelsRpc.ws.decideRequest")(function* (
      input: PublicTunnelDecideRequestInput,
    ) {
      if (input.approve) {
        const existing = yield* publicTunnels.get(input.id);
        yield* assertWsScopes([
          AuthRelayWriteScope,
          AuthAccessWriteScope,
          targetResourceScope(existing.target.kind),
        ]);
      }
      return yield* publicTunnels.decideRequest(input, sessionId);
    }),
    subscribe: () => publicTunnels.changes,
  } as const;
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tunnels",
  Effect.fnUntraced(function* (handlers) {
    const publicTunnels = yield* PublicTunnels.PublicTunnels;
    return handlers
      .handle("list", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(
          Effect.andThen(publicTunnels.list()),
          Effect.catchTags({ PublicTunnelOperationError: mapInternalTunnelError }),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* requireEnvironmentScope(targetResourceScope(payload.target.kind));
          return yield* publicTunnels
            .create(payload, { kind: "user", sessionId: session.sessionId })
            .pipe(Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }));
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          const id = params.id as PublicTunnelId;
          if (payload.enabled === true || payload.expiresAt !== undefined) {
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const existing = yield* publicTunnels
              .get(id)
              .pipe(Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }));
            yield* requireEnvironmentScope(targetResourceScope(existing.target.kind));
          }
          return yield* publicTunnels
            .update({ ...payload, id })
            .pipe(Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }));
        }),
      )
      .handle("rotate", ({ params }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(publicTunnels.rotate(params.id as PublicTunnelId)),
          Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }),
        ),
      )
      .handle("remove", ({ params }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(publicTunnels.remove(params.id as PublicTunnelId)),
          Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }),
        ),
      )
      .handle("stopAll", () =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(publicTunnels.stopAll()),
          Effect.catchTags({ PublicTunnelOperationError: mapInternalTunnelError }),
        ),
      )
      .handle("visits", ({ params, query }) =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(
          Effect.andThen(
            publicTunnels.visits({
              id: params.id as PublicTunnelId,
              ...(query.before !== undefined ? { before: query.before } : {}),
              ...(query.limit !== undefined ? { limit: query.limit } : {}),
            }),
          ),
          Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }),
        ),
      )
      .handle("link", ({ params }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(requireEnvironmentScope(AuthRelayReadScope)),
          Effect.andThen(publicTunnels.link(params.id as PublicTunnelId)),
          Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }),
        ),
      )
      .handle("decideRequest", ({ params, payload }) =>
        Effect.gen(function* () {
          const session = yield* requireEnvironmentScope(AuthRelayWriteScope);
          const id = params.id as PublicTunnelId;
          if (payload.approve) {
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const existing = yield* publicTunnels
              .get(id)
              .pipe(Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }));
            yield* requireEnvironmentScope(targetResourceScope(existing.target.kind));
          }
          return yield* publicTunnels
            .decideRequest({ ...payload, id }, session.sessionId)
            .pipe(Effect.catchTags({ PublicTunnelOperationError: mapHttpTunnelError }));
        }),
      );
  }),
);
