// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { generateEnvironmentKeyPair } from "@t3tools/relay-tunnel/auth";
import { memoryKeychainStore } from "@t3tools/shared/credentialKeychain";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SelfRelay from "./SelfRelay.ts";

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const keys = generateEnvironmentKeyPair();
    yield* fs.makeDirectory(`${config.stateDir}/self-relay`, { recursive: true });
    yield* fs.makeDirectory(`${config.stateDir}/self-relay/certificates`, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/self-relay/certificates/account.json`,
      JSON.stringify({ uri: "https://acme-v02.api.letsencrypt.org/acme/acct/123" }),
    );
    yield* fs.writeFileString(
      `${config.stateDir}/self-relay/link.json`,
      JSON.stringify({ relayUrl: "https://relay.example.com", slug: "abcdef", ...keys, ports: [] }),
    );
    return config;
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "self-relay-test-" })));
const makeLayer = () => {
  const keychain = memoryKeychainStore();
  return SelfRelay.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layerWithKeychain(keychain)),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
  );
};
const token = (url: string) => new URL(url).searchParams.get("t") ?? "";

it.effect(
  "persists exposure, validates signed link grants, rotates old links, and revokes them",
  () =>
    Effect.gen(function* () {
      const relay = yield* SelfRelay.SelfRelay;
      expect(yield* relay.publicOrigin).toBe("https://abcdef.relay.example.com");
      const first = yield* relay.exposePort({ port: 3000, access: "link", expiresInSeconds: 3600 });
      expect(first.url).toMatch(/^https:\/\/3000-abcdef.relay.example.com\/\?t=/);
      expect(yield* relay.authorizePort(3000, token(first.url))).toEqual({});
      const status = yield* relay.status;
      expect(status.caaRecords).toEqual(
        ["abcdef", "3000-abcdef"].map(
          (label) =>
            `${label}.relay.example.com CAA 0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/123; validationmethods=http-01"`,
        ),
      );
      expect(yield* relay.authorizePort(3001, token(first.url))).toBeNull();
      expect(yield* relay.authorizePort(3000, token(first.url) + "bad")).toBeNull();
      const second = yield* relay.exposePort({
        port: 3000,
        access: "link",
        expiresInSeconds: 3600,
      });
      expect(yield* relay.authorizePort(3000, token(first.url))).toBeNull();
      expect(yield* relay.authorizePort(3000, token(second.url))).toEqual({});
      yield* relay.unexposePort(3000);
      expect(yield* relay.authorizePort(3000, token(second.url))).toBeNull();
      expect((yield* relay.status).ports).toEqual([]);
    }).pipe(Effect.provide(makeLayer())),
);

it.effect(
  "private ports require a session-bound grant, expire, and refuse the environment port",
  () =>
    Effect.gen(function* () {
      const relay = yield* SelfRelay.SelfRelay;
      const ownPort = (yield* ServerConfig.ServerConfig).port;
      const privateUrl = yield* relay.exposePort({
        port: 3001,
        access: "private",
        expiresInSeconds: 60,
      });
      expect(token(privateUrl.url)).toBe("");
      expect(yield* relay.authorizePort(3001, "")).toBeNull();
      const opened = yield* relay.portLink(3001, "session-1");
      expect(yield* relay.authorizePort(3001, token(opened.url))).toEqual({
        sessionId: "session-1",
      });
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const storedFile = yield* fs
        .readFileString(`${config.stateDir}/self-relay/link.json`)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({ privateKey: Schema.optionalKey(Schema.String) }),
              ),
            ),
          ),
        );
      expect(storedFile.privateKey).toBeUndefined();
      const storedKey = yield* secrets.get("self-relay-tunnel-key");
      expect(Option.isSome(storedKey)).toBe(true);
      const privateKey = new TextDecoder().decode(Option.getOrThrow(storedKey));
      const raw = JSON.parse(
        Buffer.from(token(opened.url).split(".")[0]!, "base64url").toString(),
      ) as { port: number; id: string; sessionId: string; expiresAt: number };
      const payload = Buffer.from(
        JSON.stringify({ ...raw, expiresAt: raw.expiresAt + 60_000 }),
      ).toString("base64url");
      const key = Buffer.from(
        NodeCrypto.hkdfSync("sha256", privateKey, "hhhcode-self-relay", "port-link-v1", 32),
      );
      const signature = NodeCrypto.createHmac("sha256", key)
        .update(`port:${payload}`)
        .digest("base64url");
      expect(yield* relay.authorizePort(3001, `${payload}.${signature}`)).toBeNull();
      const oldSignature = NodeCrypto.createHmac("sha256", privateKey)
        .update(`port:${payload}`)
        .digest("base64url");
      expect(yield* relay.authorizePort(3001, `${payload}.${oldSignature}`)).toBeNull();
      yield* TestClock.adjust("61 seconds");
      expect(yield* relay.authorizePort(3001, token(opened.url))).toBeNull();
      const result = yield* relay
        .exposePort({ port: ownPort, access: "link", expiresInSeconds: 60 })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      yield* relay.unlink();
      expect(yield* relay.publicOrigin).toBeNull();
      expect((yield* relay.status).linked).toBe(false);
      expect(Option.isNone(yield* secrets.get("self-relay-tunnel-key"))).toBe(true);
    }).pipe(Effect.provide(makeLayer())),
);
