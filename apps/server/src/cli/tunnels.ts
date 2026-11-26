import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type PublicTunnelId,
  PublicTunnelOperationError,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SelfRelay from "../selfRelay/SelfRelay.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PublicTunnels from "../tunnels/PublicTunnels.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const withPublicTunnels = Effect.fn("tunnels.withPublicTunnels")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  use: (tunnels: PublicTunnels.PublicTunnels["Service"]) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });

  const cliLayer = Layer.mergeAll(
    PublicTunnels.layer.pipe(
      Layer.provide(
        ServerSettings.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSecretStore.layer,
              SqlitePersistence.layerCliConfig,
              ManagedPolicy.layer,
              FetchHttpClient.layer,
            ),
          ),
        ),
      ),
      Layer.provide(
        SelfRelay.layer.pipe(
          Layer.provide(ManagedPolicy.layer),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Layer.provide(SqlitePersistence.layerCliConfig),
      Layer.provide(ManagedPolicy.layer),
      Layer.provide(ServerSecretStore.layer),
    ),
    EnvironmentAuth.layerRuntime,
  ).pipe(
    Layer.provideMerge(
      ServerSettings.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerCliConfig,
            ManagedPolicy.layer,
          ),
        ),
      ),
    ),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );

  return yield* PublicTunnels.PublicTunnels.pipe(
    Effect.flatMap(use),
    Effect.catchIf(Schema.is(PublicTunnelOperationError), (error) =>
      Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
    ),
    Effect.provide(cliLayer),
  );
});

export const tunnelsCommand = Command.make("tunnels").pipe(
  Command.withDescription("Inspect and stop public tunnels on this environment."),
  Command.withSubcommands([
    Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
      Command.withDescription("List public tunnels and relay readiness."),
      Command.withHandler((flags) =>
        withPublicTunnels(flags, (tunnels) =>
          RunningServer.changeState({
            scopes: [AuthRelayReadScope],
            viaServer: (client) => client.tunnels.list({ headers: {} }),
            locally: tunnels.list(),
          }).pipe(
            Effect.flatMap((result) => {
              if (flags.json) {
                return Console.log(JSON.stringify(result, null, 2));
              }
              if (result.tunnels.length === 0) {
                return Console.log(`No public tunnels (${result.linkState.availability}).`);
              }
              return Effect.forEach(
                result.tunnels,
                (tunnel) =>
                  Console.log(
                    `${tunnel.id}  ${tunnel.status}  ${tunnel.routing}  ${tunnel.target.kind}  ${tunnel.url ?? "(offline)"}  ${tunnel.title}`,
                  ),
                { discard: true },
              );
            }),
          ),
        ),
      ),
    ),
    Command.make("stop", {
      ...authLocationFlags,
      id: Argument.String("id").pipe(Argument.withDescription("Tunnel ID to stop and remove.")),
    }).pipe(
      Command.withDescription("Stop and remove a single public tunnel."),
      Command.withHandler((flags) =>
        withPublicTunnels(flags, (tunnels) =>
          RunningServer.changeState({
            scopes: [AuthRelayWriteScope],
            viaServer: (client) =>
              client.tunnels.remove({ headers: {}, params: { id: flags.id as PublicTunnelId } }),
            locally: tunnels.remove(flags.id as PublicTunnelId),
          }).pipe(Effect.andThen(Console.log(`Stopped ${flags.id}.`))),
        ),
      ),
    ),
    Command.make("stop-all", { ...authLocationFlags, json: jsonFlag }).pipe(
      Command.withDescription("Emergency stop: close and remove all public tunnels immediately."),
      Command.withHandler((flags) =>
        withPublicTunnels(flags, (tunnels) =>
          RunningServer.changeState({
            scopes: [AuthRelayWriteScope],
            viaServer: (client) => client.tunnels.stopAll({ headers: {} }),
            locally: tunnels.stopAll(),
          }).pipe(
            Effect.flatMap((result) =>
              Console.log(
                flags.json
                  ? JSON.stringify(result, null, 2)
                  : `Stopped ${result.stoppedCount} tunnel(s).`,
              ),
            ),
          ),
        ),
      ),
    ),
  ]),
);
