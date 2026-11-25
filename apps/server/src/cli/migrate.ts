import { AppHomeConfig, STOCK_T3_HOME_DIRECTORY_NAME } from "@t3tools/shared/appHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  formatMigrationReport,
  formatMigrationReportJson,
  migrateFromT3,
} from "@t3tools/shared/migrateFromT3";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as CliError from "effect/cli/CliError";
import { Command, Flag } from "effect/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { resolveT3ImportKeychain } from "../t3Import.ts";

const fromT3Command = Command.make("from-t3", {
  from: Flag.String("from").pipe(
    Flag.withDescription(
      "Stock p0code home to import from. Default: ~/.t3. Only read, never changed.",
    ),
    Flag.optional,
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription("p0code home to create. Default: P0CODE_HOME or ~/.p0code."),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show what would be imported without writing anything."),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription(
      "Import even if the destination has data; the old destination is moved aside, not deleted.",
    ),
    Flag.withDefault(false),
  ),
  keepEnvironmentId: Flag.Boolean("keep-environment-id").pipe(
    Flag.withDescription(
      "Keep the p0code environment id and signing keys so paired clients keep working. Then never run both apps at once.",
    ),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit the report as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Import settings, threads, providers and secrets from a stock p0code home into this p0code home.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const from = Option.isSome(flags.from)
        ? path.resolve(yield* expandHomePath(flags.from.value))
        : path.join(home, STOCK_T3_HOME_DIRECTORY_NAME);
      const to = yield* resolveBaseDir(
        Option.getOrUndefined(flags.to) ?? Option.getOrUndefined(yield* AppHomeConfig),
      );
      const backendSetting = yield* Config.String("P0CODE_SECRET_BACKEND").pipe(
        Config.option,
        Effect.map(Option.map((value) => value.trim().toLowerCase())),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const requestedBackend = Option.getOrElse(backendSetting, () => "auto");
      const platform = yield* HostProcess.Platform;
      const report = yield* Effect.tryPromise({
        try: async () => {
          const keychain = await resolveT3ImportKeychain({
            to,
            dryRun: flags.dryRun === true,
            requested: requestedBackend,
            platform,
          });
          return migrateFromT3({
            from,
            to,
            dryRun: flags.dryRun,
            force: flags.force,
            keepEnvironmentId: flags.keepEnvironmentId,
            keychain,
          });
        },
        catch: (cause) =>
          new CliError.UserError({
            cause: cause instanceof Error ? cause.message : cause,
          }),
      });
      yield* Console.log(
        flags.json ? formatMigrationReportJson(report) : formatMigrationReport(report),
      );
    }).pipe(Effect.withSpan("cli.migrate.fromT3")),
  ),
);

export const migrateCommand = Command.make("migrate").pipe(
  Command.withDescription("Import data from other installs."),
  Command.withSubcommands([fromT3Command]),
);
