// Native TLS/WebSocket integration exercises real RelayServer + SelfRelay + PublicTunnels + publicHttp.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, PublicTunnelOperationError } from "@t3tools/contracts";
import { generateEnvironmentKeyPair } from "@t3tools/relay-tunnel/auth";
import { memoryKeychainStore } from "@t3tools/shared/credentialKeychain";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import WebSocket, { WebSocketServer } from "ws";
import { testCertificate } from "../../../../packages/relay-tunnel/src/testing/certificate.ts";
import { RelayServer } from "../../../relay/src/server.ts";
import { RelayState } from "../../../relay/src/state.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SelfRelay from "../selfRelay/SelfRelay.ts";
import { createPortProxy } from "../selfRelay/portProxy.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as PublicTunnels from "./PublicTunnels.ts";

const isPublicTunnelOperationError = Schema.is(PublicTunnelOperationError);

const lookup: NodeNet.LookupFunction = (_host, options, callback) =>
  options.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);

function tlsRequest(
  port: number,
  host: string,
  path: string,
  options?: { method?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
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
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it.live(
  "routes subdomain WebSocket echo and path mode X-Forwarded-Prefix across a real relay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rootDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-tunnels-int-")),
        );
        const envBaseDir = NodePath.join(rootDir, "env-base");
        const certDir = NodePath.join(rootDir, "cert");
        const staticDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".test-int-static-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(rootDir, { recursive: true, force: true }),
              NodeFSP.rm(staticDir, { recursive: true, force: true }),
            ]),
          ),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(envBaseDir, { recursive: true });
          await NodeFSP.mkdir(certDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(staticDir, "hello.txt"), "static-over-tls", "utf8");
        });

        const envSlug = "envint1";
        const publicDomain = "localhost";
        const relayCert = testCertificate(certDir, "localhost", "relay");
        const envCert = testCertificate(certDir, `${envSlug}.localhost`, "environment", [
          `pub-${envSlug}.${publicDomain}`,
          `echo-ws-${envSlug}.${publicDomain}`,
        ]);

        // Start upstream HTTP + WS echo server
        const upstreamServer = NodeHttp.createServer((req, res) => {
          if (req.url?.startsWith("/redirect-me")) {
            res.writeHead(302, {
              location: "/target",
              "set-cookie": "upstream=ok; Domain=localhost; Path=/",
            });
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              url: req.url,
              host: req.headers.host,
              prefix: req.headers["x-forwarded-prefix"] ?? null,
              forwardedProto: req.headers["x-forwarded-proto"] ?? null,
              forwardedHost: req.headers["x-forwarded-host"] ?? null,
              cookie: req.headers.cookie ?? null,
            }),
          );
        });
        const echoWss = new WebSocketServer({ server: upstreamServer });
        echoWss.on("connection", (ws) => {
          ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
        });
        yield* Effect.promise(async () => {
          upstreamServer.listen(0, "127.0.0.1");
          await NodeEvents.EventEmitter.once(upstreamServer, "listening");
        });
        const upstreamPort = (upstreamServer.address() as NodeNet.AddressInfo).port;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            echoWss.close();
            upstreamServer.close();
            upstreamServer.closeAllConnections();
          }),
        );

        // Start real RelayServer with publicHosts enabled
        const relayState = new RelayState(NodePath.join(rootDir, "relay.sqlite"));
        const envKeys = generateEnvironmentKeyPair();
        relayState.enroll(relayState.issueToken(), envKeys.publicKey, envSlug);
        const relayServer = new RelayServer({
          relayHost: "localhost",
          state: relayState,
          bindHost: "::",
          tlsPort: 0,
          httpPort: 0,
          getSecureContext: async () => NodeTls.createSecureContext(relayCert),
          publicHosts: true,
        });
        const ports = yield* Effect.promise(() => relayServer.start());
        const relayPort = ports.tlsPort;
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => relayServer.close()).pipe(
            Effect.andThen(Effect.sync(() => relayState.close())),
          ),
        );

        // Seed SelfRelay link.json inside ServerConfig stateDir
        const seededConfig = Layer.effect(
          ServerConfig.ServerConfig,
          Effect.gen(function* () {
            const cfg = yield* ServerConfig.ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(`${cfg.stateDir}/self-relay/certificates`, { recursive: true });
            yield* fs.writeFileString(
              `${cfg.stateDir}/self-relay/link.json`,
              JSON.stringify({
                relayUrl: `https://localhost:${relayPort}`,
                slug: envSlug,
                ...envKeys,
                ports: [],
              }),
            );
            return cfg;
          }),
        ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), envBaseDir)));

        const relayConfigLayer = Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            T3CODE_RELAY_CA_CERT: relayCert.certFile,
            T3CODE_RELAY_CERT: envCert.certFile,
            T3CODE_RELAY_KEY: envCert.keyFile,
          }),
        );

        const infraLayer = Layer.mergeAll(
          SqlitePersistence.layerMemory,
          ManagedPolicy.layerTest(),
          ServerSettingsService.ServerSettingsService.layerTest({
            publicTunnels: { enabled: true },
          }),
        ).pipe(
          Layer.provideMerge(seededConfig),
          Layer.provideMerge(relayConfigLayer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        );
        const baseDeps = Layer.mergeAll(
          infraLayer,
          ServerSecretStore.layerWithKeychain(memoryKeychainStore()).pipe(
            Layer.provideMerge(infraLayer),
          ),
        );
        const appLayer = Layer.mergeAll(
          baseDeps,
          ProjectStoreV2.layer.pipe(Layer.provide(baseDeps)),
        );
        const sharedRelay = SelfRelay.layer.pipe(Layer.provideMerge(appLayer));
        const sharedLayer = Layer.mergeAll(
          sharedRelay,
          PublicTunnels.layer.pipe(Layer.provideMerge(sharedRelay)),
        ).pipe(Layer.provideMerge(appLayer));

        yield* Effect.gen(function* () {
          const relay = yield* SelfRelay.SelfRelay;
          const tunnels = yield* PublicTunnels.PublicTunnels;

          const dummyServer = NodeHttp.createServer((_req, res) => res.writeHead(200).end("env"));
          const proxy = createPortProxy({
            publicOrigin: async () => `https://${envSlug}.localhost:${relayPort}`,
            authorize: async () => false,
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              proxy.close();
              dummyServer.close();
              dummyServer.closeAllConnections();
            }),
          );

          yield* relay.attach(dummyServer, proxy.accept);
          yield* relay.whenReady;

          // Verify SelfRelay status advertises publicHosts + null custom publicDomain (defaults to relayHost)
          const relayStatus = yield* relay.status;
          expect(relayStatus.publicHosts).toBe(true);
          expect(relayStatus.publicDomain).toBeNull();

          // 1) Unknown subdomain name refused before ACME (TLS handshake / stream closes cleanly)
          const refusedUnknown = yield* Effect.promise(() =>
            tlsRequest(relayPort, `does-not-exist-${envSlug}.${publicDomain}`, "/").then(
              () => false,
              () => true,
            ),
          );
          expect(refusedUnknown).toBe(true);

          const userCaller = {
            kind: "user" as const,
            sessionId: AuthSessionId.make("sess-int-1"),
          };

          // 2) Subdomain WebSocket echo tunnel
          const sub = yield* tunnels.create(
            {
              title: "Echo WS",
              target: { kind: "port", port: upstreamPort },
              routing: "subdomain",
              slug: "echo-ws",
            },
            userCaller,
          );
          expect(sub.tunnel.url).toBe(`https://echo-ws-${envSlug}.${publicDomain}/`);

          const ws = new WebSocket(`wss://echo-ws-${envSlug}.${publicDomain}:${relayPort}/chat`, {
            lookup,
            rejectUnauthorized: false,
          });
          yield* Effect.promise(() => NodeEvents.EventEmitter.once(ws, "open"));
          const msgPromise = NodeEvents.EventEmitter.once(ws, "message");
          ws.send("ping");
          const [echoReply] = yield* Effect.promise(() => msgPromise);
          expect(String(echoReply)).toBe("echo:ping");

          // Stopping tunnel disconnects active TLS-proxied WebSocket
          const wsClosePromise = NodeEvents.EventEmitter.once(ws, "close");
          yield* tunnels.remove(sub.tunnel.id);
          yield* Effect.promise(() => wsClosePromise);

          // 3) Path mode tunnel with X-Forwarded-Prefix, Location rewrite, and trailing slash 308
          const pathRes = yield* tunnels.create(
            {
              title: "Path App",
              target: { kind: "port", port: upstreamPort },
              routing: "path",
              slug: "path-app",
            },
            userCaller,
          );
          const rid = pathRes.tunnel.rid!;
          const pubHost = `pub-${envSlug}.${publicDomain}`;

          const noSlash = yield* Effect.promise(() =>
            tlsRequest(relayPort, pubHost, `/path-app/${rid}`),
          );
          expect(noSlash.status).toBe(308);
          expect(noSlash.headers.location).toBe(`/path-app/${rid}/`);

          const proxied = yield* Effect.promise(() =>
            tlsRequest(relayPort, pubHost, `/path-app/${rid}/hello?a=1`, {
              headers: { cookie: "__Host-p0-fake=leak; app=keep" },
            }),
          );
          expect(proxied.status).toBe(200);
          const body = JSON.parse(proxied.body) as {
            url: string;
            prefix: string | null;
            forwardedProto: string | null;
            cookie: string | null;
          };
          expect(body.url).toBe("/hello?a=1");
          expect(body.prefix).toBe(`/path-app/${rid}`);
          expect(body.forwardedProto).toBe("https");
          expect(body.cookie).toBe("app=keep");

          const redirected = yield* Effect.promise(() =>
            tlsRequest(relayPort, pubHost, `/path-app/${rid}/redirect-me`),
          );
          expect(redirected.status).toBe(302);
          expect(redirected.headers.location).toBe(`/path-app/${rid}/target`);
          expect(redirected.headers["set-cookie"]).toEqual(["upstream=ok; Path=/"]);

          // 4) Static folder over TLS
          const staticTunnel = yield* tunnels.create(
            {
              title: "Static",
              target: { kind: "folder", path: staticDir, listing: false, spa: false },
              routing: "path",
              slug: "docs",
            },
            userCaller,
          );
          const staticFile = yield* Effect.promise(() =>
            tlsRequest(relayPort, pubHost, `/docs/${staticTunnel.tunnel.rid}/hello.txt`),
          );
          expect(staticFile.status).toBe(200);
          expect(staticFile.body).toBe("static-over-tls");

          const traversalBlocked = yield* Effect.promise(() =>
            tlsRequest(relayPort, pubHost, `/docs/${staticTunnel.tunnel.rid}/%2e%2e/package.json`),
          );
          expect(traversalBlocked.status).toBe(403);
        }).pipe(Effect.provide(sharedLayer));
      }),
    ),
);

