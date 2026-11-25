// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
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

// A port left in link.json from before the policy applied, as the server would load it.
type StoredPort = {
  readonly port: number;
  readonly access: "private" | "link";
  readonly expiresAt: number;
  readonly id: string;
};
const layerConfig = (ports: ReadonlyArray<StoredPort> = []) =>
  Layer.effect(
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
        JSON.stringify({ relayUrl: "https://relay.example.com", slug: "abcdef", ...keys, ports }),
      );
      return config;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "self-relay-test-" })));
const makeLayer = (document?: ManagedPolicyDocument, ports: ReadonlyArray<StoredPort> = []) => {
  const keychain = memoryKeychainStore();
  return SelfRelay.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layerWithKeychain(keychain)),
    Layer.provide(ManagedPolicy.layerTest(document)),
    Layer.provideMerge(layerConfig(ports)),
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
        NodeCrypto.hkdfSync("sha256", privateKey, "p0code-self-relay", "port-link-v1", 32),
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

const noPreviewTunnel: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Example Corp",
  limits: { previewTunnel: false },
};
it.effect("refuses port forwarding when the managed policy denies preview tunnels", () =>
  Effect.gen(function* () {
    const relay = yield* SelfRelay.SelfRelay;
    const exposed = yield* relay
      .exposePort({ port: 3000, access: "link", expiresInSeconds: 3600 })
      .pipe(Effect.result);
    expect(exposed._tag).toBe("Failure");
    if (exposed._tag === "Failure")
      expect(String(exposed.failure.cause)).toContain("does not allow port forwarding");
  }).pipe(Effect.provide(makeLayer(noPreviewTunnel))),
);

it.effect("refuses links to a port exposed before the policy denied preview tunnels", () =>
  Effect.gen(function* () {
    const relay = yield* SelfRelay.SelfRelay;
    const opened = yield* relay.portLink(3000, "session-1").pipe(Effect.result);
    expect(opened._tag).toBe("Failure");
    if (opened._tag === "Failure")
      expect(String(opened.failure.cause)).toContain("does not allow port forwarding");
  }).pipe(
    Effect.provide(
      makeLayer(noPreviewTunnel, [
        { port: 3000, access: "private", expiresAt: 4_102_444_800_000, id: "port-1" },
      ]),
    ),
  ),
);

const httpRelay = (statusCode: number, onEnroll: (body: unknown) => void = () => {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(async (request, response) => {
        if (request.url === "/_hhh/auth/config") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ signup: true, password: true }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        onEnroll(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            statusCode === 200
              ? { slug: "linked123", relayHost: "LOCALHOST" }
              : { error: "secret-password unknown user disabled account" },
          ),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
      return { server, url: `http://localhost:${address.port}` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );

it.live("links an account using the existing key, discovers signup, and persists no password", () =>
  Effect.gen(function* () {
    const relay = yield* SelfRelay.SelfRelay;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const keyBefore = yield* secrets.get("self-relay-tunnel-key");
    const storedBefore = JSON.parse(
      yield* fs.readFileString(`${config.stateDir}/self-relay/link.json`),
    ) as { publicKey: string };
    const http = yield* httpRelay(200, (body) =>
      expect(body).toEqual({
        username: "howard",
        password: "secret-password",
        desiredSlug: "linked123",
        publicKey: storedBefore.publicKey,
      }),
    );
    const status = yield* relay.link({
      relayUrl: `${http.url.replace("localhost", "LOCALHOST")}///`,
      username: "howard",
      password: "secret-password",
      desiredSlug: "linked123",
    });
    expect(status).toMatchObject({
      linked: true,
      slug: "linked123",
      relayUrl: http.url,
      publicOrigin: "https://linked123.localhost",
    });
    expect(yield* secrets.get("self-relay-tunnel-key")).toEqual(keyBefore);
    const stored = yield* fs.readFileString(`${config.stateDir}/self-relay/link.json`);
    expect(stored).not.toContain("password");
    expect(stored).not.toContain("howard");
    expect(JSON.stringify(status)).not.toContain("secret-password");
    expect(yield* fs.exists(`${config.stateDir}/settings.json`)).toBe(false);
    yield* relay.unlink();
    expect((yield* relay.statusFor(http.url)).signupUrl).toBe(`${http.url}/_hhh/auth/register`);
  }).pipe(Effect.provide(makeLayer())),
);

it.live.each([
  [401, "Wrong username or password"],
  [409, "The relay slug or public key is already linked to another environment."],
  [500, "The relay could not enroll this environment."],
] as const)(
  "maps account enrollment %s without exposing relay text or passwords",
  ([statusCode, message]) =>
    Effect.gen(function* () {
      const relay = yield* SelfRelay.SelfRelay;
      const http = yield* httpRelay(statusCode);
      const result = yield* relay
        .link({ relayUrl: http.url, username: "unknown", password: "secret-password" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toBe(message);
        expect(JSON.stringify(result.failure)).not.toContain("secret-password");
        expect(result.failure.cause).toBeNull();
      }
      expect((yield* relay.status).relayUrl).toBe("https://relay.example.com");
    }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses invalid and insecure relay URLs before sending account credentials", () =>
  Effect.gen(function* () {
    const relay = yield* SelfRelay.SelfRelay;
    for (const relayUrl of [
      "invalid",
      "http://example.com",
      "https://user:secret-password@example.com",
      "https://example.com/path",
      "https://example.com?password=secret-password",
      "ftp://localhost",
    ]) {
      const result = yield* relay
        .link({ relayUrl, username: "howard", password: "secret-password" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("url");
        expect(JSON.stringify(result.failure)).not.toContain("secret-password");
      }
    }
  }).pipe(Effect.provide(makeLayer())),
);

it.live("reports relay network failures separately", () =>
  Effect.gen(function* () {
    const relay = yield* SelfRelay.SelfRelay;
    const http = yield* Effect.scoped(httpRelay(200));
    const result = yield* relay
      .link({ relayUrl: http.url, username: "howard", password: "secret-password" })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("network");
  }).pipe(Effect.provide(makeLayer())),
);
