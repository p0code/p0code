// @effect-diagnostics nodeBuiltinImport:off -- Shared by the server, the CLI migration and the Electron main process, outside an Effect runtime.
// @effect-diagnostics globalConsole:off -- The move below reports a debug line; a logger is not reachable from the Electron main process.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { previousAppHomePath } from "./appHomeMigration.ts";

/**
 * OS keychain service `p0code`, one entry per secret, account `<namespace>:<secret name>`. The
 * namespace is saved in the secrets folder, initially hashing its resolved path so existing
 * homes keep their credentials and moving a home keeps its identity.
 */
const KEYCHAIN_SERVICE = "p0code";

/**
 * The service name stored credentials lived under before the rename. Only the one-time move in
 * `keychainSecrets` reads it, so `grep hhhcode` finds every place the old name still matters.
 */
const LEGACY_KEYCHAIN_SERVICE = "hhhcode";

/** Debug sink for the move; it receives counts and fixed messages, never secret material. */
export type KeychainLog = (line: string) => void;

/** Written into a secrets folder once its credentials live in the keychain. */
export const KEYCHAIN_MARKER_FILE = "keychain-backend";

/**
 * Single-use replay markers and nonces are not credentials, can number in the thousands, and
 * rely on the filesystem's atomic create, so they stay as files. Every other name is a credential.
 */
export const FILE_ONLY_SECRET_PREFIXES = [
  "dpop-proof-",
  "cloud-mint-jti-",
  "cloud-mint-nonce-",
  "cloud-health-jti-",
  "cloud-health-nonce-",
] as const;

export type SecretClass = "keychain" | "file";

export const classifySecret = (name: string): SecretClass =>
  FILE_ONLY_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "file" : "keychain";

/** Raw access to one keychain service. Accounts and values are plain strings. */
export interface KeychainStore {
  readonly label: string;
  readonly get: (account: string) => Promise<string | undefined>;
  readonly set: (account: string, value: string) => Promise<void>;
  readonly delete: (account: string) => Promise<void>;
  readonly accounts: () => Promise<ReadonlyArray<string>>;
  /**
   * The pre-rename service. Entries missing from the primary service are read from here once,
   * copied under the primary name and then deleted.
   */
  readonly legacy?: KeychainStore;
  /** Debug sink for the move. Never receives account values. */
  readonly log?: KeychainLog;
}

/** The part of `@napi-rs/keyring` (2.x) used here; callers load the native module themselves. */
export interface KeyringModule {
  readonly AsyncEntry: new (
    service: string,
    account: string,
    options?: { readonly linux?: { readonly store?: "secret-service" } },
  ) => {
    getPassword(): Promise<string | null | undefined>;
    setPassword(password: string): Promise<void>;
    deleteCredential(): Promise<boolean>;
  };
  readonly findCredentialsAsync: (
    service: string,
  ) => Promise<ReadonlyArray<{ readonly account: string }>>;
}

const keychainLabel = (platform: NodeJS.Platform): string =>
  platform === "darwin"
    ? "macOS Keychain"
    : platform === "win32"
      ? "Windows Credential Manager"
      : "Secret Service";

export function keyringStore(keyring: KeyringModule, platform: NodeJS.Platform): KeychainStore {
  const storeFor = (service: string, label: string): KeychainStore => {
    // The binding otherwise falls back to the Linux kernel keyring, which forgets everything on reboot.
    const entry = (account: string) =>
      new keyring.AsyncEntry(service, account, { linux: { store: "secret-service" } });
    return {
      label,
      get: async (account) => (await entry(account).getPassword()) ?? undefined,
      set: (account, value) => entry(account).setPassword(value),
      delete: async (account) => {
        await entry(account).deleteCredential();
      },
      accounts: async () =>
        (await keyring.findCredentialsAsync(service)).map((credential) => credential.account),
    };
  };
  return {
    ...storeFor(KEYCHAIN_SERVICE, keychainLabel(platform)),
    legacy: storeFor(LEGACY_KEYCHAIN_SERVICE, "previous keychain service"),
    log: (line) => console.debug(line),
  };
}

