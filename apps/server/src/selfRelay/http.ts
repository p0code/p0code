import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayConfigureScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { failEnvironmentInternal, requireEnvironmentScope } from "../auth/http.ts";
import * as SelfRelay from "./SelfRelay.ts";
const failure = (error: SelfRelay.SelfRelayError) =>
  failEnvironmentInternal("internal_error", error);
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "selfRelay",
  Effect.fnUntraced(function* (handlers) {
    const relay = yield* SelfRelay.SelfRelay;
    return handlers
      .handle("status", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(Effect.andThen(relay.status)),
      )
      .handle("link", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* requireEnvironmentScope(AuthRelayConfigureScope);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relay.link(payload).pipe(Effect.catchTags({ SelfRelayError: failure }));
        }),
      )
      .handle("unlink", () =>
        requireEnvironmentScope(AuthRelayConfigureScope).pipe(
          Effect.andThen(requireEnvironmentScope(AuthAccessWriteScope)),
          Effect.andThen(requireEnvironmentScope(AuthRelayWriteScope)),
          Effect.andThen(relay.unlink()),
          Effect.catchTags({ SelfRelayError: failure }),
        ),
      )
      .handle("exposePort", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* requireEnvironmentScope(AuthTerminalOperateScope);
          return yield* relay
            .exposePort(payload)
            .pipe(Effect.catchTags({ SelfRelayError: failure }));
        }),
      )
      .handle("unexposePort", ({ payload }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(relay.unexposePort(payload.port)),
          Effect.catchTags({ SelfRelayError: failure }),
        ),
      )
      .handle("portLink", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const session = yield* requireEnvironmentScope(AuthTerminalOperateScope);
          return yield* relay
            .portLink(payload.port, session.sessionId)
            .pipe(Effect.catchTags({ SelfRelayError: failure }));
        }),
      );
  }),
);
