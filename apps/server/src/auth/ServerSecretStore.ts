// @effect-diagnostics nodeBuiltinImport:off -- The keychain binding is a native module loaded on demand.
import * as NodeModule from "node:module";
import {
  classifySecret,
  credentialNamespace,
  importCredentialFiles,
  KEYCHAIN_MARKER_FILE,
  keychainSecrets,
  type KeychainSecrets,
  type KeychainStore,
  keyringStore,
} from "@t3tools/shared/credentialKeychain";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { lock } from "proper-lockfile";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreNameError extends Schema.TaggedError<SecretStoreNameError>()(
  "SecretStoreNameError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Refused ${this.resource}: a secret name cannot contain a path separator.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreNameError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

/** The server cannot reach the credential storage this home needs. Fails startup. */
export class SecretStoreBackendError extends Schema.TaggedError<SecretStoreBackendError>()(
  "SecretStoreBackendError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface SecretStorageStatus {
  readonly backend: "keychain" | "file";
  /** e.g. "macOS Keychain", or why credentials are files. */
  readonly label: string;
}

const alreadyExists = (name: string) =>
  new SecretStorePersistError({
    resource: `secret ${name}`,
    cause: PlatformError.systemError({
      _tag: "AlreadyExists",
      module: "ServerSecretStore",
      method: "create",
      description: "The secret already exists.",
    }),
  });

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
    /** Names starting with `prefix`, wherever they are stored. */
    readonly list?: (prefix: string) => Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
    readonly storage?: SecretStorageStatus;
  }
>()("t3/auth/ServerSecretStore") {}

// A single-executable server resolves packages on disk only through `require`.
const requireExternal = NodeModule.createRequire(import.meta.url);

/** Loads the OS keychain; throws where it cannot be used. */
export type KeychainLoader = (platform: NodeJS.Platform) => KeychainStore;

const loadSystemKeychain: KeychainLoader = (platform) => {
  // Tests get an in-memory keychain from `layerWithKeychain`; never the user's real one.
  if (process.env.VITEST) throw new Error("tests never use the OS keychain");
  const keyring: typeof import("@napi-rs/keyring") = requireExternal("@napi-rs/keyring");
  return keyringStore(keyring, platform);
};

const SecretBackendSetting = Config.String("P0CODE_SECRET_BACKEND").pipe(
  Config.orElse(() => Config.String("HHHCODE_SECRET_BACKEND")),
  Config.option,
);

export const makeWith = Effect.fn("ServerSecretStore.makeWith")(function* (
  loadKeychain: KeychainLoader,
) {
  const crypto = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  // Some names carry text from outside the server; one with a separator would leave the directory.
  const resolveSecretPath = (name: string): Effect.Effect<string, SecretStoreNameError> =>
    /[/\\\0]/.test(name)
      ? Effect.fail(new SecretStoreNameError({ resource: `secret ${JSON.stringify(name)}` }))
      : Effect.succeed(path.join(serverConfig.secretsDir, `${name}.bin`));
  const emptySecretRepair = yield* Semaphore.make(1);

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    resolveSecretPath(name).pipe(
      Effect.flatMap((secretPath) =>
        fileSystem.readFile(secretPath).pipe(
          Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeedNone
              : Effect.fail(
                  new SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
          ),
        ),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );

  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    resolveSecretPath(name).pipe(
      Effect.flatMap((secretPath) => setAt(name, secretPath, value)),
      Effect.withSpan("ServerSecretStore.set"),
    );

  const setAt = (name: string, secretPath: string, value: Uint8Array) =>
    crypto.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
      Effect.flatMap((uuid) => {
        const tempPath = `${secretPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* fileSystem.writeFile(tempPath, value);
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.rename(tempPath, secretPath);
          yield* fileSystem.chmod(secretPath, 0o600);
        }).pipe(
          Effect.catch((cause) =>
            fileSystem.remove(tempPath).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    );

  // `link` publishes the fully written temp file under the final name, or fails with
  // AlreadyExists, so a concurrent reader never observes a partially written secret.
  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    resolveSecretPath(name).pipe(Effect.flatMap((secretPath) => createAt(name, secretPath, value)));

  const createAt = (name: string, secretPath: string, value: Uint8Array) =>
    crypto.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
      Effect.flatMap((uuid) => {
        const tempPath = `${secretPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(value);
              yield* file.sync;
            }),
          );
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.link(tempPath, secretPath);
        }).pipe(
          Effect.ensuring(fileSystem.remove(tempPath).pipe(Effect.ignore)),
          Effect.mapError(
            (cause) =>
              new SecretStorePersistError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
        );
      }),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    resolveSecretPath(name).pipe(
      Effect.flatMap((secretPath) =>
        fileSystem.remove(secretPath).pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.void
              : Effect.fail(
                  new SecretStoreRemoveError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
          ),
        ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  const listFiles = (prefix: string) =>
    fileSystem.readDirectory(serverConfig.secretsDir).pipe(
      Effect.map((files) =>
        files.flatMap((file) =>
          file.endsWith(".bin") && file.startsWith(prefix) ? [file.slice(0, -".bin".length)] : [],
        ),
      ),
      Effect.mapError(
        (cause) => new SecretStoreReadError({ resource: `secrets ${prefix}*`, cause }),
      ),
    );

  const fileStore = { get, set, create, remove, list: listFiles };
  const { keychain, storage } = yield* resolveKeychain(loadKeychain, serverConfig.secretsDir);
  if (keychain === undefined) {
    return ServerSecretStore.of({
      directory: serverConfig.secretsDir,
      get,
      set,
      create,
      getOrCreateRandom: makeGetOrCreateRandom(fileStore, crypto, emptySecretRepair),
      remove,
      list: listFiles,
      storage,
    });
  }

  const keychainStore = makeKeychainOperations(keychain, serverConfig.secretsDir);
  const route = (name: string) => (classifySecret(name) === "keychain" ? keychainStore : fileStore);
  const routed = {
    get: (name: string) => route(name).get(name),
    set: (name: string, value: Uint8Array) => route(name).set(name, value),
    create: (name: string, value: Uint8Array) => route(name).create(name, value),
    remove: (name: string) => route(name).remove(name),
    list: (prefix: string) =>
      Effect.all([keychainStore.list(prefix), listFiles(prefix)]).pipe(
        Effect.map(([inKeychain, inFiles]) => [...new Set([...inKeychain, ...inFiles])]),
      ),
  };
  return ServerSecretStore.of({
    directory: serverConfig.secretsDir,
    ...routed,
    getOrCreateRandom: makeGetOrCreateRandom(routed, crypto, emptySecretRepair),
    storage,
  });
});

