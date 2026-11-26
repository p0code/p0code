import {
  AuthRelayConfigureScope,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  PluginOperationError,
  WsRpcGroup,
  type PluginInstallationResult,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
export const withPlugins = Effect.fn("cli.plugin.session")(function* <A, E, R>(
  baseDir: Option.Option<string>,
  run: (client: Client) => Effect.Effect<A, E, R>,
) {
  const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel);
  return yield* Effect.gen(function* () {
    const state = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state))
      return yield* new PluginOperationError({
        pluginId: "",
        message: "Start p0code before managing plugins.",
      });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* Effect.acquireRelease(
      auth.issueSession({
        scopes: [AuthRelayConfigureScope],
        subject: "cli",
        label: "p0 plugin cli",
        ttl: Duration.minutes(5),
      }),
      (value) => auth.revokeSession(value.sessionId).pipe(Effect.ignore),
    );
    const url = new URL("/ws", state.value.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const protocol = RpcClient.layerProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Layer.provide(
        Socket.layerWebSocket(url.href, { openTimeout: "10 seconds" }).pipe(
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor, (address, protocols) => {
              // Node's constructor accepts headers so the session token never enters a URL or log.
              return new NodeWebSocket(address, protocols as string | string[] | undefined, {
                headers: { authorization: `Bearer ${session.token}` },
              }) as unknown as globalThis.WebSocket;
            }),
          ),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    return yield* makeClient.pipe(Effect.flatMap(run), Effect.provide(protocol));
  }).pipe(
    Effect.scoped,
    Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
});
import { WebSocket as NodeWebSocket } from "@effect/platform-node/NodeWS";

const disclose = (result: PluginInstallationResult) =>
  Console.log(
    `${result.record.id} ${result.manifest?.version ?? ""} staged.\nCapabilities: ${result.manifest?.capabilities.join(", ") || "none"}\nExternal services: ${result.manifest?.externalServices.join(", ") || "none"}\nPlugins run inside the p0code server process with the same rights as your user account: your files, your network, your credentials. Capabilities are declarations, and only some are enforced; installing is trusting.`,
  );
const consent = Effect.fn("cli.plugin.consent")(function* (
  client: Client,
  result: PluginInstallationResult,
  yes: boolean,
) {
  yield* disclose(result);
  if (!yes && !(process.stdin.isTTY && process.stdout.isTTY))
    return yield* new PluginOperationError({
      pluginId: result.record.id,
      message: "Non-interactive plugin installs require --yes. Left staged, inactive.",
    });
  const accepted =
    yes ||
    (yield* Prompt.run(
      Prompt.Confirm({
        message: "Trust and activate this version (it stays disabled)?",
        initial: false,
      }),
    ));
  if (!accepted || !result.manifest) {
    yield* Console.log("Left staged, inactive.");
    return;
  }
  yield* client["plugins.consent"]({
    id: result.record.id,
    version: result.manifest.version,
    capabilities: result.manifest.capabilities,
  });
  yield* Console.log(
    `${result.record.id} ${result.manifest.version} activated, disabled. Enable it in Plugins settings.`,
  );
});
const requireInteractiveConsent = (yes: boolean) =>
  yes || (process.stdin.isTTY && process.stdout.isTTY)
    ? Effect.void
    : Effect.fail(
        new PluginOperationError({
          pluginId: "",
          message: "Non-interactive plugin installs require --yes.",
        }),
      );
const flags = { baseDir: baseDirFlag };
const yesFlag = Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false));
const idArgument = Argument.String("id");
const add = Command.make("add", {
  ...flags,
  source: Argument.String("dir-or-catalog-id"),
  yes: yesFlag,
}).pipe(
  Command.withHandler((input) =>
    withPlugins(input.baseDir, (client) =>
      Effect.gen(function* () {
        yield* requireInteractiveConsent(input.yes);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const local = yield* fs.stat(input.source).pipe(
          Effect.map((stat) => stat.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        const source =
          local || input.source.includes("/") || input.source.startsWith(".")
            ? path.resolve(input.source)
            : input.source;
        yield* consent(client, yield* client["plugins.install"]({ source }), input.yes);
      }),
    ),
  ),
);
const update = Command.make("update", {
  ...flags,
  id: idArgument,
  source: Argument.String("dir").pipe(Argument.optional),
  yes: yesFlag,
}).pipe(
  Command.withHandler((input) =>
    withPlugins(input.baseDir, (client) =>
      Effect.gen(function* () {
        yield* requireInteractiveConsent(input.yes);
        const path = yield* Path.Path;
        const source = Option.getOrUndefined(input.source);
        yield* consent(
          client,
          yield* client["plugins.update"]({
            id: input.id,
            ...(source === undefined ? {} : { source: path.resolve(source) }),
          }),
          input.yes,
        );
      }),
    ),
  ),
);
const remove = Command.make("remove", {
  ...flags,
  id: idArgument,
  purgeData: Flag.Boolean("purge-data").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((input) =>
    withPlugins(input.baseDir, (client) =>
      client["plugins.remove"]({ id: input.id, purgeData: input.purgeData }).pipe(
        Effect.andThen(
          Console.log(`${input.id} removed; data ${input.purgeData ? "purged" : "retained"}.`),
        ),
      ),
    ),
  ),
);
const rollback = Command.make("rollback", { ...flags, id: idArgument }).pipe(
  Command.withHandler((input) =>
    withPlugins(input.baseDir, (client) =>
      client["plugins.rollback"]({ id: input.id }).pipe(
        Effect.flatMap((result) =>
          Console.log(`${input.id} restored to ${result.record.activeVersion}, disabled.`),
        ),
      ),
    ),
  ),
);
const list = Command.make("list", flags).pipe(
  Command.withHandler((input) =>
    withPlugins(input.baseDir, (client) =>
      client["plugins.installedList"]({}).pipe(
        Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
      ),
    ),
  ),
);
export const pluginCommand = Command.make("plugin").pipe(
  Command.withDescription("Install and manage trusted server plugins."),
  Command.withSubcommands([add, update, remove, rollback, list]),
);
