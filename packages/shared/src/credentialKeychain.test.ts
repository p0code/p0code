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
  memoryKeychainStore,
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
