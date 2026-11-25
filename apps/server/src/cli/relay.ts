import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Terminal from "effect/Terminal";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  AuthAccessWriteScope,
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
} from "@t3tools/contracts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RunningServer from "./runningServer.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as SelfRelay from "../selfRelay/SelfRelay.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class RelayTokenInputError extends Schema.TaggedError<RelayTokenInputError>()(
  "RelayTokenInputError",
  { message: Schema.String },
) {}

const withRelay = Effect.fn("relay.withRelay")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  use: (relay: SelfRelay.SelfRelay["Service"]) => Effect.Effect<A, E, R>,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* SelfRelay.SelfRelay.pipe(
    Effect.flatMap(use),
    Effect.provide(
      Layer.mergeAll(
        SelfRelay.layer.pipe(
          Layer.provide(ManagedPolicy.layer),
          Layer.provide(ServerSecretStore.layer),
        ),
        EnvironmentAuth.layerRuntime,
      ).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(ServerConfig.layer(config)),
      ),
    ),
  );
});
export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Link this environment to an end-to-end encrypted, self-hosted relay."),
  Command.withSubcommands([
    Command.make("link", {
      ...authLocationFlags,
      relayUrl: Argument.String("relay-url"),
      token: Flag.String("token").pipe(Flag.optional),
      tokenStdin: Flag.Boolean("token-stdin"),
    }).pipe(
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const terminal = yield* Terminal.Terminal;
          const environmentToken = yield* Config.String("T3CODE_RELAY_ENROLLMENT_TOKEN").pipe(
            Config.option,
          );
          const token = flags.tokenStdin
            ? yield* terminal.readLine
            : Option.isSome(flags.token)
              ? flags.token.value
              : Option.isSome(environmentToken)
                ? environmentToken.value
                : NodeProcess.stdin.isTTY
                  ? Redacted.value(
                      yield* Prompt.run(Prompt.Password({ message: "Relay enrollment token" })),
                    )
                  : yield* new RelayTokenInputError({
                      message: "Supply --token-stdin or T3CODE_RELAY_ENROLLMENT_TOKEN.",
                    });
          if (!token.trim())
            return yield* new RelayTokenInputError({ message: "Enrollment token is empty." });
          const input = { relayUrl: flags.relayUrl, token: token.trim() };
          return yield* withRelay(flags, (relay) =>
            RunningServer.changeState({
              scopes: [AuthAccessWriteScope, AuthRelayWriteScope, AuthRelayConfigureScope],
              viaServer: (client) => client.selfRelay.link({ headers: {}, payload: input }),
              locally: relay.link(input),
            }).pipe(Effect.flatMap((state) => Console.log(state.publicOrigin))),
          );
        }),
      ),
    ),
    Command.make("status", authLocationFlags).pipe(
      Command.withHandler((flags) =>
        withRelay(flags, (relay) =>
          RunningServer.changeState({
            scopes: [AuthRelayReadScope],
            viaServer: (client) => client.selfRelay.status({ headers: {} }),
            locally: relay.status,
          }).pipe(Effect.flatMap((state) => Console.log(JSON.stringify(state, null, 2)))),
        ),
      ),
    ),
    Command.make("unlink", authLocationFlags).pipe(
      Command.withHandler((flags) =>
        withRelay(flags, (relay) =>
          RunningServer.changeState({
            scopes: [AuthAccessWriteScope, AuthRelayWriteScope, AuthRelayConfigureScope],
            viaServer: (client) => client.selfRelay.unlink({ headers: {} }),
            locally: relay.unlink(),
          }).pipe(
            Effect.andThen(
              Console.log(
                "Relay unlinked. Existing environment sessions remain revocable in Sharing & access.",
              ),
            ),
          ),
        ),
      ),
    ),
  ]),
);
