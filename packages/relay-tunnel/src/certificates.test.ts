import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { Client, crypto } from "acme-client";
import { expect, it, vi } from "vite-plus/test";
import { AcmeCertificateManager, HttpChallengeStore } from "./certificates.ts";
import { testCertificate } from "./testing/certificate.ts";

it("issues HTTP-01 certificates once per host, persists keys, reuses them after restart and renews at two thirds", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-certs-"));
  const fixture = testCertificate(directory, "abcdef.relay.test");
  const challenges = new HttpChallengeStore();
  const certificateDirectory = NodePath.join(directory, "managed");
  const parsed = new NodeCrypto.X509Certificate(fixture.cert);
  const start = Date.parse(parsed.validFrom);
  const renewal = start + ((Date.parse(parsed.validTo) - start) * 2) / 3;
  const manager = new AcmeCertificateManager({
    directory: certificateDirectory,
    challenges,
    directoryUrl: "https://acme.invalid/directory",
  });
  const restarted = new AcmeCertificateManager({ directory: certificateDirectory, challenges });
  using _account = vi
    .spyOn(Client.prototype, "createAccount")
    .mockResolvedValue({ status: "valid", orders: "https://acme.invalid/orders" });
  using _uri = vi
    .spyOn(Client.prototype, "getAccountUrl")
    .mockReturnValue("https://acme.invalid/acct/123");
  using _csr = vi.spyOn(crypto, "createCsr").mockResolvedValue([fixture.key, Buffer.from("csr")]);
  using issued = vi.spyOn(Client.prototype, "auto").mockImplementation(async (options) => {
    const challenge = {
      type: "http-01" as const,
      status: "pending" as const,
      token: "token",
      url: "https://acme.invalid/challenge",
    };
    const auth = {
      identifier: { type: "dns", value: "abcdef.relay.test" },
      status: "pending" as const,
      challenges: [challenge],
      url: "https://acme.invalid/auth",
    };
    await options.challengeCreateFn(auth, challenge, "key-authorization");
    expect(challenges.get("abcdef.relay.test", "/.well-known/acme-challenge/token")).toBe(
      "key-authorization",
    );
    expect(challenges.get("ABCDEF.RELAY.TEST", "/.well-known/acme-challenge/token")).toBe(
      "key-authorization",
    );
    expect(challenges.get("other.relay.test", "/.well-known/acme-challenge/token")).toBeUndefined();
    expect(
      challenges.get("abcdef.relay.test", "/.well-known/acme-challenge/token/extra"),
    ).toBeUndefined();
    await options.challengeRemoveFn(auth, challenge, "key-authorization");
    expect(
      challenges.get("abcdef.relay.test", "/.well-known/acme-challenge/token"),
    ).toBeUndefined();
    return fixture.cert.toString();
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(start + 1000);
    const contexts = await Promise.all([
      manager.getSecureContext("abcdef.relay.test"),
      manager.getSecureContext("abcdef.relay.test"),
    ]);
    expect(contexts[0]).toBe(contexts[1]);
    expect(issued).toHaveBeenCalledTimes(1);
    const persisted = await NodeFSP.readFile(
      NodePath.join(certificateDirectory, "abcdef.relay.test.json"),
      "utf8",
    );
    expect(JSON.parse(persisted)).toEqual({
      cert: fixture.cert.toString(),
      key: fixture.key.toString(),
    });
    expect(
      (await NodeFSP.stat(NodePath.join(certificateDirectory, "abcdef.relay.test.json"))).mode &
        0o777,
    ).toBe(0o600);
    await restarted.getSecureContext("abcdef.relay.test");
    expect(issued).toHaveBeenCalledTimes(1);
    vi.setSystemTime(renewal - 1);
    await manager.getSecureContext("abcdef.relay.test");
    expect(issued).toHaveBeenCalledTimes(1);
    vi.setSystemTime(renewal);
    await manager.getSecureContext("abcdef.relay.test");
    expect(issued).toHaveBeenCalledTimes(2);
    const valid = await manager.getSecureContext("abcdef.relay.test");
    issued.mockRejectedValue(new Error("ACME unavailable"));
    expect(await manager.getSecureContext("abcdef.relay.test")).toBe(valid);
    vi.setSystemTime(Date.parse(parsed.validTo) + 1);
    await expect(manager.getSecureContext("abcdef.relay.test")).rejects.toThrow("ACME unavailable");
  } finally {
    manager.close();
    restarted.close();
    vi.useRealTimers();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("loads BYO certificates and rejects names outside their coverage", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-byo-"));
  const fixture = testCertificate(directory, "*.relay.test", "wildcard");
  const manager = new AcmeCertificateManager({
    directory,
    challenges: new HttpChallengeStore(),
    byo: { cert: fixture.certFile, key: fixture.keyFile },
  });
  try {
    await manager.getSecureContext("abcdef.relay.test");
    await manager.getSecureContext("3000-abcdef.relay.test");
    await expect(manager.getSecureContext("other.example.com")).rejects.toThrow("does not cover");
    await expect(manager.getSecureContext("../../bad")).rejects.toThrow("Invalid");
  } finally {
    manager.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