const isMissingOrNonEmpty = (secret: Option.Option<Uint8Array>) =>
  Option.isNone(secret) || secret.value.byteLength > 0;

interface SecretOperations {
  readonly get: ServerSecretStore["Service"]["get"];
  readonly set: ServerSecretStore["Service"]["set"];
  readonly create: ServerSecretStore["Service"]["create"];
  readonly remove: ServerSecretStore["Service"]["remove"];
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
}

const resolveKeychain = Effect.fn("ServerSecretStore.resolveKeychain")(function* (
  loadKeychain: KeychainLoader,
  secretsDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const setting = yield* SecretBackendSetting.pipe(
    Effect.map(Option.map((value) => value.trim().toLowerCase())),
    Effect.mapError(
      (cause) =>
        new SecretStoreBackendError({ detail: "Could not read P0CODE_SECRET_BACKEND.", cause }),
    ),
  );
  const requested = Option.getOrElse(setting, () => "auto");
  if (requested !== "auto" && requested !== "keychain" && requested !== "file") {
    return yield* new SecretStoreBackendError({
      detail: `P0CODE_SECRET_BACKEND must be "keychain" or "file", got "${requested}".`,
      cause: undefined,
    });
  }
  const markerPath = path.join(secretsDir, KEYCHAIN_MARKER_FILE);
  const marked = yield* fileSystem.exists(markerPath).pipe(Effect.orElseSucceed(() => false));
  if (requested === "file") {
    if (marked) {
      yield* Effect.logWarning(
        "P0CODE_SECRET_BACKEND=file: credentials this home keeps in the OS keychain are not used.",
      );
    }
    return {
      keychain: undefined,
      storage: { backend: "file", label: "files (P0CODE_SECRET_BACKEND=file)" },
    } as const;
  }

  const opened = yield* Effect.tryPromise({
    try: async () => {
      const secrets = keychainSecrets(
        loadKeychain(platform),
        await credentialNamespace(secretsDir),
      );
      await secrets.probe();
      return secrets;
    },
    catch: (cause) =>
      new SecretStoreBackendError({
        detail:
          requested === "keychain"
            ? "P0CODE_SECRET_BACKEND=keychain, but the OS keychain is not available."
            : "This home keeps its credentials in the OS keychain, which is not available. Unlock it (or start the Secret Service on Linux) and start again.",
        cause,
      }),
  }).pipe(Effect.result);
  if (opened._tag === "Failure") {
    if (requested === "keychain" || marked) return yield* opened.failure;
    yield* Effect.logWarning(
      "No OS keychain is available, so credentials are stored as owner-only files. Set P0CODE_SECRET_BACKEND=file to silence this.",
      { cause: opened.failure.cause },
    );
    return {
      keychain: undefined,
      storage: { backend: "file", label: "files (no keychain available)" },
    } as const;
  }

  const keychain = opened.success;
  yield* fileSystem
    .writeFileString(markerPath, `${keychain.label}\n`, { mode: 0o600 })
    .pipe(
      Effect.mapError(
        (cause) => new SecretStoreBackendError({ detail: "Could not mark the home.", cause }),
      ),
    );
  const moved = yield* Effect.tryPromise({
    try: () => importCredentialFiles(secretsDir, keychain),
    catch: (cause) =>
      new SecretStoreBackendError({
        detail: "Could not move credential files into the OS keychain.",
        cause,
      }),
  });
  if (moved.imported.length > 0) {
    yield* Effect.logInfo("Moved credential files into the OS keychain.", {
      count: moved.imported.length,
    });
  }
  if (moved.superseded.length > 0) {
    yield* Effect.logWarning("Removed credential files the OS keychain already replaced.", {
      names: moved.superseded,
    });
  }
  return { keychain, storage: { backend: "keychain", label: keychain.label } } as const;
});

