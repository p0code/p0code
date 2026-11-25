// @effect-diagnostics nodeBuiltinImport:off -- The keychain binding is a native module loaded on demand.
import * as NodeModule from "node:module";

import {
  type KeychainStore,
  keyringStore,
  migrateKeychainService,
} from "@t3tools/shared/credentialKeychain";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import { Command } from "effect/cli";

const requireExternal = NodeModule.createRequire(import.meta.url);

/** Loads the OS keychain; tests pass a fake so they never touch the user's. */
export type KeychainLoader = (platform: NodeJS.Platform) => KeychainStore;

const loadSystemKeychain: KeychainLoader = (platform) => {
  const keyring: typeof import("@napi-rs/keyring") = requireExternal("@napi-rs/keyring");
  return keyringStore(keyring, platform);
};

const secretBackend = Config.String("P0CODE_SECRET_BACKEND").pipe(
  Config.orElse(() => Config.String("HHHCODE_SECRET_BACKEND")),
  Config.map((value) => value.trim().toLowerCase() || "file"),
  Config.withDefault("file"),
);

const runMigrateKeychain = Effect.fn("cli.secrets.migrateKeychain")(function* (
  loadKeychain: KeychainLoader,
) {
  const backend = yield* secretBackend;
  if (backend !== "auto" && backend !== "keychain" && backend !== "file") {
    return yield* new CliError.UserError({
      cause: `P0CODE_SECRET_BACKEND=${backend}`,
      userMessage: `P0CODE_SECRET_BACKEND must be "keychain" or "file", got "${backend}".`,
    });
  }
  if (backend !== "keychain") {
    return yield* new CliError.UserError({
      cause: `P0CODE_SECRET_BACKEND=${backend}`,
      userMessage:
        "This home keeps credentials as files, not in the OS keychain, so there is nothing to move. Set P0CODE_SECRET_BACKEND=keychain to manage the old keychain service instead.",
    });
  }

  const platform = yield* HostProcess.Platform;
  const report = yield* Effect.tryPromise({
    try: () => migrateKeychainService(loadKeychain(platform)),
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage:
          "Could not open the OS keychain. Unlock it (or start the Secret Service on Linux) and run `p0 secrets migrate-keychain` again.",
      }),
  });

  yield* Console.log(
    `Moved ${report.moved.length} secret(s) from the old keychain service to p0code.`,
  );
  if (report.alreadyPresent.length > 0) {
    yield* Console.log(
      `Removed ${report.alreadyPresent.length} old copy/copies of secrets already stored under p0code.`,
    );
  }
  if (report.leftBehind.length > 0) {
    yield* Console.warn(
      `${report.leftBehind.length} old copy/copies could not be deleted; the secrets are safe under p0code and can be removed from the old service in the OS keychain.`,
    );
  }
  if (report.failed.length > 0) {
    return yield* new CliError.UserError({
      cause: report,
      userMessage: `${report.failed.length} secret(s) could not be moved and are still readable from the old keychain service. Unlock the keychain and run \`p0 secrets migrate-keychain\` again.`,
    });
  }
});

export const makeSecretsCommand = (loadKeychain: KeychainLoader = loadSystemKeychain) =>
  Command.make("secrets").pipe(
    Command.withDescription("Inspect and repair the credentials p0code stores."),
    Command.withSubcommands([
      Command.make("migrate-keychain").pipe(
        Command.withDescription(
          "Move credentials stored under the old keychain service name to p0code, then delete the old copies.",
        ),
        Command.withHandler(() => runMigrateKeychain(loadKeychain)),
      ),
    ]),
  );

export const secretsCommand = makeSecretsCommand();
