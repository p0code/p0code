import { expect, it } from "vite-plus/test";
import {
  generateEnvironmentKeyPair,
  HandshakeChallenge,
  signHandshake,
  verifyHandshake,
} from "./auth.ts";

it("binds authentication to relay, slug and fresh single-use nonce", () => {
  const keys = generateEnvironmentKeyPair();
  const challenge = new HandshakeChallenge("relay.test");
  const signature = signHandshake(keys.privateKey, "relay.test", "abcdef", challenge.nonce);
  expect(verifyHandshake(keys.publicKey, "other.test", "abcdef", challenge.nonce, signature)).toBe(
    false,
  );
  expect(verifyHandshake(keys.publicKey, "relay.test", "ghijkl", challenge.nonce, signature)).toBe(
    false,
  );
  expect(verifyHandshake(keys.publicKey, "relay.test", "abcdef", "other-nonce", signature)).toBe(
    false,
  );
  expect(challenge.verify(keys.publicKey, "abcdef", signature)).toBe(true);
  expect(challenge.verify(keys.publicKey, "abcdef", signature)).toBe(false);
  expect(new HandshakeChallenge("relay.test", 0).verify(keys.publicKey, "abcdef", signature)).toBe(
    false,
  );
  expect(
    verifyHandshake(
      generateEnvironmentKeyPair().publicKey,
      "relay.test",
      "abcdef",
      challenge.nonce,
      signature,
    ),
  ).toBe(false);
});
