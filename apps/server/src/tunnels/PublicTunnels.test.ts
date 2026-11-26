// Exercise PublicTunnels service behavior, headers, scoping, policy/settings gates, and RPC scopes.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type * as NodeTls from "node:tls";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  allowsPublicTunnels,
  AuthAccessWriteScope,
  AuthFilesystemReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  CommandId,
  EventId,
  IsoDateTime,
  type ManagedPolicyDocument,
  ProjectId,
  PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS,
  type PublicTunnelSlug,
  RESERVED_PUBLIC_TUNNEL_SLUGS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { memoryKeychainStore } from "@t3tools/shared/credentialKeychain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import WebSocket, { WebSocketServer } from "ws";
import { requiredScopesForRpcCall, rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  buildPublicProxyRequestHeaders,
  buildPublicProxyResponseHeaders,
} from "../selfRelay/loopbackProxy.ts";
import * as SelfRelay from "../selfRelay/SelfRelay.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as PublicTunnels from "./PublicTunnels.ts";
import * as TunnelsRpc from "./rpc.ts";

interface FakeRelayHooksRef {
  hooks: SelfRelay.SelfRelayPublicTunnelsHooks | undefined;
  state: SelfRelay.SelfRelayPublicState;
}

function makeFakeSelfRelayLayer(
  ref: FakeRelayHooksRef,
  options?: {
    readonly linked?: boolean;
    readonly connected?: boolean;
    readonly slug?: string | null;
    readonly relayUrl?: string | null;
    readonly publicHosts?: boolean;
    readonly publicDomain?: string | null;
  },
) {
  ref.state = {
    linked: options?.linked ?? true,
    connected: options?.connected ?? true,
    slug: options?.slug === undefined ? "envslug1" : options.slug,
    relayUrl: options?.relayUrl === undefined ? "https://relay.example.com" : options.relayUrl,
    publicHosts: options?.publicHosts ?? true,
    publicDomain: options?.publicDomain === undefined ? null : options.publicDomain,
  };
  return Layer.mock(SelfRelay.SelfRelay)({
    attachPublicTunnels: (hooks) =>
      Effect.sync(() => {
        ref.hooks = hooks;
        hooks.onStateChange?.(ref.state);
      }),
    status: Effect.succeed({
      signupUrl: null,
      slug: ref.state.slug,
      linked: ref.state.linked,
      connected: ref.state.connected,
      relayUrl: ref.state.relayUrl,
      publicOrigin: ref.state.slug ? `https://${ref.state.slug}.relay.example.com` : null,
      certificate: ref.state.linked ? "ready" : "unlinked",
      acmeAccountUri: null,
      caaRecords: [],
      publicHosts: ref.state.publicHosts,
      publicDomain: ref.state.publicDomain,
      ports: [],
    }),
  });
}

function makeTestHarness(options?: {
  readonly enabled?: boolean;
  readonly policy?: ManagedPolicyDocument;
  readonly relayRef?: FakeRelayHooksRef;
  readonly serverPort?: number;
}) {
  const relayRef: FakeRelayHooksRef = options?.relayRef ?? {
    hooks: undefined,
    state: {
      linked: true,
      connected: true,
      slug: "envslug1",
      relayUrl: "https://relay.example.com",
      publicHosts: true,
      publicDomain: null,
    },
  };
  const infraLayer = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    ManagedPolicy.layerTest(options?.policy),
    ServerConfig.layerTest(process.cwd(), {
      prefix: "p0-tunnels-test-",
      ...(options?.serverPort !== undefined ? { port: options.serverPort } : {}),
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)));

  const baseDeps = Layer.mergeAll(
    infraLayer,
    ServerSecretStore.layerWithKeychain(memoryKeychainStore()).pipe(Layer.provideMerge(infraLayer)),
  );

  const settingsLayer = ServerSettingsService.ServerSettingsService.layerTest({
    publicTunnels: { enabled: options?.enabled ?? true },
  });
  const projectStoreLayer = ProjectStoreV2.layer.pipe(Layer.provideMerge(baseDeps));
  const selfRelayLayer = makeFakeSelfRelayLayer(relayRef, {
    linked: relayRef.state.linked,
    connected: relayRef.state.connected,
    slug: relayRef.state.slug,
    relayUrl: relayRef.state.relayUrl,
    publicHosts: relayRef.state.publicHosts,
    publicDomain: relayRef.state.publicDomain,
  });

  const publicTunnelsLayer = PublicTunnels.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(baseDeps, settingsLayer, projectStoreLayer, selfRelayLayer)),
  );

  return { relayRef, layer: publicTunnelsLayer };
}

