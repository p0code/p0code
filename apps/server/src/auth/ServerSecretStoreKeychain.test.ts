import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  credentialNamespace,
  KEYCHAIN_MARKER_FILE,
  keychainSecrets,
  type KeychainStore,
  memoryKeychainStore,
} from "@t3tools/shared/credentialKeychain";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Builds the store over a fresh home, after `prepare` has seeded its secrets folder. */
const withStore = <A, E, E2 = never>(
  keychain: KeychainStore | "unavailable",
  use: (
    store: ServerSecretStore.ServerSecretStore["Service"],
    secretsDir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: {
    readonly env?: Record<string, string>;
    readonly prepare?: (
      secretsDir: string,
    ) => Effect.Effect<void, E2, FileSystem.FileSystem | Path.Path>;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
    if (options.prepare) yield* Effect.orDie(options.prepare(config.secretsDir));
    const store = yield* ServerSecretStore.makeWith(() => {
      if (keychain === "unavailable") throw new Error("no keychain here");
      return keychain;
    });
    return yield* use(store, config.secretsDir);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-keychain-test-" }),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })),
      ),
    ),
  );

const files = (directory: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readDirectory(directory));

const writeSecretFile = (directory: string, name: string, value: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(directory, name), value);
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "ServerSecretStore keychain",
  (it) => {
    it.effect("keeps credentials in the keychain and replay markers as files", () => {
      const keychain = memoryKeychainStore();
      return withStore(keychain, (store, secretsDir) =>
        Effect.gen(function* () {
          assert.deepEqual(store.storage, { backend: "keychain", label: "Test keychain" });
          yield* store.set("server-signing-key", encode("signing"));
          yield* store.set("an-unknown-future-credential", encode("unknown"));
          yield* store.create("dpop-proof-abc", encode("marker"));

          assert.equal(
            decode(Option.getOrThrow(yield* store.get("server-signing-key"))),
            "signing",
          );
          const names = yield* files(secretsDir);
          assert.include(names, "dpop-proof-abc.bin");
          assert.include(names, KEYCHAIN_MARKER_FILE);
          assert.notInclude(names, "server-signing-key.bin");
          assert.notInclude(names, "an-unknown-future-credential.bin");
          const accounts = [...keychain.entries.keys()];
          assert.isTrue(accounts.some((account) => account.endsWith(":server-signing-key")));
          assert.isFalse(accounts.some((account) => account.includes("dpop-proof")));

          yield* store.remove("server-signing-key");
          assert.isTrue(Option.isNone(yield* store.get("server-signing-key")));
        }),
      );
    });

    it.effect("create fails on an existing credential and racing creators agree", () =>
      withStore(memoryKeychainStore(), (store) =>
        Effect.gen(function* () {
          yield* store.create("secret-request-0", encode("first"));
          const error = yield* Effect.flip(store.create("secret-request-0", encode("second")));
          assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
          assert.equal(decode(Option.getOrThrow(yield* store.get("secret-request-0"))), "first");

          const results = yield* Effect.all(
            Array.from({ length: 8 }, () => store.getOrCreateRandom("mcp-oauth-signing-key", 32)),
            { concurrency: "unbounded" },
          );
          const stored = Array.from(Option.getOrThrow(yield* store.get("mcp-oauth-signing-key")));
          for (const result of results) assert.deepEqual(Array.from(result), stored);
        }),
      ),
    );

    it.effect("lists names from both the keychain and files", () =>
      withStore(memoryKeychainStore(), (store) =>
        Effect.gen(function* () {
          yield* store.set("secret-request-a", encode("a"));
          yield* store.create("dpop-proof-b", encode("b"));
          yield* store.set("other", encode("c"));
          assert.deepEqual([...(yield* store.list!("secret-request-"))], ["secret-request-a"]);
          assert.deepEqual([...(yield* store.list!("dpop-proof-"))], ["dpop-proof-b"]);
        }),
      ),
    );

    it.effect("stores values larger than one Windows credential across chunks", () => {
      const keychain = memoryKeychainStore();
      const large = Uint8Array.from({ length: 6000 }, (_, index) => index % 251);
      return withStore(keychain, (store) =>
        Effect.gen(function* () {
          yield* store.set("provider-auth-large", large);
          assert.isAbove(keychain.entries.size, 2);
          for (const value of keychain.entries.values()) assert.isAtMost(value.length, 1000);
          assert.deepEqual(
            Array.from(Option.getOrThrow(yield* store.get("provider-auth-large"))),
            Array.from(large),
          );
          yield* store.set("provider-auth-large", encode("small"));
          // Only the new head remains; the old chunks are gone.
          assert.equal(
            [...keychain.entries.keys()].filter((account) =>
              account.includes("provider-auth-large"),
            ).length,
            1,
          );
        }),
      );
    });

    it.effect("moves credential files into the keychain on first start", () => {
      const keychain = memoryKeychainStore();
      return withStore(
        keychain,
        (store, secretsDir) =>
          Effect.gen(function* () {
            assert.equal(decode(Option.getOrThrow(yield* store.get("server-signing-key"))), "old");
            assert.equal(decode(Option.getOrThrow(yield* store.get("peer-link-1"))), "peer");
            const names = yield* files(secretsDir);
            assert.deepEqual(names.toSorted(), [
              "cloud-mint-jti-1.bin",
              "dpop-proof-1.bin",
              KEYCHAIN_MARKER_FILE,
            ]);
          }),
        {
          prepare: (secretsDir) =>
            Effect.gen(function* () {
              yield* writeSecretFile(secretsDir, "server-signing-key.bin", "old");
              yield* writeSecretFile(secretsDir, "peer-link-1.bin", "peer");
              yield* writeSecretFile(secretsDir, "peer-link-1.bin.1234-abcd.tmp", "partial");
              yield* writeSecretFile(secretsDir, "dpop-proof-1.bin", "marker");
              yield* writeSecretFile(secretsDir, "cloud-mint-jti-1.bin", "marker");
            }),
        },
      );
    });

    it.effect("moves a credential from the old keychain service on its first read", () => {
      const legacy = memoryKeychainStore();
      const keychain = memoryKeychainStore({ legacy });
      return withStore(
        keychain,
        (store) =>
          Effect.gen(function* () {
            assert.equal(
              decode(Option.getOrThrow(yield* store.get("server-signing-key"))),
              "old-key",
            );
            assert.equal(
              decode(Option.getOrThrow(yield* store.get("server-signing-key"))),
              "old-key",
            );
            assert.equal(legacy.entries.size, 0);
            assert.isTrue(
              [...keychain.entries.keys()].some((account) =>
                account.endsWith(":server-signing-key"),
              ),
            );
          }),
        {
          prepare: (secretsDir) =>
            Effect.promise(async () => {
              const namespace = await credentialNamespace(secretsDir);
              await keychainSecrets(legacy, namespace).set("server-signing-key", encode("old-key"));
            }),
        },
      );
    });

    it.effect("finishes a move interrupted between the keychain write and the file delete", () => {
      const keychain = memoryKeychainStore();
      return withStore(
        keychain,
        (store, secretsDir) =>
          Effect.gen(function* () {
            assert.equal(
              decode(Option.getOrThrow(yield* store.get("guest-share-signing-key"))),
              "g",
            );
            // The keychain already won for the conflicting name.
            assert.equal(decode(Option.getOrThrow(yield* store.get("server-signing-key"))), "new");
            assert.deepEqual(yield* files(secretsDir), [KEYCHAIN_MARKER_FILE]);
          }),
        {
          prepare: (secretsDir) =>
            Effect.gen(function* () {
              const secrets = keychainSecrets(
                keychain,
                yield* Effect.promise(() => credentialNamespace(secretsDir)),
              );
              yield* Effect.promise(() => secrets.set("guest-share-signing-key", encode("g")));
              yield* Effect.promise(() => secrets.set("server-signing-key", encode("new")));
              yield* writeSecretFile(secretsDir, "guest-share-signing-key.bin", "g");
              yield* writeSecretFile(secretsDir, "server-signing-key.bin", "stale");
            }),
        },
      );
    });

    it.effect("keeps a file that the keychain does not return intact", () => {
      const keychain = memoryKeychainStore();
      const forgetful: KeychainStore = {
        ...keychain,
        set: async (account, value) => {
          await keychain.set(account, account.endsWith(":server-signing-key") ? "b:" : value);
        },
      };
      return withStore(forgetful, () => Effect.void, {
        prepare: (secretsDir) => writeSecretFile(secretsDir, "server-signing-key.bin", "keep me"),
      }).pipe(
        Effect.flip,
        Effect.map((error) => assert.equal(error._tag, "SecretStoreBackendError")),
      );
    });

    it.effect("falls back to files when no keychain is available", () =>
      withStore("unavailable", (store, secretsDir) =>
        Effect.gen(function* () {
          assert.deepEqual(store.storage, {
            backend: "file",
            label: "files (no keychain available)",
          });
          yield* store.set("server-signing-key", encode("file"));
          assert.include(yield* files(secretsDir), "server-signing-key.bin");
        }),
      ),
    );

    it.effect("refuses to start without the keychain a home already uses", () =>
      withStore("unavailable", () => Effect.void, {
        prepare: (secretsDir) =>
          writeSecretFile(secretsDir, KEYCHAIN_MARKER_FILE, "macOS Keychain"),
      }).pipe(
        Effect.flip,
        Effect.map((error) => assert.equal(error._tag, "SecretStoreBackendError")),
      ),
    );

    it.effect("honors P0CODE_SECRET_BACKEND", () => {
      const keychain = memoryKeychainStore();
      return Effect.gen(function* () {
        yield* withStore(
          keychain,
          (store, secretsDir) =>
            Effect.gen(function* () {
              assert.equal(store.storage?.backend, "file");
              yield* store.set("server-signing-key", encode("file"));
              assert.include(yield* files(secretsDir), "server-signing-key.bin");
              assert.equal(keychain.entries.size, 0);
            }),
          { env: { P0CODE_SECRET_BACKEND: "file" } },
        );
        const required = yield* withStore("unavailable", () => Effect.void, {
          env: { P0CODE_SECRET_BACKEND: "keychain" },
        }).pipe(Effect.flip);
        assert.equal(required._tag, "SecretStoreBackendError");
        const invalid = yield* withStore(keychain, () => Effect.void, {
          env: { P0CODE_SECRET_BACKEND: "vault" },
        }).pipe(Effect.flip);
        assert.equal(invalid._tag, "SecretStoreBackendError");
      });
    });

    it.effect("the default layer never opens the OS keychain under test", () =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        assert.equal(store.storage?.backend, "file");
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-keychain-test-" }),
            ),
          ),
        ),
      ),
    );

    it.effect("keeps homes apart in one keychain", () => {
      const keychain = memoryKeychainStore();
      return Effect.gen(function* () {
        yield* withStore(keychain, (store) => store.set("server-signing-key", encode("one")));
        yield* withStore(keychain, (store) =>
          Effect.map(store.get("server-signing-key"), (value) =>
            assert.isTrue(Option.isNone(value)),
          ),
        );
      });
    });
  },
);
