// @effect-diagnostics nodeBuiltinImport:off -- Shared by the server, the CLI migration and the Electron main process, outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { previousAppHomePath } from "./appHomeMigration.ts";

/**
 * OS keychain service `hhhcode` (pre-rename name, kept so stored credentials stay found), one
 * entry per secret, account `<namespace>:<secret name>`. The namespace hashes the resolved
 * secrets folder, so every home (`~/.p0code`, `P0CODE_HOME`, `--base-dir`, dev) keeps its own.
 */
const KEYCHAIN_SERVICE = "hhhcode";

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
  // The binding otherwise falls back to the Linux kernel keyring, which forgets everything on reboot.
  const entry = (account: string) =>
    new keyring.AsyncEntry(KEYCHAIN_SERVICE, account, { linux: { store: "secret-service" } });
  return {
    label: keychainLabel(platform),
    get: async (account) => (await entry(account).getPassword()) ?? undefined,
    set: (account, value) => entry(account).setPassword(value),
    delete: async (account) => {
      await entry(account).deleteCredential();
    },
    accounts: async () =>
      (await keyring.findCredentialsAsync(KEYCHAIN_SERVICE)).map(
        (credential) => credential.account,
      ),
  };
}

/** An in-memory keychain for tests; never touches the OS keychain. */
export function memoryKeychainStore(): KeychainStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    label: "Test keychain",
    entries,
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

export const credentialNamespace = async (secretsDir: string): Promise<string> =>
  NodeCrypto.createHash("sha256")
    .update(
      previousAppHomePath(
        await realpathLoose(NodePath.resolve(secretsDir)),
        await realpathLoose(NodeOS.homedir()),
      ),
    )
    .digest("hex")
    .slice(0, 16);

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

  return {
    label: store.label,
    get: async (name) => {
      const head = await readHead(name);
      if (head === undefined) return undefined;
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
    },
    set: async (name, value) => {
      const previous = await readHead(name).catch(() => undefined);
      const base64 = Buffer.from(value).toString("base64");
      if (base64.length + 2 <= CHUNK_CHARACTERS) {
        await store.set(headAccount(name), `b:${base64}`);
      } else {
        const generation = NodeCrypto.randomBytes(4).toString("hex");
        const count = Math.ceil(base64.length / CHUNK_CHARACTERS);
        for (let index = 0; index < count; index += 1) {
          await store.set(
            chunkAccount(name, generation, index),
            base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS),
          );
        }
        await store.set(headAccount(name), `c:${generation}:${count}`);
      }
      await deleteChunks(name, previous).catch(() => undefined);
    },
    remove: async (name) => {
      const head = await readHead(name).catch(() => undefined);
      await store.delete(headAccount(name));
      await deleteChunks(name, head);
    },
    names: async () => {
      const prefix = `${namespace}:`;
      return (await store.accounts())
        .filter((account) => account.startsWith(prefix))
        .map((account) => account.slice(prefix.length));
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
  };
}

const SECRET_FILE = /^(.+)\.bin$/;
const SECRET_TEMP_FILE = /^(.+)\.bin\.[0-9a-f-]+\.tmp$/;

export interface CredentialFileImport {
  readonly imported: ReadonlyArray<string>;
  /** Files whose name was already in the keychain with a different value; the keychain wins. */
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
    }
    await NodeFSP.rm(path, { force: true });
  }
  return { imported, superseded };
}