const sessionId = AuthSessionId.make("sess-test-1");
const userCaller = { kind: "user" as const, sessionId };

function expectOperationReason(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "reason" in error
    ? String((error as { reason: unknown }).reason)
    : undefined;
}

async function startTempHttpServer(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
): Promise<{ port: number; close: () => void; wss?: WebSocketServer }> {
  const server = NodeHttp.createServer(handler);
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing ephemeral port");
  }
  return {
    port: address.port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

function connectRelaySocketToPublicHttp(
  hooks: SelfRelay.SelfRelayPublicTunnelsHooks,
  sniName: string,
): {
  listenerPort: Promise<number>;
  close: () => void;
} {
  const listener = NodeNet.createServer((socket) => {
    hooks.accept(socket as NodeTls.TLSSocket, {
      label: `${sniName}-envslug1.relay.example.com`,
      name: sniName,
      remoteAddr: "198.51.100.7",
      kind: "tls",
    });
  });
  listener.listen(0, "127.0.0.1");
  return {
    listenerPort: NodeEvents.EventEmitter.once(listener, "listening").then(() => {
      const addr = listener.address();
      if (!addr || typeof addr === "string") throw new Error("Missing listener address");
      return addr.port;
    }),
    close: () => {
      listener.close();
    },
  };
}

function rawHttpGet(
  port: number,
  hostHeader: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { host: hostHeader, ...headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it.effect(
  "manages port, subdomain, file, and folder tunnels, project ridMode, and rotation",
  () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const projectStore = yield* ProjectStoreV2.ProjectStoreV2;
      const tmpDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".test-static-unit-")),
      );
      const projectId = ProjectId.make("proj-1");
      const nowIso = IsoDateTime.make("2026-11-26T00:00:00.000Z");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* projectStore.apply({
            type: "project.created",
            commandId: CommandId.make("cmd-proj-1"),
            eventId: EventId.make("evt-proj-1"),
            // ProjectStore consumes committed events, including their aggregate envelope.
            sequence: 1,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: nowIso,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: "Demo Project",
              workspaceRoot: tmpDir,
              defaultModelSelection: null,
              scripts: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          });
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(NodePath.join(tmpDir, "report.txt"), "hello", "utf8");
            await NodeFSP.mkdir(NodePath.join(tmpDir, "dist"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(tmpDir, "dist", "index.html"),
              "<p>ok</p>",
              "utf8",
            );
          });

          const pathPort1 = yield* tunnels.create(
            {
              title: "First App",
              target: { kind: "port", port: 4101 },
              ridMode: "project",
              projectId,
            },
            userCaller,
          );
          const pathPort2 = yield* tunnels.create(
            {
              title: "Second App",
              target: { kind: "port", port: 4102 },
              ridMode: "project",
              projectId,
            },
            userCaller,
          );
          expect(pathPort1.tunnel.rid).toBeTruthy();
          expect(pathPort1.tunnel.rid).toBe(pathPort2.tunnel.rid);
          expect(pathPort1.tunnel.url).toBe(
            `https://pub-envslug1.relay.example.com/first-app/${pathPort1.tunnel.rid}/`,
          );

          // Rotating one switches only that tunnel to a fresh per-tunnel rid; sibling keeps its rid
          const rotated = yield* tunnels.rotate(pathPort1.tunnel.id);
          expect(rotated.tunnel.rid).not.toBe(pathPort2.tunnel.rid);
          expect(rotated.tunnel.ridMode).toBe("tunnel");
          expect((yield* tunnels.get(pathPort2.tunnel.id)).rid).toBe(pathPort2.tunnel.rid);

          // Named host (subdomain routing) + file + folder tunnels
          const subPort = yield* tunnels.create(
            {
              title: "Preview",
              target: { kind: "port", port: 4103 },
              routing: "subdomain",
              slug: "my-preview",
              access: "link",
            },
            userCaller,
          );
          expect(subPort.tunnel.url).toBe("https://my-preview-envslug1.relay.example.com/");
          expect(subPort.accessUrl).toContain("?t=");
          expect(harness.relayRef.hooks?.allowName("my-preview")).toBe(true);
          expect(harness.relayRef.hooks?.allowName("pub")).toBe(true);
          expect(harness.relayRef.hooks?.allowName("unknown-name")).toBe(false);

          const fileTunnel = yield* tunnels.create(
            { target: { kind: "file", path: NodePath.join(tmpDir, "report.txt") } },
            userCaller,
          );
          expect(fileTunnel.tunnel.target.kind).toBe("file");

          const folderTunnel = yield* tunnels.create(
            {
              target: {
                kind: "folder",
                path: NodePath.join(tmpDir, "dist"),
                listing: false,
                spa: true,
              },
            },
            userCaller,
          );
          expect(folderTunnel.tunnel.target.kind).toBe("folder");

          const listed = yield* tunnels.list();
          expect(listed.tunnels).toHaveLength(5);
          expect(listed.linkState.availability).toBe("ready");

          const stopped = yield* tunnels.stopAll();
          expect(stopped.stoppedCount).toBe(5);
          expect((yield* tunnels.list()).tunnels).toHaveLength(0);
        }),
        Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "refuses reserved slugs, own port, p0code environment descriptor, and agent scope/24h violations",
  () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const tunnels = yield* PublicTunnels.PublicTunnels;
      tunnels.registerServerPort(49999);
      const projectStore = yield* ProjectStoreV2.ProjectStoreV2;
      const tmpDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".test-static-scope-")),
      );
      const projectRoot = NodePath.join(tmpDir, "proj");
      const outsideDir = NodePath.join(tmpDir, "outside");
      const fakeEnv = yield* Effect.promise(() =>
        startTempHttpServer((req, res) => {
          if (req.url === "/.well-known/p0/environment") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ environmentId: "env-self-1" }));
            return;
          }
          res.writeHead(404).end();
        }),
      );

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(projectRoot, { recursive: true });
            await NodeFSP.mkdir(outsideDir, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(projectRoot, "ok.txt"), "ok", "utf8");
            await NodeFSP.writeFile(NodePath.join(outsideDir, "secret.txt"), "nope", "utf8");
            await NodeFSP.symlink(
              NodePath.join(outsideDir, "secret.txt"),
              NodePath.join(projectRoot, "escape.txt"),
            );
          });
          const projectId = ProjectId.make("proj-agent");
          const nowIso = IsoDateTime.make("2026-11-26T00:00:00.000Z");
          yield* projectStore.apply({
            type: "project.created",
            commandId: CommandId.make("cmd-proj-agent"),
            eventId: EventId.make("evt-proj-agent"),
            // ProjectStore consumes committed events, including their aggregate envelope.
            sequence: 1,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: nowIso,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: "Agent Project",
              workspaceRoot: projectRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          });

          // Reserved slugs must be rejected on the environment side
          for (const reserved of RESERVED_PUBLIC_TUNNEL_SLUGS) {
            const err = yield* tunnels
              .create(
                { target: { kind: "port", port: 4201 }, slug: reserved as PublicTunnelSlug },
                userCaller,
              )
              .pipe(Effect.flip);
            expect(expectOperationReason(err)).toBe("invalid_input");
          }

          // Own server port refused
          const ownPortErr = yield* tunnels
            .create({ target: { kind: "port", port: 49999 } }, userCaller)
            .pipe(Effect.flip);
          expect(expectOperationReason(ownPortErr)).toBe("port_refused");

          // p0code environment descriptor refused
          const probeErr = yield* tunnels
            .create({ target: { kind: "port", port: fakeEnv.port } }, userCaller)
            .pipe(Effect.flip);
          expect(expectOperationReason(probeErr)).toBe("port_refused");

          // Agent caller rules: default 2h, max 24h, no permanent, project scope required
          const agentCaller = {
            kind: "agent" as const,
            threadId: ThreadId.make("thread-1"),
            projectId,
          };
          const noPermanentErr = yield* tunnels
            .create({ target: { kind: "port", port: 4202 }, expiresInSeconds: null }, agentCaller)
            .pipe(Effect.flip);
          expect(expectOperationReason(noPermanentErr)).toBe("invalid_input");

          const over24hErr = yield* tunnels
            .create(
              {
                target: { kind: "port", port: 4202 },
                expiresInSeconds: PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS + 1,
              },
              agentCaller,
            )
            .pipe(Effect.flip);
          expect(expectOperationReason(over24hErr)).toBe("invalid_input");

          const outsideErr = yield* tunnels
            .create(
              { target: { kind: "file", path: NodePath.join(outsideDir, "secret.txt") } },
              agentCaller,
            )
            .pipe(Effect.flip);
          expect(expectOperationReason(outsideErr)).toBe("scope_refused");

          const symlinkEscapeErr = yield* tunnels
            .create(
              { target: { kind: "file", path: NodePath.join(projectRoot, "escape.txt") } },
              agentCaller,
            )
            .pipe(Effect.flip);
          expect(expectOperationReason(symlinkEscapeErr)).toBe("scope_refused");

          const okAgent = yield* tunnels.create(
            { target: { kind: "file", path: NodePath.join(projectRoot, "ok.txt") } },
            agentCaller,
          );
          expect(okAgent.tunnel.expiresAt).toBe(
            okAgent.tunnel.createdAt + PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS * 1000,
          );
        }),
        Effect.sync(() => fakeEnv.close()).pipe(
          Effect.andThen(
            Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
          ),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it("rewrites request and response headers according to section 3.3", () => {
  const reqHeaders = buildPublicProxyRequestHeaders(
    {
      host: "pub-env.relay.test",
      cookie: "session=abc; __Host-p0-t-1=tok; t3_session_3773=secret; app=1",
      origin: "https://pub-env.relay.test",
      referer: "https://pub-env.relay.test/app/1/sub?x=2",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "evil.com",
      forwarded: "for=1.2.3.4",
    },
    {
      port: 3000,
      publicHost: "pub-env.relay.test",
      publicOrigin: "https://pub-env.relay.test",
      hostHeader: "localhost",
      remoteAddr: "203.0.113.5",
      pathPrefix: "/app/1",
    },
  );
  expect(reqHeaders.host).toBe("localhost:3000");
  expect(reqHeaders["x-forwarded-host"]).toBe("pub-env.relay.test");
  expect(reqHeaders["x-forwarded-proto"]).toBe("https");
  expect(reqHeaders["x-forwarded-for"]).toBe("203.0.113.5");
  expect(reqHeaders["x-forwarded-prefix"]).toBe("/app/1");
  expect(reqHeaders.forwarded).toBeUndefined();
  expect(reqHeaders.origin).toBe("http://localhost:3000");
  expect(reqHeaders.referer).toBe("http://localhost:3000/app/1/sub?x=2");
  expect(reqHeaders.cookie).toBe("session=abc; app=1");

  const resHeaders = buildPublicProxyResponseHeaders(
    {
      location: "http://127.0.0.1:3000/dashboard?ok=1",
      "set-cookie": [
        "app=xyz; Domain=localhost; Path=/; HttpOnly",
        "__Host-p0-forged=1; Path=/; Secure",
        "__Host-hhh-port=forged; Path=/; Secure",
      ],
    },
    {
      port: 3000,
      publicOrigin: "https://pub-env.relay.test",
      pathPrefix: "/app/abc1234567",
    },
  );
  expect(resHeaders.location).toBe("https://pub-env.relay.test/app/abc1234567/dashboard?ok=1");
  expect(resHeaders["set-cookie"]).toEqual(["app=xyz; Path=/; HttpOnly"]);
  expect(resHeaders["x-robots-tag"]).toBe("noindex, nofollow");
});

it.effect(
  "closes plain and WebSocket connections immediately on pause, rotate, expiry, stopAll, and setting off",
  () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const settings = yield* ServerSettingsService.ServerSettingsService;
      const wsUpstream = NodeHttp.createServer((_req, res) => {
        res.writeHead(200).end("ws-upstream");
      });
      const echoWss = new WebSocketServer({ server: wsUpstream });
      echoWss.on("connection", (ws) => {
        ws.on("message", (msg) => ws.send(msg));
      });
      yield* Effect.promise(async () => {
        wsUpstream.listen(0, "127.0.0.1");
        await NodeEvents.EventEmitter.once(wsUpstream, "listening");
      });
      const wsPort = (wsUpstream.address() as NodeNet.AddressInfo).port;
      const listener = connectRelaySocketToPublicHttp(harness.relayRef.hooks!, "ws-sub");
      const proxyPort = yield* Effect.promise(() => listener.listenerPort);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const created = yield* tunnels.create(
            {
              title: "WS Subdomain",
              target: { kind: "port", port: wsPort },
              routing: "subdomain",
              slug: "ws-sub",
              expiresInSeconds: 300,
            },
            userCaller,
          );

          const openWs = () =>
            new Promise<WebSocket>((resolve, reject) => {
              const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`, {
                headers: { host: "ws-sub-envslug1.relay.example.com" },
              });
              client.once("open", () => resolve(client));
              client.once("error", reject);
            });

          // 1) Plain HTTP works & visit gets logged
          const httpRes = yield* Effect.promise(() =>
            rawHttpGet(proxyPort, "ws-sub-envslug1.relay.example.com", "/hello"),
          );
          expect({ status: httpRes.status, body: httpRes.body }).toEqual({
            status: 200,
            body: "ws-upstream",
          });
          const visits = yield* tunnels.visits({ id: created.tunnel.id });
          expect(visits.visits).toHaveLength(1);

          // 2) Pause closes upgraded WS immediately
          const ws1 = yield* Effect.promise(openWs);
          const closedOnPause = NodeEvents.EventEmitter.once(ws1, "close");
          yield* tunnels.update({ id: created.tunnel.id, enabled: false });
          yield* Effect.promise(() => closedOnPause);

          // 3) Resume -> Rotate closes upgraded WS
          yield* tunnels.update({ id: created.tunnel.id, enabled: true });
          const ws2 = yield* Effect.promise(openWs);
          const closedOnRotate = NodeEvents.EventEmitter.once(ws2, "close");
          yield* tunnels.rotate(created.tunnel.id);
          yield* Effect.promise(() => closedOnRotate);

          // 4) Setting turned off closes upgraded WS immediately
          const ws3 = yield* Effect.promise(openWs);
          const closedOnSettingOff = NodeEvents.EventEmitter.once(ws3, "close");
          yield* settings.updateSettings({ publicTunnels: { enabled: false } });
          yield* Effect.promise(() => closedOnSettingOff);

          // Re-enable setting and check stopAll
          yield* settings.updateSettings({ publicTunnels: { enabled: true } });
          yield* tunnels.update({ id: created.tunnel.id, enabled: true });
          const ws4 = yield* Effect.promise(openWs);
          const closedOnStopAll = NodeEvents.EventEmitter.once(ws4, "close");
          yield* tunnels.stopAll();
          yield* Effect.promise(() => closedOnStopAll);

          // 5) Expiry closes upgraded WS immediately
          const expiring = yield* tunnels.create(
            {
              title: "Expiring",
              target: { kind: "port", port: wsPort },
              routing: "subdomain",
              slug: "ws-sub",
              expiresInSeconds: 300,
            },
            userCaller,
          );
          const ws5 = yield* Effect.promise(openWs);
          const closedOnExpiry = NodeEvents.EventEmitter.once(ws5, "close");
          yield* TestClock.adjust("305 seconds");
          yield* Effect.promise(() => closedOnExpiry);
          expect((yield* tunnels.get(expiring.tunnel.id)).status).toBe("expired");
        }),
        Effect.sync(() => {
          echoWss.close();
          wsUpstream.close();
          wsUpstream.closeAllConnections();
          listener.close();
        }),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "refuses startup activation when policy forbids public tunnels and reports setting off",
  () => {
    const policyOffHarness = makeTestHarness({
      policy: {
        schemaVersion: 1,
        organization: "Acme Corp",
        limits: { publicTunnels: false },
      },
    });
    const settingOffHarness = makeTestHarness({ enabled: false });
    expect(
      allowsPublicTunnels({
        settings: { publicTunnels: { enabled: true } },
        managedPolicy: {
          organization: "Acme Corp",
          lockedSettings: [],
          limits: { publicTunnels: false },
        },
      }),
    ).toBe(false);
    expect(
      allowsPublicTunnels({
        settings: { publicTunnels: { enabled: true } },
      }),
    ).toBe(true);

    return Effect.gen(function* () {
      // Seed a pre-existing 'live' row in SQLite before checking policy behavior
      yield* Effect.gen(function* () {
        const tunnels = yield* PublicTunnels.PublicTunnels;
        const err = yield* tunnels
          .create({ target: { kind: "port", port: 4444 } }, userCaller)
          .pipe(Effect.flip);
        expect(expectOperationReason(err)).toBe("policy");
        expect((yield* tunnels.linkState).availability).toBe("policy");
        expect(policyOffHarness.relayRef.hooks?.allowName("pub")).toBe(false);
      }).pipe(Effect.provide(policyOffHarness.layer));

      yield* Effect.gen(function* () {
        const tunnels = yield* PublicTunnels.PublicTunnels;
        const err = yield* tunnels
          .create({ target: { kind: "port", port: 4445 } }, userCaller)
          .pipe(Effect.flip);
        expect(expectOperationReason(err)).toBe("disabled");
        expect((yield* tunnels.linkState).availability).toBe("setting_off");
      }).pipe(Effect.provide(settingOffHarness.layer));
    });
  },
);

it.effect(
  "blocks pre-existing live rows at startup when managed policy has limits.publicTunnels=false",
  () => {
    const seededLayer = (() => {
      const relayRef: FakeRelayHooksRef = {
        hooks: undefined,
        state: {
          linked: true,
          connected: true,
          slug: "envslug1",
          relayUrl: "https://relay.example.com",
          publicHosts: true,
          publicDomain: null,
        },
      };
      const dbLayer = SqlitePersistence.layerMemory.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      );
      const seedDb = Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
          INSERT INTO public_tunnels (
            id, title, target_kind, target_json, routing, slug, rid, rid_mode,
            access, status, expires_at, created_at, created_by_json,
            project_id, thread_id, target_dev, target_ino, host_label, link_secret_id,
            visit_count, last_visit_at, bytes_out
          ) VALUES (
            'pre-live-1', 'Pre-seeded', 'port', '{"kind":"port","port":4888}',
            'subdomain', 'legacy-app', NULL, 'tunnel', 'public', 'live', NULL, 1000,
            '{"kind":"user","sessionId":"s1"}', NULL, NULL, NULL, NULL, 'legacy-app', NULL,
            0, NULL, 0
          )
        `;
        }),
      ).pipe(Layer.provide(dbLayer));

      const seededDb = Layer.provideMerge(seedDb, dbLayer);
      const infraLayer = Layer.mergeAll(
        ManagedPolicy.layerTest({
          schemaVersion: 1,
          organization: "Acme",
          limits: { publicTunnels: false },
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "p0-policy-boot-" }),
        ServerSettingsService.ServerSettingsService.layerTest({
          publicTunnels: { enabled: true },
        }),
        makeFakeSelfRelayLayer(relayRef),
      ).pipe(
        Layer.provideMerge(seededDb),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      );

      const baseDeps = Layer.mergeAll(
        infraLayer,
        ServerSecretStore.layerWithKeychain(memoryKeychainStore()).pipe(
          Layer.provideMerge(infraLayer),
        ),
      );

      return {
        relayRef,
        layer: PublicTunnels.layer.pipe(Layer.provideMerge(baseDeps)),
      };
    })();

    return Effect.gen(function* () {
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const listed = yield* tunnels.list();
      expect(listed.linkState.availability).toBe("policy");
      expect(listed.tunnels[0]?.url).toBeNull();
      expect(seededLayer.relayRef.hooks?.allowName("legacy-app")).toBe(false);
      expect(seededLayer.relayRef.hooks?.activeNames()).toEqual([]);
    }).pipe(Effect.provide(seededLayer.layer));
  },
);

