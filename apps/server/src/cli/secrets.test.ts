import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { keychainSecrets, memoryKeychainStore } from "@t3tools/shared/credentialKeychain";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import { type KeychainLoader, makeSecretsCommand } from "./secrets.ts";

const encode = (value: string) => new TextEncoder().encode(value);

const runMigrate = (loadKeychain: KeychainLoader, env: Record<string, string> = {}) =>
  Command.runWith(makeSecretsCommand(loadKeychain), { version: packageJson.version })([
    "migrate-keychain",
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        TestConsole.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

describe("p0 secrets migrate-keychain", () => {
  it.effect("moves every secret out of the old service and reports the count", () =>
    Effect.gen(function* () {
      const legacy = memoryKeychainStore();
      yield* Effect.promise(() =>
        keychainSecrets(legacy, "ns").set("server-signing-key", encode("signing")),
      );
      const store = memoryKeychainStore({ legacy });

      yield* runMigrate(() => store);

      assert.deepEqual([...store.entries.keys()], ["ns:server-signing-key"]);
      assert.deepEqual([...legacy.entries.keys()], []);
      const lines = (yield* TestConsole.logLines).map(String);
      assert.isTrue(lines.some((line) => line.includes("Moved 1 secret")));
    }),
  );

  it.effect("refuses to run when this home keeps credentials in files", () =>
    Effect.gen(function* () {
      const store = memoryKeychainStore();

      const error = yield* runMigrate(() => store, { P0CODE_SECRET_BACKEND: "file" }).pipe(
        Effect.flip,
      );

      assert.instanceOf(error, CliError.UserError);
      assert.include(error.message, "nothing to move");
    }),
  );
});
