import * as Schema from "effect/Schema";
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  lan: Flag.Boolean("lan").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Install the background service. Use --lan for LAN access and `t3 relay link` for public HTTPS access.",
  ),
  Command.withHandler(
    Effect.fn("cli.up")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      yield* Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const before = yield* service.status;
        if (Option.isSome(flags.lan))
          yield* CliService.writeServiceEnv(config.baseDir, {
            T3CODE_LAN: String(flags.lan.value),
          });
        const changed = yield* CliService.reconcileService();
        if (!changed.changed && Option.isSome(flags.lan) && before.installed)
          yield* service.restart;
        yield* Console.log(
          "Background service ready. Run `t3 pair` for a pairing QR, or `t3 relay link https://relay-host --token TOKEN` for public HTTPS.",
        );
      }).pipe(
        Effect.provide(
          CliService.layer(config).pipe(Layer.provideMerge(ServerConfig.layer(config))),
        ),
      );
    }),
  ),
);
export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Show the background service status. Use `t3 relay status` for relay exposure.",
  ),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const status = yield* Effect.flatMap(
        BootService.BootService,
        (service) => service.status,
      ).pipe(Effect.provide(CliService.layer(config)));
      yield* Console.log(
        flags.json
          ? encodeStatus(status)
          : `Service: ${status.installed ? "installed" : "not installed"}\nRelay: t3 relay status`,
      );
    }),
  ),
);
