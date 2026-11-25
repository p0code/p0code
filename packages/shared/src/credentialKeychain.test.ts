// @effect-diagnostics nodeBuiltinImport:off - seeds secrets folders on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  classifySecret,
  credentialNamespace,
  importCredentialFiles,
  keychainSecrets,
  type KeychainStore,
  type KeyringModule,
  keyringStore,
  memoryKeychainStore,
  migrateKeychainService,
} from "./credentialKeychain.ts";

const roots: Array<string> = [];
const makeSecretsDir = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p0code-keychain-test-"));
  roots.push(root);
  const secretsDir = NodePath.join(root, "userdata", "secrets");
  NodeFS.mkdirSync(secretsDir, { recursive: true });
  return secretsDir;
};
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
const text = (value: Uint8Array | undefined) =>
  value === undefined ? undefined : new TextDecoder().decode(value);
const encode = (value: string) => new TextEncoder().encode(value);

/** A stand-in for `@napi-rs/keyring` that records entries per service. */
const fakeKeyring = () => {
  const services = new Map<string, Map<string, string>>();
  class Entry {
    readonly service: string;
    readonly account: string;
    constructor(service: string, account: string) {
      this.service = service;
      this.account = account;
    }
    async getPassword() {
      return services.get(this.service)?.get(this.account) ?? null;
    }
    async setPassword(password: string) {
      const entries = services.get(this.service) ?? new Map<string, string>();
      entries.set(this.account, password);
      services.set(this.service, entries);
    }
    async deleteCredential() {
      return services.get(this.service)?.delete(this.account) ?? false;
    }
  }
  const module: KeyringModule = {
    AsyncEntry: Entry,
    findCredentialsAsync: async (service) =>
      [...(services.get(service)?.keys() ?? [])].map((account) => ({ account })),
  };
  return { module, services };
};

describe("classifySecret", () => {
  it("keeps only replay markers as files and defaults everything else to the keychain", () => {
    for (const name of [
      "dpop-proof-abc",
      "cloud-mint-jti-1",
      "cloud-mint-nonce-1",
      "cloud-health-jti-1",
      "cloud-health-nonce-1",
    ]) {
      assert.equal(classifySecret(name), "file", name);
    }
    for (const name of [
      "server-signing-key",
      "peer-link-abc",
      "provider-auth-abc",
      "secret-request-salt",
      "secret-request-0123",
      "plugin-t3-connect-bridge-signing-key",
      "obsidian-shared-memory-token",
      "self-relay-tunnel-key",
      "something-new",
    ]) {
      assert.equal(classifySecret(name), "keychain", name);
    }
  });
});

describe("keychainSecrets", () => {
  it("namespaces each secrets folder", async () => {
    const one = await credentialNamespace(makeSecretsDir());
    const two = await credentialNamespace(makeSecretsDir());
    assert.notEqual(one, two);
    assert.match(one, /^[0-9a-f]{16}$/);
  });

  it("round-trips binary values, chunked when long, and lists only head names", async () => {
    const store = memoryKeychainStore();
    const secrets = keychainSecrets(store, "ns");
    const binary = Uint8Array.from([0, 255, 1, 254]);
    const long = Uint8Array.from({ length: 4000 }, (_, index) => index % 256);
    await secrets.set("small", binary);
    await secrets.set("long", long);
    assert.deepEqual(Array.from((await secrets.get("small")) ?? []), Array.from(binary));
    assert.deepEqual(Array.from((await secrets.get("long")) ?? []), Array.from(long));
    assert.deepEqual([...(await secrets.names())].toSorted(), ["long", "small"]);
    await secrets.remove("long");
    assert.deepEqual([...store.entries.keys()], ["ns:small"]);
  });

  it("reports a chunked value with a missing chunk instead of returning a partial one", async () => {
    const store = memoryKeychainStore();
    const secrets = keychainSecrets(store, "ns");
    await secrets.set("long", new Uint8Array(4000));
    const chunk = [...store.entries.keys()].find((account) => account.startsWith("ns#"));
    store.entries.delete(chunk ?? "");
    let failed = false;
    await secrets.get("long").catch(() => {
      failed = true;
    });
    assert.isTrue(failed);
  });
});

describe("keyringStore", () => {
  it("reads and writes under p0code and never under the old service name", async () => {
    const keyring = fakeKeyring();
    const secrets = keychainSecrets(keyringStore(keyring.module, "darwin"), "ns");

    await secrets.set("server-signing-key", encode("only-here"));
    await secrets.set("long", new Uint8Array(4000));

    assert.deepEqual([...keyring.services.keys()], ["p0code"]);
    assert.equal(
      keyring.services.get("p0code")?.get("ns:server-signing-key"),
      `b:${Buffer.from("only-here").toString("base64")}`,
    );
    assert.equal(text(await secrets.get("server-signing-key")), "only-here");
  });
});