/** An in-memory keychain for tests; never touches the OS keychain. */
export function memoryKeychainStore(
  options: {
    readonly legacy?: KeychainStore;
    readonly log?: KeychainLog;
  } = {},
): KeychainStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    label: "Test keychain",
    entries,
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    ...(options.log === undefined ? {} : { log: options.log }),
    get: async (account) => entries.get(account),
    set: async (account, value) => {
      entries.set(account, value);
    },
    delete: async (account) => {
      entries.delete(account);
    },
    accounts: async () => [...entries.keys()],
  };
}

/** Resolves symlinks in the deepest existing ancestor, for a path that may not exist yet. */
export const realpathLoose = async (target: string): Promise<string> => {
  const real = await NodeFSP.realpath(target).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = NodePath.dirname(target);
  if (parent === target) return target;
  return NodePath.join(await realpathLoose(parent), NodePath.basename(target));
};

export const credentialNamespace = async (
  secretsDir: string,
  initialPath = secretsDir,
): Promise<string> => {
  const file = NodePath.join(secretsDir, "keychain-namespace");
  const read = async () => {
    const value = (await NodeFSP.readFile(file, "utf8")).trim();
    if (!/^[0-9a-f]{16}$/.test(value)) throw new Error(`Invalid keychain namespace at ${file}.`);
    return value;
  };
  try {
    return await read();
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const namespace = NodeCrypto.createHash("sha256")
    .update(
      previousAppHomePath(
        await realpathLoose(NodePath.resolve(initialPath)),
        await realpathLoose(NodeOS.homedir()),
      ),
    )
    .digest("hex")
    .slice(0, 16);
  await NodeFSP.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(file, `${namespace}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    return read();
  }
  return namespace;
};

// Windows Credential Manager caps a credential at 2560 bytes (1280 UTF-16 characters), so
// longer values are split across chunk entries and the head entry is written last.
const CHUNK_CHARACTERS = 1000;

export interface KeychainSecrets {
  readonly label: string;
  readonly get: (name: string) => Promise<Uint8Array | undefined>;
  readonly set: (name: string, value: Uint8Array) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  readonly names: () => Promise<ReadonlyArray<string>>;
  /** Write, read back and delete a throwaway entry; rejects when the keychain is unusable. */
  readonly probe: () => Promise<void>;
  /** Names moved out of the pre-rename service by this adapter, in the order they moved. */
  readonly movedFromLegacy: () => ReadonlyArray<string>;
  /** True when an old copy could not be deleted; its value is already safe under p0code. */
  readonly legacyCopyLeft: () => boolean;
}

type Head =
  | { readonly kind: "inline"; readonly base64: string }
  | { readonly kind: "chunked"; readonly generation: string; readonly count: number };

const parseHead = (value: string): Head => {
  if (value.startsWith("b:")) return { kind: "inline", base64: value.slice(2) };
  const match = /^c:([0-9a-f]+):(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Unrecognized keychain entry.");
  }
  return { kind: "chunked", generation: match[1], count: Number(match[2]) };
};

export function keychainSecrets(store: KeychainStore, namespace: string): KeychainSecrets {
  const headAccount = (name: string) => `${namespace}:${name}`;
  // `#` keeps chunk and probe entries out of `names()`.
  const chunkAccount = (name: string, generation: string, index: number) =>
    `${namespace}#${generation}.${index}:${name}`;
  const deleteChunks = (name: string, head: Head | undefined) =>
    head?.kind === "chunked"
      ? Promise.all(
          Array.from({ length: head.count }, (_, index) =>
            store.delete(chunkAccount(name, head.generation, index)),
          ),
        )
      : Promise.resolve();
  const readHead = async (name: string) => {
    const value = await store.get(headAccount(name));
    return value === undefined ? undefined : parseHead(value);
  };
  const readBody = async (name: string, head: Head): Promise<Uint8Array> => {
    if (head.kind === "inline") return Uint8Array.from(Buffer.from(head.base64, "base64"));
    const chunks = await Promise.all(
      Array.from({ length: head.count }, (_, index) =>
        store.get(chunkAccount(name, head.generation, index)),
      ),
    );
    if (chunks.some((chunk) => chunk === undefined)) {
      throw new Error(`Keychain entry ${name} is incomplete.`);
    }
    return Uint8Array.from(Buffer.from(chunks.join(""), "base64"));
  };
  const writeBody = async (name: string, value: Uint8Array) => {
    const base64 = Buffer.from(value).toString("base64");
    if (base64.length + 2 <= CHUNK_CHARACTERS) {
      await store.set(headAccount(name), `b:${base64}`);
      return;
    }
    const generation = NodeCrypto.randomBytes(4).toString("hex");
    const count = Math.ceil(base64.length / CHUNK_CHARACTERS);
    for (let index = 0; index < count; index += 1) {
      await store.set(
        chunkAccount(name, generation, index),
        base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS),
      );
    }
    await store.set(headAccount(name), `c:${generation}:${count}`);
  };

  const legacyStore = store.legacy;
  const legacy = legacyStore === undefined ? undefined : keychainSecrets(legacyStore, namespace);
  const log = store.log ?? (() => {});
  // A name missing from the old service stays missing: nothing writes that service any more.
  const absentFromLegacy = new Set<string>();
  const moved: Array<string> = [];
  let legacyDeleteFailed = false;

  const deleteLegacy = async (name: string) => {
    if (legacy === undefined) return;
    try {
      await legacy.remove(name);
    } catch {
      // The value is already under p0code; a leftover old copy must not fail the caller.
      if (!legacyDeleteFailed) {
        legacyDeleteFailed = true;
        log("Could not delete a secret from the old keychain service; its p0code copy is safe.");
      }
    }
  };

  // Moves the whole value at once so an interrupted move never leaves chunks under p0code only.
  const moveFromLegacy = async (name: string): Promise<Uint8Array | undefined> => {
    if (legacy === undefined || absentFromLegacy.has(name)) return undefined;
    const value = await legacy.get(name);
    if (value === undefined) {
      absentFromLegacy.add(name);
      return undefined;
    }
    await writeBody(name, value);
    moved.push(name);
    log(`Moved ${moved.length} secret(s) from the old keychain service to p0code.`);
    await deleteLegacy(name);
    return value;
  };

  return {
    label: store.label,
    get: async (name) => {
      const head = await readHead(name);
      if (head === undefined) return moveFromLegacy(name);
      return readBody(name, head);
    },
    set: async (name, value) => {
      const previous = await readHead(name).catch(() => undefined);
      await writeBody(name, value);
      await deleteChunks(name, previous).catch(() => undefined);
    },
    remove: async (name) => {
      const head = await readHead(name).catch(() => undefined);
      await store.delete(headAccount(name));
      await deleteChunks(name, head);
      await deleteLegacy(name);
    },
    names: async () => {
      const prefix = `${namespace}:`;
      const headNames = (accounts: ReadonlyArray<string>) =>
        accounts
          .filter((account) => account.startsWith(prefix))
          .map((account) => account.slice(prefix.length));
      const primary = headNames(await store.accounts());
      if (legacyStore === undefined) return primary;
      // Entries not read yet are still owned by the old service; listing must see them.
      const previous = await legacyStore.accounts().catch(() => [] as ReadonlyArray<string>);
      return [...new Set([...primary, ...headNames(previous)])];
    },
    probe: async () => {
      const account = `${namespace}#probe`;
      const value = NodeCrypto.randomBytes(16).toString("hex");
      await store.set(account, value);
      try {
        if ((await store.get(account)) !== value) {
          throw new Error("The keychain did not return what was written.");
        }
      } finally {
        await store.delete(account);
      }
    },
    movedFromLegacy: () => [...moved],
    legacyCopyLeft: () => legacyDeleteFailed,
  };
}

export interface KeychainServiceMigration {
  /** Head names copied from the old service to p0code. */
  readonly moved: ReadonlyArray<string>;
  /** Names already under p0code whose old copy was removed. */
  readonly alreadyPresent: ReadonlyArray<string>;
  /** Names that could not be copied; they stay readable from the old service. */
  readonly failed: ReadonlyArray<string>;
  /** Names whose value is safe under p0code but whose old copy could not be deleted. */
  readonly leftBehind: ReadonlyArray<string>;
}

const NAMESPACE_ACCOUNT = /^([^:#]+):(.+)$/;

/**
 * Moves every credential of the old keychain service, across every home's namespace, to p0code.
 * Values are moved whole and verified before the old copy is deleted, so `p0 secrets
 * migrate-keychain` is safe to run repeatedly and a crash leaves each credential readable once.
 */
export async function migrateKeychainService(
  store: KeychainStore,
  options: { readonly log?: KeychainLog } = {},
): Promise<KeychainServiceMigration> {
  const moved: Array<string> = [];
  const alreadyPresent: Array<string> = [];
  const failed: Array<string> = [];
  const leftBehind: Array<string> = [];
  const log = options.log ?? (() => {});
  const legacyStore = store.legacy;
  if (legacyStore === undefined) return { moved, alreadyPresent, failed, leftBehind };

  const byNamespace = new Map<string, Array<string>>();
  for (const account of await legacyStore.accounts()) {
    const match = NAMESPACE_ACCOUNT.exec(account);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const names = byNamespace.get(match[1]) ?? [];
    names.push(match[2]);
    byNamespace.set(match[1], names);
  }

  const primaryOnly: KeychainStore = {
    label: store.label,
    get: store.get,
    set: store.set,
    delete: store.delete,
    accounts: store.accounts,
  };
  let deleteWarningLogged = false;
  for (const [namespace, names] of byNamespace) {
    const primary = keychainSecrets(primaryOnly, namespace);
    const legacy = keychainSecrets(legacyStore, namespace);
    for (const name of names) {
      const account = `${namespace}:${name}`;
      let value: Uint8Array | undefined;
      try {
        value = await legacy.get(name);
      } catch {
        failed.push(account);
        continue;
      }
      if (value === undefined) continue;
      try {
        if ((await primary.get(name)) === undefined) {
          await primary.set(name, value);
          const stored = await primary.get(name);
          if (stored === undefined || !Buffer.from(stored).equals(Buffer.from(value))) {
            failed.push(account);
            continue;
          }
          moved.push(account);
        } else {
          alreadyPresent.push(account);
        }
      } catch {
        failed.push(account);
        continue;
      }
      try {
        await legacy.remove(name);
      } catch {
        leftBehind.push(account);
        if (!deleteWarningLogged) {
          deleteWarningLogged = true;
          log("Could not delete a secret from the old keychain service; its p0code copy is safe.");
        }
      }
    }
  }
  log(`Moved ${moved.length} secret(s) from the old keychain service to p0code.`);
  return { moved, alreadyPresent, failed, leftBehind };
}

const SECRET_FILE = /^(.+)\.bin$/;
const SECRET_TEMP_FILE = /^(.+)\.bin\.[0-9a-f-]+\.tmp$/;

export interface CredentialFileImport {
  readonly imported: ReadonlyArray<string>;
  /** Conflicting files kept because the keychain contains different bytes. */
  readonly superseded: ReadonlyArray<string>;
}

/**
 * Moves credential files of a secrets folder into the keychain. A file is deleted only after
 * the keychain returns its exact bytes, so a crash at any point leaves the credential readable
 * from one place or the other, and the next run finishes the job.
 */
export async function importCredentialFiles(
  secretsDir: string,
  secrets: KeychainSecrets,
): Promise<CredentialFileImport> {
  const imported: Array<string> = [];
  const superseded: Array<string> = [];
  const entries = await NodeFSP.readdir(secretsDir).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  });
  for (const file of entries) {
    const path = NodePath.join(secretsDir, file);
    const temporary = SECRET_TEMP_FILE.exec(file)?.[1];
    if (temporary !== undefined) {
      // An interrupted write from before the move; it never became the stored value.
      if (classifySecret(temporary) === "keychain") await NodeFSP.rm(path, { force: true });
      continue;
    }
    const name = SECRET_FILE.exec(file)?.[1];
    if (name === undefined || classifySecret(name) !== "keychain") continue;
    const bytes = new Uint8Array(await NodeFSP.readFile(path));
    const existing = await secrets.get(name);
    if (existing === undefined) {
      await secrets.set(name, bytes);
      const stored = await secrets.get(name);
      if (stored === undefined || !Buffer.from(stored).equals(Buffer.from(bytes))) {
        throw new Error(`The keychain did not keep ${name}; its file was left in place.`);
      }
      imported.push(name);
    } else if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      superseded.push(name);
      continue;
    }
    await NodeFSP.rm(path, { force: true });
  }
  return { imported, superseded };
}