const makeKeychainOperations = (
  keychain: KeychainSecrets,
  secretsDir: string,
): SecretOperations => {
  const call = <A, E>(
    operation: () => Promise<A>,
    error: (cause: unknown) => E,
  ): Effect.Effect<A, E> => Effect.tryPromise({ try: operation, catch: error });
  const checked = <A>(
    name: string,
    use: () => Effect.Effect<A, SecretStoreError>,
  ): Effect.Effect<A, SecretStoreError> =>
    /[/\\\0]/.test(name)
      ? Effect.fail(new SecretStoreNameError({ resource: `secret ${JSON.stringify(name)}` }))
      : use();
  const get = (name: string) =>
    checked(name, () =>
      call(
        () => keychain.get(name),
        (cause) => new SecretStoreReadError({ resource: `secret ${name}`, cause }),
      ).pipe(Effect.map(Option.fromUndefinedOr)),
    );
  const set = (name: string, value: Uint8Array) =>
    checked(name, () =>
      call(
        () => keychain.set(name, value),
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
    );
  const createLock = Semaphore.makeUnsafe(1);
  // The keychain has no add-if-absent; a lock shared with other processes on this home
  // (CLI commands, a second server) makes check-then-write atomic.
  const withCreateLock = <A, E>(name: string, task: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      call(
        () =>
          lock(`${secretsDir}/keychain-create`, {
            realpath: false,
            stale: 10_000,
            retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 },
          }),
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
      () => task,
      (release) => Effect.promise(() => release()).pipe(Effect.ignore),
    ).pipe(createLock.withPermits(1));
  return {
    get,
    set,
    create: (name, value) =>
      checked(name, () =>
        withCreateLock(
          name,
          get(name).pipe(
            Effect.flatMap((existing) =>
              Option.isSome(existing) ? Effect.fail(alreadyExists(name)) : set(name, value),
            ),
          ),
        ),
      ),
    remove: (name) =>
      checked(name, () =>
        call(
          () => keychain.remove(name),
          (cause) => new SecretStoreRemoveError({ resource: `secret ${name}`, cause }),
        ),
      ),
    list: (prefix) =>
      call(
        () => keychain.names(),
        (cause) => new SecretStoreReadError({ resource: `secrets ${prefix}*`, cause }),
      ).pipe(Effect.map((names) => names.filter((name) => name.startsWith(prefix)))),
  };
};

const makeGetOrCreateRandom =
  (
    { get, create, remove }: Pick<SecretOperations, "get" | "create" | "remove">,
    crypto: SecureRandom.SecureRandom["Service"],
    emptySecretRepair: Semaphore.Semaphore,
  ): ServerSecretStore["Service"]["getOrCreateRandom"] =>
  (name, bytes) =>
    get(name).pipe(
      // Older builds could persist a 0-byte secret, which is never a usable key. Re-read under
      // the permit, and keep it until an interrupted removal settles, so a caller that saw the
      // empty file cannot remove a key another caller created.
      Effect.filterOrElse(isMissingOrNonEmpty, () =>
        emptySecretRepair.withPermits(1)(
          get(name).pipe(
            Effect.filterOrElse(isMissingOrNonEmpty, () =>
              remove(name).pipe(Effect.as(Option.none<Uint8Array>())),
            ),
            Effect.uninterruptible,
          ),
        ),
      ),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

/** @public */
export const make = makeWith(loadSystemKeychain);

export const layer = Layer.effect(ServerSecretStore, make);

/** For tests: a store whose keychain is the given fake, never the OS keychain. */
export const layerWithKeychain = (keychain: KeychainStore) =>
  Layer.effect(
    ServerSecretStore,
    makeWith(() => keychain),
  );