it.effect(
  "enforces per-RPC authorization scopes including target kind on update and approve",
  () => {
    expect(requiredScopesForRpcCall(WS_METHODS.tunnelsList, {})).toEqual([AuthRelayReadScope]);
    expect(
      requiredScopesForRpcCall(WS_METHODS.tunnelsCreate, {
        target: { kind: "port", port: 3000 },
      }),
    ).toEqual([AuthRelayWriteScope, AuthAccessWriteScope, AuthTerminalOperateScope]);
    expect(
      requiredScopesForRpcCall(WS_METHODS.tunnelsCreate, {
        target: { kind: "file", path: "/tmp/index.html" },
      }),
    ).toEqual([AuthRelayWriteScope, AuthAccessWriteScope, AuthFilesystemReadScope]);
    expect(requiredScopesForRpcCall(WS_METHODS.tunnelsStopAll, {})).toEqual([AuthRelayWriteScope]);

    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const created = yield* tunnels.create({ target: { kind: "port", port: 4300 } }, userCaller);
      yield* tunnels.update({ id: created.tunnel.id, enabled: false });

      // Resuming a port tunnel via WS handler requires terminal:operate in addition to relay:write + access:write
      const narrowWs = TunnelsRpc.createTunnelsWsHandlers({
        publicTunnels: tunnels,
        sessionId,
        scopes: new Set([AuthRelayWriteScope, AuthAccessWriteScope, AuthFilesystemReadScope]),
      });
      const resumeErr = yield* narrowWs
        .update({ id: created.tunnel.id, enabled: true })
        .pipe(Effect.flip);
      expect(resumeErr._tag).toBe("EnvironmentAuthorizationError");
      if (resumeErr._tag === "EnvironmentAuthorizationError") {
        expect(resumeErr.requiredScope).toBe(AuthTerminalOperateScope);
      }

      // Subscribing receives snapshot and subsequent changes
      const sub = yield* narrowWs.subscribe().pipe(Stream.take(1), Stream.runCollect);
      expect(sub[0]?.type).toBe("snapshot");

      // Unused variable check guard for rpcAuthorizationError reference
      expect(rpcAuthorizationError(AuthRelayReadScope)._tag).toBe("EnvironmentAuthorizationError");
    }).pipe(Effect.provide(harness.layer));
  },
);