it.live("refuses public tunnel creation and SNI connections when relay lacks --public-hosts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rootDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-tunnels-nopub-")),
      );
      const envBaseDir = NodePath.join(rootDir, "env-base");
      const certDir = NodePath.join(rootDir, "cert");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(envBaseDir, { recursive: true });
        await NodeFSP.mkdir(certDir, { recursive: true });
      });
      const envSlug = "envnopub1";
      const relayCert = testCertificate(certDir, "localhost", "relay");
      const envCert = testCertificate(certDir, `${envSlug}.localhost`, "environment", [
        `pub-${envSlug}.localhost`,
      ]);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(rootDir, { recursive: true, force: true })),
      );

      const relayState = new RelayState(NodePath.join(rootDir, "relay.sqlite"));
      const envKeys = generateEnvironmentKeyPair();
      relayState.enroll(relayState.issueToken(), envKeys.publicKey, envSlug);
      const relayServer = new RelayServer({
        relayHost: "localhost",
        state: relayState,
        bindHost: "::",
        tlsPort: 0,
        httpPort: 0,
        getSecureContext: async () => NodeTls.createSecureContext(relayCert),
        publicHosts: false,
      });
      const ports = yield* Effect.promise(() => relayServer.start());
      const relayPort = ports.tlsPort;
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => relayServer.close()).pipe(
          Effect.andThen(Effect.sync(() => relayState.close())),
        ),
      );

      const seededConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${cfg.stateDir}/self-relay/certificates`, { recursive: true });
          yield* fs.writeFileString(
            `${cfg.stateDir}/self-relay/link.json`,
            JSON.stringify({
              relayUrl: `https://localhost:${relayPort}`,
              slug: envSlug,
              ...envKeys,
              ports: [],
            }),
          );
          return cfg;
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), envBaseDir)));

      const relayConfigLayer = Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          T3CODE_RELAY_CA_CERT: relayCert.certFile,
          T3CODE_RELAY_CERT: envCert.certFile,
          T3CODE_RELAY_KEY: envCert.keyFile,
        }),
      );

      const infraLayer = Layer.mergeAll(
        SqlitePersistence.layerMemory,
        ManagedPolicy.layerTest(),
        ServerSettingsService.ServerSettingsService.layerTest({ publicTunnels: { enabled: true } }),
      ).pipe(
        Layer.provideMerge(seededConfig),
        Layer.provideMerge(relayConfigLayer),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      );
      const baseDeps = Layer.mergeAll(
        infraLayer,
        ServerSecretStore.layerWithKeychain(memoryKeychainStore()).pipe(
          Layer.provideMerge(infraLayer),
        ),
      );
      const sharedRelay = SelfRelay.layer.pipe(Layer.provideMerge(baseDeps));
      const sharedLayer = Layer.mergeAll(
        sharedRelay,
        PublicTunnels.layer.pipe(Layer.provideMerge(sharedRelay)),
      ).pipe(Layer.provideMerge(baseDeps));

      yield* Effect.gen(function* () {
        const relay = yield* SelfRelay.SelfRelay;
        const tunnels = yield* PublicTunnels.PublicTunnels;
        const dummyServer = NodeHttp.createServer((_req, res) => res.writeHead(200).end("env"));
        const proxy = createPortProxy({
          publicOrigin: async () => `https://${envSlug}.localhost:${relayPort}`,
          authorize: async () => false,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            proxy.close();
            dummyServer.close();
            dummyServer.closeAllConnections();
          }),
        );

        yield* relay.attach(dummyServer, proxy.accept);
        yield* relay.whenReady;

        const err = yield* tunnels
          .create(
            { target: { kind: "port", port: 4444 }, routing: "subdomain", slug: "blocked" },
            { kind: "user", sessionId: AuthSessionId.make("sess-nopub") },
          )
          .pipe(Effect.flip);
        expect(isPublicTunnelOperationError(err)).toBe(true);
        if (isPublicTunnelOperationError(err)) {
          expect(err.reason).toBe("relay_unsupported");
        }
        const refusedPub = yield* Effect.promise(() =>
          tlsRequest(relayPort, `pub-${envSlug}.localhost`, "/").then(
            () => false,
            () => true,
          ),
        );
        expect(refusedPub).toBe(true);
      }).pipe(Effect.provide(sharedLayer));
    }),
  ),
);
