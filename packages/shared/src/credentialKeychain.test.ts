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

describe("legacy keychain move", () => {
  it("moves a missing entry from the old service on first read and never again", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns").set("server-signing-key", encode("secret-value"));
    const lines: Array<string> = [];
    const store = memoryKeychainStore({ legacy, log: (line) => lines.push(line) });
    const secrets = keychainSecrets(store, "ns");

    assert.deepEqual(await secrets.names(), ["server-signing-key"]);
    assert.equal(text(await secrets.get("server-signing-key")), "secret-value");
    assert.equal(text(await secrets.get("server-signing-key")), "secret-value");

    assert.deepEqual([...store.entries.keys()], ["ns:server-signing-key"]);
    assert.deepEqual([...legacy.entries.keys()], []);
    assert.deepEqual(secrets.movedFromLegacy(), ["server-signing-key"]);
    assert.equal(lines.filter((line) => line.includes("Moved 1 secret")).length, 1);
    assert.isFalse(lines.join("\n").includes("secret-value"));
  });

  it("moves a chunked entry whole, so no chunk is left behind", async () => {
    const legacy = memoryKeychainStore();
    const value = Uint8Array.from({ length: 4000 }, (_, index) => index % 256);
    await keychainSecrets(legacy, "ns").set("plugin-x-token", value);
    const store = memoryKeychainStore({ legacy });

    const moved = await keychainSecrets(store, "ns").get("plugin-x-token");

    assert.deepEqual(Array.from(moved ?? []), Array.from(value));
    assert.deepEqual([...legacy.entries.keys()], []);
    assert.deepEqual(
      [...store.entries.keys()].filter((account) => account.startsWith("ns:")),
      ["ns:plugin-x-token"],
    );
    assert.isTrue([...store.entries.keys()].some((account) => account.startsWith("ns#")));
  });

  it("returns the value and warns once when the old copy cannot be deleted", async () => {
    const seeded = memoryKeychainStore();
    await keychainSecrets(seeded, "ns").set("one", encode("first-secret"));
    await keychainSecrets(seeded, "ns").set("two", encode("second-secret"));
    const legacy: KeychainStore = {
      ...seeded,
      delete: async () => {
        throw new Error("keychain is locked");
      },
    };
    const lines: Array<string> = [];
    const store = memoryKeychainStore({ legacy, log: (line) => lines.push(line) });
    const secrets = keychainSecrets(store, "ns");

    assert.equal(text(await secrets.get("one")), "first-secret");
    assert.equal(text(await secrets.get("two")), "second-secret");

    assert.isTrue(secrets.legacyCopyLeft());
    assert.equal(lines.filter((line) => line.includes("Could not delete")).length, 1);
    assert.isFalse(lines.join("\n").includes("first-secret"));
    assert.isFalse(lines.join("\n").includes("second-secret"));
  });

  it("maps namespaces one to one and leaves other homes alone", async () => {
    const legacy = memoryKeychainStore();
    await keychainSecrets(legacy, "ns1").set("a", encode("a"));
    await keychainSecrets(legacy, "ns2").set("b", encode("b"));
    const store = memoryKeychainStore({ legacy });
    const secrets = keychainSecrets(store, "ns1");

    assert.equal(text(await secrets.get("a")), "a");
    assert.isUndefined(await secrets.get("b"));
    assert.deepEqual([...store.entries.keys()], ["ns1:a"]);
    assert.deepEqual([...legacy.entries.keys()], ["ns2:b"]);
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

  it("keeps a conflicting credential file and reports its name", async () => {
    const secretsDir = makeSecretsDir();
    const file = NodePath.join(secretsDir, "server-signing-key.bin");
    NodeFS.writeFileSync(file, "rotated key");
    const secrets = keychainSecrets(memoryKeychainStore(), "ns");
    await secrets.set("server-signing-key", encode("old key"));
    assert.deepEqual(await importCredentialFiles(secretsDir, secrets), {
      imported: [],
      superseded: ["server-signing-key"],
    });
    assert.equal(NodeFS.readFileSync(file, "utf8"), "rotated key");
    assert.equal(text(await secrets.get("server-signing-key")), "old key");
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
