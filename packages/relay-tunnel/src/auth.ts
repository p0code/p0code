import * as NodeCrypto from "node:crypto";

export function generateEnvironmentKeyPair(): { publicKey: string; privateKey: string } {
  const pair = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function message(relayHost: string, slug: string, nonce: string): Buffer {
  if ([relayHost, slug, nonce].some((value) => !value || value.includes("|")))
    throw new Error("Invalid handshake fields");
  return Buffer.from(`hhh-relay/v1|${relayHost}|${slug}|${nonce}`);
}
export function validatePublicKey(pem: string): void {
  if (NodeCrypto.createPublicKey(pem).asymmetricKeyType !== "ed25519")
    throw new Error("Expected Ed25519 public key");
}
export function signHandshake(
  privateKey: string,
  relayHost: string,
  slug: string,
  nonce: string,
): string {
  const key = NodeCrypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 private key");
  return NodeCrypto.sign(null, message(relayHost, slug, nonce), key).toString("base64url");
}
export function verifyHandshake(
  publicKey: string,
  relayHost: string,
  slug: string,
  nonce: string,
  signature: string,
): boolean {
  try {
    validatePublicKey(publicKey);
    return NodeCrypto.verify(
      null,
      message(relayHost, slug, nonce),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export class HandshakeChallenge {
  readonly nonce = NodeCrypto.randomBytes(32).toString("base64url");
  private used = false;
  private readonly relayHost: string;
  private readonly expiresAt: number;
  constructor(relayHost: string, expiresAt = Date.now() + 10_000) {
    this.relayHost = relayHost;
    this.expiresAt = expiresAt;
  }
  verify(publicKey: string, slug: string, signature: string): boolean {
    if (this.used) return false;
    this.used = true;
    return (
      Date.now() < this.expiresAt &&
      verifyHandshake(publicKey, this.relayHost, slug, this.nonce, signature)
    );
  }
}

export interface Enrollment {
  slug: string;
  relayHost: string;
}
export async function enrollEnvironment(
  relayUrl: string,
  token: string,
  publicKey: string,
  desiredSlug?: string,
): Promise<Enrollment> {
  const url = new URL("/_hhh/enroll", relayUrl);
  if (url.protocol !== "https:") throw new Error("Enrollment requires HTTPS");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, publicKey, desiredSlug }),
  });
  if (!response.ok) throw new Error(`Relay enrollment failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("slug" in body) ||
    typeof body.slug !== "string" ||
    !("relayHost" in body) ||
    typeof body.relayHost !== "string"
  )
    throw new Error("Invalid enrollment response");
  return { slug: body.slug, relayHost: body.relayHost };
}