describe("legacy keychain isolation", () => {
  /** Wraps the old store and counts every read, so a test can prove none happened. */
  const counted = (legacy: ReturnType<typeof memoryKeychainStore>) => {
    const reads = { get: 0, accounts: 0 };
    const store: KeychainStore = {
      ...legacy,
      get: async (account) => {
        reads.get += 1;
        return legacy.get(account);
      },
      accounts: async () => {
        reads.accounts += 1;
        return legacy.accounts();
      },
    };
    return { store, reads };
  };

  it("never reads the old service on a miss, so startup asks for nothing", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns").set("server-signing-key", encode("old"));
    const countedLegacy = counted(legacy);
    const store = memoryKeychainStore({ legacy: countedLegacy.store });
    const secrets = keychainSecrets(store, "ns");

    assert.isUndefined(await secrets.get("server-signing-key"));
    assert.deepEqual(await secrets.names(), []);

    assert.equal(countedLegacy.reads.get, 0);
    assert.equal(countedLegacy.reads.accounts, 0);
    assert.deepEqual([...store.entries.keys()], []);
    assert.deepEqual([...legacy.entries.keys()], ["ns:server-signing-key"]);
  });

  it("never reads the old service when removing a p0code secret", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns").set("server-signing-key", encode("old"));
    const countedLegacy = counted(legacy);
    const store = memoryKeychainStore({ legacy: countedLegacy.store });
    const secrets = keychainSecrets(store, "ns");
    await secrets.set("server-signing-key", encode("new"));

    await secrets.remove("server-signing-key");

    assert.equal(countedLegacy.reads.get, 0);
    assert.equal(countedLegacy.reads.accounts, 0);
    assert.deepEqual([...store.entries.keys()], []);
    assert.deepEqual([...legacy.entries.keys()], ["ns:server-signing-key"]);
  });

  it("lists only p0code names, never the old service's", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns").set("a", encode("a"));
    const store = memoryKeychainStore({ legacy });
    await keychainSecrets(store, "ns").set("b", encode("b"));

    assert.deepEqual(await keychainSecrets(store, "ns").names(), ["b"]);
  });

  it("reports nothing to import, without reading any old item, when the old service is empty", async () => {
    const countedLegacy = counted(memoryKeychainStore());
    const store = memoryKeychainStore({ legacy: countedLegacy.store });

    const report = await migrateKeychainService(store);

    assert.deepEqual(report, { moved: [], alreadyPresent: [], failed: [], leftBehind: [] });
    assert.equal(countedLegacy.reads.get, 0);
  });
});

describe("migrateKeychainService", () => {
  it("moves every old-service entry across homes and leaves nothing behind", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns1").set("server-signing-key", encode("signing"));
    await keychainSecrets(legacy, "ns2").set("plugin-x-token", encode("plugin"));
    const store = memoryKeychainStore({ legacy });

    const report = await migrateKeychainService(store);

    assert.deepEqual([...report.moved].toSorted(), [
      "ns1:server-signing-key",
      "ns2:plugin-x-token",
    ]);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.alreadyPresent, []);
    assert.deepEqual(report.leftBehind, []);
    assert.deepEqual([...legacy.entries.keys()], []);
    assert.equal(text(await keychainSecrets(store, "ns1").get("server-signing-key")), "signing");
    assert.equal(text(await keychainSecrets(store, "ns2").get("plugin-x-token")), "plugin");
  });

  it("removes an old copy whose secret p0code already has, and is safe to repeat", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns").set("server-signing-key", encode("old"));
    const store = memoryKeychainStore({ legacy });
    await keychainSecrets(store, "ns").set("server-signing-key", encode("new"));

    const report = await migrateKeychainService(store);

    assert.deepEqual(report.moved, []);
    assert.deepEqual(report.alreadyPresent, ["ns:server-signing-key"]);
    assert.deepEqual([...legacy.entries.keys()], []);
    assert.equal(text(await keychainSecrets(store, "ns").get("server-signing-key")), "new");
    assert.deepEqual((await migrateKeychainService(store)).moved, []);
  });
});

describe("importCredentialFiles", () => {
  it("moves credentials, leaves replay markers and drops interrupted temp writes", async () => {
    const secretsDir = makeSecretsDir();
    NodeFS.writeFileSync(NodePath.join(secretsDir, "server-signing-key.bin"), "key");
    NodeFS.writeFileSync(NodePath.join(secretsDir, "peer-link-a.bin.0a1b-2c.tmp"), "partial");
    NodeFS.writeFileSync(NodePath.join(secretsDir, "dpop-proof-x.bin"), "marker");
    NodeFS.mkdirSync(NodePath.join(secretsDir, "files"));
    const secrets = keychainSecrets(memoryKeychainStore(), "ns");

    const result = await importCredentialFiles(secretsDir, secrets);

    assert.deepEqual(result, { imported: ["server-signing-key"], superseded: [] });
    assert.equal(text(await secrets.get("server-signing-key")), "key");
    assert.deepEqual(NodeFS.readdirSync(secretsDir).toSorted(), ["dpop-proof-x.bin", "files"]);
    assert.deepEqual(await importCredentialFiles(secretsDir, secrets), {
      imported: [],
      superseded: [],
    });
  });

  it("never deletes a file the keychain failed to keep", async () => {
    const secretsDir = makeSecretsDir();
    NodeFS.writeFileSync(NodePath.join(secretsDir, "server-signing-key.bin"), "key");
    const store = memoryKeychainStore();
    const lossy: KeychainStore = { ...store, set: async () => undefined };

    let failed = false;
    await importCredentialFiles(secretsDir, keychainSecrets(lossy, "ns")).catch(() => {
      failed = true;
    });

    assert.isTrue(failed);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(secretsDir, "server-signing-key.bin"), "utf8"),
      "key",
    );
  });

  it("finishes after a crash between the keychain write and the delete", async () => {
    const secretsDir = makeSecretsDir();
    const secrets = keychainSecrets(memoryKeychainStore(), "ns");
    await secrets.set("mcp-oauth-signing-key", new TextEncoder().encode("same"));
    NodeFS.writeFileSync(NodePath.join(secretsDir, "mcp-oauth-signing-key.bin"), "same");

    const result = await importCredentialFiles(secretsDir, secrets);

    assert.deepEqual(result, { imported: [], superseded: [] });
    assert.deepEqual(NodeFS.readdirSync(secretsDir), []);
    assert.equal(text(await secrets.get("mcp-oauth-signing-key")), "same");
  });
});
