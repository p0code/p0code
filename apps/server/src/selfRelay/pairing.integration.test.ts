// Native HTTP/TLS adapters exercise the production auth routes across an actual relay.
// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { generateEnvironmentKeyPair } from "@t3tools/relay-tunnel/auth";
import { testCertificate } from "../../../../packages/relay-tunnel/src/testing/certificate.ts";
import { RelayServer } from "../../../relay/src/server.ts";
import { RelayState } from "../../../relay/src/state.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import { expect, it } from "@effect/vitest";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as SelfRelay from "./SelfRelay.ts";
import { createPortProxy } from "./portProxy.ts";

class PairingApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
const lookup: NodeNet.LookupFunction = (_host, options, callback) =>
  options.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);
function request(
  port: number,
  host: string,
  path: string,
  options?: { body?: string; headers?: Record<string, string>; method?: string },
) {
  return new Promise<{
    status: number;
    body: string;
    headers: NodeHttp.IncomingHttpHeaders;
    fingerprint: string;
  }>((resolve, reject) => {
    const req = NodeHttps.request(
      {
        hostname: host,
        port,
        path,
        method: options?.method ?? "GET",
        headers: options?.headers,
        lookup,
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        const fingerprint = (response.socket as NodeTls.TLSSocket).getPeerCertificate()
          .fingerprint256;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: response.headers,
            fingerprint,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options?.body);
  });
}
it.live(
  "pairs via the real environment OAuth and ticket flow, preserves its certificate, and authorizes/revokes forwarded HTTP and WebSockets",
  () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "self-relay-e2e-")),
      );
      const local = NodeHttp.createServer((_request, response) =>
        response.end("loopback application"),
      );
      const localUpgrades = new WebSocketServer({ server: local });
      localUpgrades.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
      local.listen(0, "127.0.0.1");
      yield* Effect.promise(() => NodeEvents.EventEmitter.once(local, "listening"));
      const localAddress = local.address();
      if (!localAddress || typeof localAddress === "string") throw new Error("Missing port");
      const relayCert = testCertificate(directory, "localhost", "relay");
      const environmentCert = testCertificate(directory, "abcdef.localhost", "environment", [
        `${localAddress.port}-abcdef.localhost`,
      ]);
      const relayState = new RelayState(NodePath.join(directory, "relay.sqlite"));
      const keys = generateEnvironmentKeyPair();
      relayState.enroll(relayState.issueToken(), keys.publicKey, "abcdef");
      const relayServer = new RelayServer({
        relayHost: "localhost",
        state: relayState,
        bindHost: "::",
        tlsPort: 0,
        httpPort: 0,
        getSecureContext: async () => NodeTls.createSecureContext(relayCert),
      });
      const ports = yield* Effect.promise(() => relayServer.start());
      const origin = `https://abcdef.localhost:${ports.tlsPort}`;
      const configLayer = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${config.stateDir}/self-relay`, { recursive: true });
          yield* fs.writeFileString(
            `${config.stateDir}/self-relay/link.json`,
            JSON.stringify({
              ...keys,
              slug: "abcdef",
              relayUrl: `https://localhost:${ports.tlsPort}`,
              ports: [],
            }),
          );
          return config;
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "relay-pairing-test-" })),
      );
      const authLayer = EnvironmentAuth.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerEnvironment.layerIdentity),
      );
      const services = Layer.mergeAll(SelfRelay.layer, authLayer).pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ManagedPolicy.layerTest()),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        Layer.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              T3CODE_RELAY_CERT: environmentCert.certFile,
              T3CODE_RELAY_KEY: environmentCert.keyFile,
              T3CODE_RELAY_CA_CERT: relayCert.certFile,
            }),
          ),
        ),
      );
      const context = yield* Layer.build(services);
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Node HTTP and upgrade callbacks need a Promise adapter for the scoped production auth layer.
      const runPromise = Effect.runPromiseWith(context);
      return yield* Effect.promise(async () => {
        const runtime = { runPromise };
        const auth = await runtime.runPromise(EnvironmentAuth.EnvironmentAuth);
        const relay = await runtime.runPromise(SelfRelay.SelfRelay);
        const identity = await runtime.runPromise(ServerEnvironment.ServerEnvironmentIdentity);
        const environmentId = await runtime.runPromise(identity.getEnvironmentId);
        const web = HttpRouter.toWebHandler(
          HttpApiBuilder.layer(PairingApi).pipe(
            Layer.provide(AuthHttp.layer),
            Layer.provide(AuthHttp.layerAuthenticatedAuth),
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(Etag.layerWeak),
                Layer.provide(NodeServices.layer),
              ),
            ),
          ),
        );
        const app = NodeHttp.createServer((incoming, response) => {
          void (async () => {
            if (incoming.url === "/.well-known/t3/environment") {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  environmentId,
                  serverVersion: "test",
                  orchestrationProtocolVersion: 2,
                }),
              );
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            const result = await web.handler(
              new Request(origin + incoming.url, {
                method: incoming.method ?? "GET",
                headers: Object.fromEntries(
                  Object.entries(incoming.headers).flatMap(([name, value]) =>
                    typeof value === "string" ? [[name, value]] : [],
                  ),
                ),
                ...(body.length ? { body } : {}),
              }),
              context,
            );
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
          })().catch(() => {
            response.writeHead(500);
            response.end();
          });
        });
        const upgrades = new WebSocketServer({ noServer: true });
        app.on("upgrade", (incoming, socket, head) => {
          void runtime
            .runPromise(
              auth.authenticateWebSocketUpgrade(
                HttpServerRequest.fromWeb(new Request(origin + incoming.url)),
                "rpc",
              ),
            )
            .then(
              () =>
                upgrades.handleUpgrade(incoming, socket, head, (ws) => ws.send("authenticated")),
              () => {
                socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
              },
            );
        });
        const proxy = createPortProxy({
          publicOrigin: () => runtime.runPromise(relay.publicOrigin),
          authorize: (port, token) =>
            runtime.runPromise(
              relay
                .authorizePort(port, token)
                .pipe(
                  Effect.flatMap((grant) =>
                    grant === null
                      ? Effect.succeed(false)
                      : grant.sessionId
                        ? auth
                            .listSessions()
                            .pipe(
                              Effect.map((sessions) =>
                                sessions.some((session) => session.sessionId === grant.sessionId),
                              ),
                            )
                        : Effect.succeed(true),
                  ),
                ),
            ),
        });
        let socket: WebSocket | undefined;
        try {
          await runtime.runPromise(relay.attach(app, proxy.accept));
          await runtime.runPromise(relay.whenReady.pipe(Effect.timeout("10 seconds")));
          const descriptor = await request(
            ports.tlsPort,
            "abcdef.localhost",
            "/.well-known/t3/environment",
          );
          expect(descriptor.status).toBe(200);
          expect(JSON.parse(descriptor.body)).toMatchObject({ environmentId });
          expect(descriptor.fingerprint).toBe(
            new NodeCrypto.X509Certificate(environmentCert.cert).fingerprint256,
          );
          expect(descriptor.fingerprint).not.toBe(
            new NodeCrypto.X509Certificate(relayCert.cert).fingerprint256,
          );
          const credential = await runtime.runPromise(
            auth.issuePairingCredential({ scopes: ["orchestration:read"], label: "stock mobile" }),
          );
          const key = makeDpopKey();
          const iat = () => Math.floor(clock.currentTimeMillisUnsafe() / 1000);
          const exchanged = await request(ports.tlsPort, "abcdef.localhost", "/oauth/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              dpop: key.sign({
                method: "POST",
                url: origin + "/oauth/token",
                token: "",
                iat: iat(),
              }),
            },
            body: new URLSearchParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: credential.credential,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
              scope: "orchestration:read",
            }).toString(),
          });
          expect(exchanged.status, exchanged.body).toBe(200);
          const access = JSON.parse(exchanged.body) as { access_token: string; token_type: string };
          expect(access.token_type).toBe("DPoP");
          const ticketResult = await request(
            ports.tlsPort,
            "abcdef.localhost",
            "/api/auth/websocket-ticket",
            {
              method: "POST",
              headers: {
                authorization: `DPoP ${access.access_token}`,
                dpop: key.sign({
                  method: "POST",
                  url: origin + "/api/auth/websocket-ticket",
                  token: access.access_token,
                  iat: iat(),
                }),
              },
            },
          );
          expect(ticketResult.status, ticketResult.body).toBe(200);
          const { ticket } = JSON.parse(ticketResult.body) as { ticket: string };
          const wsUrl = new URL("/ws", origin);
          wsUrl.protocol = "wss:";
          wsUrl.searchParams.set("wsTicket", ticket);
          wsUrl.searchParams.set(
            "dpop",
            key.sign({ method: "GET", url: origin + "/ws", token: ticket, iat: iat() }),
          );
          socket = new WebSocket(wsUrl, { lookup, rejectUnauthorized: false });
          const authenticated = NodeEvents.EventEmitter.once(socket, "message");
          expect((await authenticated)[0].toString()).toBe("authenticated");
          socket.terminate();
          socket = undefined;
          const port = localAddress.port;
          const exposed = await runtime.runPromise(
            relay.exposePort({ port, access: "link", expiresInSeconds: 3600 }),
          );
          const forwardedHost = `${port}-abcdef.localhost`;
          expect((await request(ports.tlsPort, forwardedHost, "/")).status).toBe(303);
          const granted = await request(
            ports.tlsPort,
            forwardedHost,
            "/" + new URL(exposed.url).search,
          );
          expect(granted.status).toBe(303);
          expect(granted.headers["set-cookie"]?.[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
          const cookie = granted.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
          expect(
            (await request(ports.tlsPort, forwardedHost, "/", { headers: { cookie } })).body,
          ).toBe("loopback application");
          socket = new WebSocket(`wss://${forwardedHost}:${ports.tlsPort}/`, {
            lookup,
            rejectUnauthorized: false,
            headers: { cookie },
          });
          await NodeEvents.EventEmitter.once(socket, "open");
          const echoed = NodeEvents.EventEmitter.once(socket, "message");
          socket.send("forwarded");
          expect((await echoed)[0].toString()).toBe("forwarded");
          const closed = NodeEvents.EventEmitter.once(socket, "close");
          await runtime.runPromise(relay.unexposePort(port));
          await closed;
          expect(
            await runtime.runPromise(
              relay.authorizePort(port, new URL(exposed.url).searchParams.get("t") ?? ""),
            ),
          ).toBeNull();
          await runtime.runPromise(
            relay.exposePort({ port, access: "private", expiresInSeconds: 3600 }),
          );
          expect(
            (await request(ports.tlsPort, forwardedHost, "/", { headers: { cookie } })).status,
          ).toBe(303);
          const owner = await runtime.runPromise(
            auth.issueSession({ scopes: ["terminal:operate"] }),
          );
          const privateLink = await runtime.runPromise(relay.portLink(port, owner.sessionId));
          const privateGrant = await request(
            ports.tlsPort,
            forwardedHost,
            "/" + new URL(privateLink.url).search,
          );
          expect(privateGrant.status).toBe(303);
          const privateCookie = privateGrant.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
          expect(
            (
              await request(ports.tlsPort, forwardedHost, "/", {
                headers: { cookie: privateCookie },
              })
            ).body,
          ).toBe("loopback application");
          await runtime.runPromise(auth.revokeSession(owner.sessionId));
          expect(
            (
              await request(ports.tlsPort, forwardedHost, "/", {
                headers: { cookie: privateCookie },
              })
            ).status,
          ).toBe(303);
        } finally {
          socket?.terminate();
          upgrades.close();
          localUpgrades.close();
          local.closeAllConnections();
          await new Promise<void>((resolve) => local.close(() => resolve()));
          proxy.close();
          await web.dispose();
          await relayServer.close();
          relayState.close();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      });
    }),
);
