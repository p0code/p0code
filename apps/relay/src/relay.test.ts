import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vite-plus/test";
import { generateEnvironmentKeyPair } from "@t3tools/relay-tunnel/auth";
import { RelayTunnelClient } from "@t3tools/relay-tunnel/client";
import { HttpChallengeStore } from "@t3tools/relay-tunnel/certificates";
import { testCertificate } from "../../../packages/relay-tunnel/src/testing/certificate.ts";
import { LinkConflictError, RelayState } from "./state.ts";
import { RelayServer, sourceKey } from "./server.ts";

const lookup: NodeNet.LookupFunction = (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};
function httpsRequest(
  options: NodeHttps.RequestOptions,
  body?: string,
): Promise<{ status: number; body: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const req = NodeHttps.request(
      { ...options, rejectUnauthorized: false, lookup, agent: false },
      (res) => {
        const fingerprint = (res.socket as NodeTls.TLSSocket).getPeerCertificate().fingerprint256;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            fingerprint,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
function plainRequest(
  port: number,
  host: string,
  path: string,
): Promise<{ status: number; body: string; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      { host: "127.0.0.1", port, path, headers: { host }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            location: res.headers.location,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const ACCOUNT_PASSWORD = "correct horse battery";
/** GET without a body, POST with JSON; auth endpoints live on the relay's own host. */
function authRequest(
  port: number,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; fingerprint: string }> {
  return httpsRequest(
    {
      hostname: "relay.test",
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
    },
    body === undefined ? undefined : JSON.stringify(body),
  );
}

it("enrolls over HTTPS, passes environment TLS/HTTP/WS and port hosts end to end, and revokes live tunnels", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-"));
  const relayCert = testCertificate(directory, "relay.test");
  const envCert = testCertificate(directory, "*.relay.test", "env");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relayChallenges = new HttpChallengeStore();
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    challenges: relayChallenges,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(relayCert),
  });
  const app = NodeHttp.createServer((req, res) => res.end(`environment:${req.url}`));
  const forwarded = NodeHttp.createServer((_req, res) => res.end("forwarded loopback app"));
  const upgrades = new WebSocketServer({ noServer: true });
  app.on("upgrade", (req, socket, head) =>
    upgrades.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => ws.send(data.toString()));
    }),
  );
  forwarded.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(forwarded, "listening");
  const forwardedAddress = forwarded.address();
  if (!forwardedAddress || typeof forwardedAddress === "string") throw new Error("Missing port");
  const forwardedPort = forwardedAddress.port;
  const allowed: Array<{ port: number } | { name: string }> = [];
  let client: RelayTunnelClient | undefined;
  let replacement: RelayTunnelClient | undefined;
  let websocket: WebSocket | undefined;
  try {
    const ports = await relay.start();
    expect((await plainRequest(ports.httpPort, "attacker.example", "/redirect")).status).toBe(421);
    const token = state.issueToken();
    const keys = generateEnvironmentKeyPair();
    const enrollment = await httpsRequest(
      {
        hostname: "relay.test",
        port: ports.tlsPort,
        path: "/_hhh/enroll",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      JSON.stringify({ token, publicKey: keys.publicKey, desiredSlug: "abcdef" }),
    );
    expect(enrollment.status).toBe(201);
    expect(JSON.parse(enrollment.body)).toEqual({ slug: "abcdef", relayHost: "relay.test" });
    expect(
      (
        await httpsRequest(
          { hostname: "relay.test", port: ports.tlsPort, path: "/_hhh/enroll", method: "POST" },
          JSON.stringify({ token, publicKey: keys.publicKey }),
        )
      ).status,
    ).toBe(400);
    const challenges = new HttpChallengeStore();
    challenges.set("abcdef.relay.test", "challenge-token", "proof");
    relayChallenges.set("relay.test", "relay-token", "relay-proof");
    const options = {
      relayUrl: `https://relay.test:${ports.tlsPort}`,
      slug: "abcdef",
      privateKey: keys.privateKey,
      challenges,
      webSocketOptions: { rejectUnauthorized: false, lookup },
      allowLabel: (label: { port: number } | { name: string }) => {
        allowed.push(label);
        return "port" in label && label.port === forwardedPort;
      },
      getSecureContext: async () => NodeTls.createSecureContext(envCert),
      onSecureConnection: (socket: NodeTls.TLSSocket, metadata: { port?: number }) => {
        if (metadata.port) {
          const local = NodeNet.connect({ host: "127.0.0.1", port: metadata.port });
          local.on("error", () => socket.destroy());
          socket.on("close", () => local.destroy());
          socket.pipe(local).pipe(socket);
        } else app.emit("connection", socket);
      },
    };
    client = new RelayTunnelClient(options);
    const connected = NodeEvents.EventEmitter.once(client, "connected");
    client.start();
    await connected;
    expect(client.relayInfo).toEqual({ features: [] });
    const reply = await httpsRequest({
      hostname: "abcdef.relay.test",
      port: ports.tlsPort,
      path: "/hello",
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("environment:/hello");
    expect(reply.fingerprint).toBe(new NodeCrypto.X509Certificate(envCert.cert).fingerprint256);
    expect(reply.fingerprint).not.toBe(
      new NodeCrypto.X509Certificate(relayCert.cert).fingerprint256,
    );
    const portReply = await httpsRequest({
      hostname: `${forwardedPort}-abcdef.relay.test`,
      port: ports.tlsPort,
      path: "/",
    });
    expect(portReply.body).toBe("forwarded loopback app");
    expect(portReply.fingerprint).toBe(reply.fingerprint);
    websocket = new WebSocket(`wss://abcdef.relay.test:${ports.tlsPort}/ws`, {
      lookup,
      rejectUnauthorized: false,
    });
    await NodeEvents.EventEmitter.once(websocket, "open");
    const message = NodeEvents.EventEmitter.once(websocket, "message");
    websocket.send("encrypted upgrade");
    expect((await message)[0].toString()).toBe("encrypted upgrade");
    expect(
      await plainRequest(
        ports.httpPort,
        "abcdef.relay.test",
        "/.well-known/acme-challenge/challenge-token",
      ),
    ).toMatchObject({ status: 200, body: "proof" });
    expect(
      await plainRequest(ports.httpPort, "relay.test", "/.well-known/acme-challenge/relay-token"),
    ).toMatchObject({ status: 200, body: "relay-proof" });
    expect(await plainRequest(ports.httpPort, "abcdef.relay.test", "/hello")).toMatchObject({
      status: 308,
      location: "https://abcdef.relay.test/hello",
    });
    expect(
      (await httpsRequest({ hostname: "relay.test", port: ports.tlsPort, path: "/healthz" })).body,
    ).toBe("ok\n");
    await expect(
      httpsRequest({ hostname: "unknown.relay.test", port: ports.tlsPort, path: "/" }),
    ).rejects.toThrow();
    await expect(
      httpsRequest({ hostname: "1-abcdef.relay.test", port: ports.tlsPort, path: "/" }),
    ).rejects.toThrow();
    // Public hosts are off: a name label is refused at SNI and never reaches the environment.
    await expect(
      httpsRequest({ hostname: "docs-abcdef.relay.test", port: ports.tlsPort, path: "/" }),
    ).rejects.toThrow();
    expect(allowed.some((label) => "name" in label)).toBe(false);
    const disconnected = NodeEvents.EventEmitter.once(client, "disconnected");
    replacement = new RelayTunnelClient(options);
    const replacementConnected = NodeEvents.EventEmitter.once(replacement, "connected");
    replacement.start();
    await replacementConnected;
    await disconnected;
    client.stop();
    const replacementDisconnected = NodeEvents.EventEmitter.once(replacement, "disconnected");
    expect(relay.revoke("abcdef")).toBe(true);
    await replacementDisconnected;
    expect(state.list()).toEqual([]);
  } finally {
    websocket?.terminate();
    client?.stop();
    replacement?.stop();
    for (const ws of upgrades.clients) ws.terminate();
    upgrades.close();
    app.closeAllConnections();
    app.close();
    forwarded.closeAllConnections();
    await relay.close();
    await new Promise<void>((resolve) => forwarded.close(() => resolve()));
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("persists one-time hashed tokens and transactional slug reservations across admin processes", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-state-"));
  const path = NodePath.join(directory, "state.sqlite");
  const state = new RelayState(path);
  const other = new RelayState(path);
  try {
    const keys = generateEnvironmentKeyPair();
    const token = state.issueToken();
    expect((await NodeFSP.readFile(path)).includes(Buffer.from(token))).toBe(false);
    expect(() => other.enroll(token, "invalid", "abcdef")).toThrow();
    state.enroll(token, keys.publicKey, "abcdef");
    expect(() => other.enroll(token, keys.publicKey, "ghijkl")).toThrow();
    const next = other.issueToken();
    expect(() => state.enroll(next, keys.publicKey, "abcdef")).toThrow();
    expect(state.enroll(next, keys.publicKey, "ghijkl").slug).toBe("ghijkl");
    expect(other.list()).toHaveLength(2);
    const db = new NodeSqlite.DatabaseSync(path);
    try {
      db.prepare("INSERT INTO tokens VALUES (?, ?)").run("expired", 0);
      state.purgeExpiredTokens();
      expect(
        db.prepare("SELECT count(*) AS count FROM tokens WHERE expiresAt <= 0").get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
    other.revoke("abcdef");
    expect(state.get("abcdef")).toBeUndefined();
    // Blocking is a public-name takedown only; a bare slug or port label would take down the
    // environment's own host without revoking it.
    expect(() => state.block("abcdef")).toThrow("public tunnel names");
    expect(() => state.block("3000-abcdef")).toThrow("public tunnel names");
    expect(() => state.unblock("abcdef")).toThrow("public tunnel names");
    expect(state.block("docs-abcdef")).toBe(true);
    expect(state.block("docs-abcdef")).toBe(false);
    expect(state.blockedLabels()).toEqual(["docs-abcdef"]);
    expect(state.unblock("docs-abcdef")).toBe(true);
  } finally {
    other.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rate limits enrollment and tunnel attempts by source IP", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-rate-"));
  const fixture = testCertificate(directory, "relay.test");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(fixture),
  });
  let ws: WebSocket | undefined;
  try {
    const ports = await relay.start();
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await httpsRequest(
        { hostname: "relay.test", port: ports.tlsPort, path: "/_hhh/enroll", method: "POST" },
        "{}",
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await httpsRequest(
          { hostname: "relay.test", port: ports.tlsPort, path: "/_hhh/enroll", method: "POST" },
          "{}",
        )
      ).status,
    ).toBe(429);
    ws = new WebSocket(`wss://relay.test:${ports.tlsPort}/_hhh/tunnel`, {
      rejectUnauthorized: false,
      lookup,
    });
    const rejected = new Promise<number>((resolve) =>
      ws!.once("unexpected-response", (_, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
        ws!.terminate();
      }),
    );
    ws.on("error", () => {});
    expect(await rejected).toBe(429);
  } finally {
    ws?.terminate();
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keys visitor buckets by IPv6 /64 and evicts the oldest bucket instead of refusing new visitors", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-buckets-"));
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    // Two open connections per /64, so rotating the address inside one /64 is refused.
    visitorLimits: { concurrent: 2 },
    getSecureContext: async () => {
      throw new Error("unused");
    },
  });
  const fake = (remoteAddress: string): NodeNet.Socket =>
    ({ remoteAddress, once: () => undefined }) as unknown as NodeNet.Socket;
  const address = (index: number): string =>
    `2001:${(index >>> 16).toString(16)}:${(index & 0xffff).toString(16)}:1::1`;
  try {
    expect(sourceKey("2001:db8:1:2::1")).toBe(sourceKey("2001:db8:1:2:ffff:9:9:9"));
    expect(sourceKey("2001:db8:1:3::1")).not.toBe(sourceKey("2001:db8:1:2::1"));
    expect(sourceKey("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(sourceKey(undefined)).toBe("unknown");
    // Rotating source addresses inside one /64 shares the concurrent cap.
    expect(relay["admitVisitor"](fake("2001:db8:1:2::1"))).toBe(true);
    expect(relay["admitVisitor"](fake("2001:db8:1:2::2"))).toBe(true);
    expect(relay["admitVisitor"](fake("2001:db8:1:2::3"))).toBe(false);
    expect(relay["admitVisitor"](fake("2001:db8:1:3::1"))).toBe(true);
    // At the bucket cap a first-seen address evicts the oldest bucket instead of being refused.
    for (let index = 0; index < 10_000; index++)
      if (!relay["admitVisitor"](fake(address(index)))) throw new Error(`refused ${index}`);
    expect(relay["visitorBuckets"].size).toBe(10_000);
    expect(relay["admitVisitor"](fake("2001:feed:1:1::1"))).toBe(true);
    expect(relay["visitorBuckets"].size).toBe(10_000);
  } finally {
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

function openTls(port: number, servername: string): Promise<NodeTls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = NodeTls.connect({
      host: "127.0.0.1",
      port,
      servername,
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before handshake")));
  });
}
it("routes public names under the public domain only, keeps owner headroom, caps visitors per IP, and blocks a label live", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-public-"));
  const relayCert = testCertificate(directory, "relay.test");
  const envCert = testCertificate(directory, "*.relay.test", "env", ["*.usercontent.test"]);
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  expect(
    () =>
      new RelayServer({
        relayHost: "relay.test",
        state,
        publicDomain: "usercontent.test",
        getSecureContext: async () => NodeTls.createSecureContext(relayCert),
      }),
  ).toThrow("public hosts");
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    publicHosts: true,
    publicDomain: "usercontent.test",
    // 6 streams, 3 kept for the owner; at most 2 open connections per visitor IP.
    maxStreams: 6,
    visitorLimits: { concurrent: 2 },
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(relayCert),
  });
  const app = NodeHttp.createServer((req, res) => res.end(`${req.headers.host}${req.url}`));
  const names: string[] = [];
  const certificates: string[] = [];
  const sockets: NodeTls.TLSSocket[] = [];
  let client: RelayTunnelClient | undefined;
  try {
    const ports = await relay.start();
    const keys = generateEnvironmentKeyPair();
    state.enroll(state.issueToken(), keys.publicKey, "abcdef");
    const challenges = new HttpChallengeStore();
    challenges.set("docs-abcdef.usercontent.test", "name-token", "name-proof");
    client = new RelayTunnelClient({
      relayUrl: `https://relay.test:${ports.tlsPort}`,
      slug: "abcdef",
      privateKey: keys.privateKey,
      challenges,
      maxStreams: 6,
      webSocketOptions: { rejectUnauthorized: false, lookup },
      allowLabel: (label) => {
        if ("name" in label) names.push(label.name);
        return "name" in label && label.name === "docs";
      },
      getSecureContext: async (hostname) => {
        certificates.push(hostname);
        return NodeTls.createSecureContext(envCert);
      },
      onSecureConnection: (socket) => app.emit("connection", socket),
    });
    const connected = NodeEvents.EventEmitter.once(client, "connected");
    client.start();
    expect((await connected)[0]).toEqual({
      features: ["public-hosts"],
      publicDomain: "usercontent.test",
    });
    const reply = await httpsRequest({
      hostname: "docs-abcdef.usercontent.test",
      port: ports.tlsPort,
      path: "/a",
    });
    expect(reply.body).toBe(`docs-abcdef.usercontent.test:${ports.tlsPort}/a`);
    expect(
      await plainRequest(
        ports.httpPort,
        "docs-abcdef.usercontent.test",
        "/.well-known/acme-challenge/name-token",
      ),
    ).toMatchObject({ status: 200, body: "name-proof" });
    // With a public domain, names never live under the relay host, and the environment's own
    // host and ports never live under the public domain.
    for (const hostname of [
      "docs-abcdef.relay.test",
      "abcdef.usercontent.test",
      "3000-abcdef.usercontent.test",
      "0-abcdef.usercontent.test",
      "docs--x-abcdef.usercontent.test",
    ])
      await expect(httpsRequest({ hostname, port: ports.tlsPort, path: "/" })).rejects.toThrow();
    // An unknown name reaches the environment's allowLabel but never asks for a certificate.
    await expect(
      httpsRequest({ hostname: "nope-abcdef.usercontent.test", port: ports.tlsPort, path: "/" }),
    ).rejects.toThrow();
    expect(names).toContain("nope");
    expect(certificates).not.toContain("nope-abcdef.usercontent.test");

    // Per-IP cap: the third concurrent visitor connection from one IP is refused.
    const visitors = [
      await openTls(ports.tlsPort, "docs-abcdef.usercontent.test"),
      await openTls(ports.tlsPort, "docs-abcdef.usercontent.test"),
    ];
    sockets.push(...visitors);
    await expect(openTls(ports.tlsPort, "docs-abcdef.usercontent.test")).rejects.toThrow();

    // Block cuts the label's live connections and refuses new ones, without touching the env.
    const closed = visitors.map((socket) => NodeEvents.EventEmitter.once(socket, "close"));
    expect(relay.block("docs-abcdef")).toBe(true);
    await Promise.all(closed);
    await expect(
      httpsRequest({ hostname: "docs-abcdef.usercontent.test", port: ports.tlsPort, path: "/" }),
    ).rejects.toThrow();
    expect(
      (await httpsRequest({ hostname: "abcdef.relay.test", port: ports.tlsPort, path: "/" })).body,
    ).toBe(`abcdef.relay.test:${ports.tlsPort}/`);
    expect(state.blockedLabels()).toEqual(["docs-abcdef"]);
    expect(() => state.block("not a label")).toThrow();
    expect(state.unblock("docs-abcdef")).toBe(true);
    await expect.poll(() => relay["bridged"].size).toBe(0);

    // Headroom: one owner and two visitors fill the visitor share (6 - 3). A main-label flood is
    // capped at the same headroom, so it cannot fill the mux; the owner connects again as soon as
    // a stream frees, with the reserved streams still untouched.
    const owner = await openTls(ports.tlsPort, "abcdef.relay.test");
    sockets.push(owner);
    sockets.push(await openTls(ports.tlsPort, "docs-abcdef.usercontent.test"));
    sockets.push(await openTls(ports.tlsPort, "docs-abcdef.usercontent.test"));
    await expect(openTls(ports.tlsPort, "docs-abcdef.usercontent.test")).rejects.toThrow();
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(openTls(ports.tlsPort, "abcdef.relay.test")).rejects.toThrow();
    const mux = relay["tunnels"].get("abcdef")?.mux;
    expect(mux?.streamCount).toBe(3);
    expect(owner.destroyed).toBe(false);
    const freed = sockets.splice(sockets.length - 1, 1)[0]!;
    freed.destroy();
    await expect.poll(() => mux?.streamCount).toBe(2);
    sockets.push(await openTls(ports.tlsPort, "abcdef.relay.test"));
    expect(mux?.streamCount).toBe(3);
  } finally {
    for (const socket of sockets) socket.destroy();
    client?.stop();
    app.closeAllConnections();
    app.close();
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reaps quiet visitor streams at the visitor idle timeout and frees their slots", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-idle-"));
  const relayCert = testCertificate(directory, "relay.test");
  const envCert = testCertificate(directory, "*.relay.test", "env");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    publicHosts: true,
    maxStreams: 6,
    // 6 streams, 3 kept for the owner; at most 2 open connections per visitor IP.
    visitorLimits: { concurrent: 2 },
    visitorIdleTimeoutMs: 400,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(relayCert),
  });
  const app = NodeHttp.createServer((_req, res) => res.end("environment"));
  const sockets: NodeTls.TLSSocket[] = [];
  let client: RelayTunnelClient | undefined;
  try {
    const ports = await relay.start();
    const keys = generateEnvironmentKeyPair();
    state.enroll(state.issueToken(), keys.publicKey, "abcdef");
    client = new RelayTunnelClient({
      relayUrl: `https://relay.test:${ports.tlsPort}`,
      slug: "abcdef",
      privateKey: keys.privateKey,
      challenges: new HttpChallengeStore(),
      maxStreams: 6,
      webSocketOptions: { rejectUnauthorized: false, lookup },
      allowLabel: (label) => "name" in label && label.name === "docs",
      getSecureContext: async () => NodeTls.createSecureContext(envCert),
      onSecureConnection: (socket) => app.emit("connection", socket),
    });
    const connected = NodeEvents.EventEmitter.once(client, "connected");
    client.start();
    await connected;
    const quiet = [
      await openTls(ports.tlsPort, "docs-abcdef.relay.test"),
      await openTls(ports.tlsPort, "docs-abcdef.relay.test"),
    ];
    sockets.push(...quiet);
    await expect(openTls(ports.tlsPort, "docs-abcdef.relay.test")).rejects.toThrow();
    const owner = await openTls(ports.tlsPort, "abcdef.relay.test");
    sockets.push(owner);
    // A silent drop has no FIN and no frames, so the visitor idle timer is the only reaper.
    await expect.poll(() => quiet.every((socket) => socket.destroyed)).toBe(true);
    const mux = relay["tunnels"].get("abcdef")?.mux;
    await expect.poll(() => mux?.streamCount).toBe(1);
    expect(owner.destroyed).toBe(false);
    // The freed visitor slots admit a new visitor while the owner's idle timeout is untouched.
    sockets.push(await openTls(ports.tlsPort, "docs-abcdef.relay.test"));
    expect(mux?.streamCount).toBe(2);
  } finally {
    for (const socket of sockets) socket.destroy();
    client?.stop();
    app.closeAllConnections();
    app.close();
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("links with an account, keeps one slug per key, and refuses another user's slug or key", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-account-"));
  const fixture = testCertificate(directory, "relay.test");
  const dbPath = NodePath.join(directory, "state.sqlite");
  const state = new RelayState(dbPath);
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(fixture),
  });
  try {
    state.addUser("alice", ACCOUNT_PASSWORD);
    const ports = await relay.start();
    const aliceKey = generateEnvironmentKeyPair();
    const aliceSecondKey = generateEnvironmentKeyPair();
    const bobKey = generateEnvironmentKeyPair();
    const credentials = (username: string, password = ACCOUNT_PASSWORD) => ({
      username,
      password,
      publicKey: aliceKey.publicKey,
    });
    const first = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      ...credentials("alice"),
      desiredSlug: "abcdef",
    });
    expect(first.status).toBe(201);
    expect(JSON.parse(first.body)).toEqual({ slug: "abcdef", relayHost: "relay.test" });
    expect(state.get("abcdef")?.userId).toBe("alice");
    // Re-linking the same key keeps the slug even when another one is asked for.
    const relink = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      ...credentials("alice"),
      desiredSlug: "ghijkl",
    });
    expect(relink.status).toBe(201);
    expect(JSON.parse(relink.body).slug).toBe("abcdef");
    const config = await authRequest(ports.tlsPort, "/_hhh/auth/config");
    expect(config.status).toBe(200);
    expect(JSON.parse(config.body)).toEqual({ signup: false, password: true });
    // A wrong password and an unknown user are indistinguishable.
    const wrongPassword = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      ...credentials("alice", "wrong horse battery"),
    });
    const unknownUser = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      ...credentials("mallory"),
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body).toBe(wrongPassword.body);
    state.addUser("bob", ACCOUNT_PASSWORD);
    const stolenSlug = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      username: "bob",
      password: ACCOUNT_PASSWORD,
      publicKey: bobKey.publicKey,
      desiredSlug: "abcdef",
    });
    expect(stolenSlug.status).toBe(409);
    // Refusals past the per-IP auth budget are checked at the state layer; HTTP auth is capped.
    expect(() =>
      state.enrollForUser({
        username: "bob",
        password: ACCOUNT_PASSWORD,
        publicKey: aliceKey.publicKey,
        desiredSlug: "bobbob",
      }),
    ).toThrow(LinkConflictError);
    expect(() =>
      state.enrollForUser({
        username: "alice",
        password: ACCOUNT_PASSWORD,
        publicKey: aliceSecondKey.publicKey,
        desiredSlug: "abcdef",
      }),
    ).toThrow(LinkConflictError);
    // The token path is untouched for agents and CI.
    const tokenEnrollment = await httpsRequest(
      { hostname: "relay.test", port: ports.tlsPort, path: "/_hhh/enroll", method: "POST" },
      JSON.stringify({
        token: state.issueToken(),
        publicKey: generateEnvironmentKeyPair().publicKey,
        desiredSlug: "tokent",
      }),
    );
    expect(tokenEnrollment.status).toBe(201);
    expect((await NodeFSP.readFile(dbPath)).includes(Buffer.from(ACCOUNT_PASSWORD))).toBe(false);
  } finally {
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("hides auth endpoints until configured and rate limits account attempts per IP", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-auth-"));
  const fixture = testCertificate(directory, "relay.test");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(fixture),
  });
  try {
    const ports = await relay.start();
    const keys = generateEnvironmentKeyPair();
    const attempt = (password: string) =>
      authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
        username: "alice",
        password,
        publicKey: keys.publicKey,
      });
    expect((await authRequest(ports.tlsPort, "/_hhh/auth/config")).status).toBe(404);
    expect((await attempt("whatever password")).status).toBe(404);
    expect(
      (
        await authRequest(ports.tlsPort, "/_hhh/auth/register", {
          username: "alice",
          password: ACCOUNT_PASSWORD,
        })
      ).status,
    ).toBe(404);
    state.addUser("alice", ACCOUNT_PASSWORD);
    const config = await authRequest(ports.tlsPort, "/_hhh/auth/config");
    expect(config.status).toBe(200);
    expect(JSON.parse(config.body)).toEqual({ signup: false, password: true });
    for (let tries = 0; tries < 5; tries++)
      expect((await attempt("wrong horse battery")).status).toBe(401);
    expect((await attempt("wrong horse battery")).status).toBe(429);
  } finally {
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("registers accounts only with signup on, enforces a 12 character password, and does not reveal names", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-signup-"));
  const fixture = testCertificate(directory, "relay.test");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    allowSignup: true,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(fixture),
  });
  try {
    const ports = await relay.start();
    const config = await authRequest(ports.tlsPort, "/_hhh/auth/config");
    expect(JSON.parse(config.body)).toEqual({ signup: true, password: true });
    const register = (username: string, password: string) =>
      authRequest(ports.tlsPort, "/_hhh/auth/register", { username, password });
    expect((await register("carol", "short pass1")).status).toBe(400);
    expect((await register("carol", "twelve chars")).status).toBe(201);
    expect(state.listUsers().map((user) => user.username)).toEqual(["carol"]);
    // Re-registering an existing name answers like a new one and leaves the account alone.
    expect((await register("carol", "other pass 12+")).status).toBe(201);
    expect((await register("dave", "twelve chars")).status).toBe(201);
    const keys = generateEnvironmentKeyPair();
    const enrolled = await authRequest(ports.tlsPort, "/_hhh/auth/enroll", {
      username: "carol",
      password: "twelve chars",
      publicKey: keys.publicKey,
    });
    expect(enrolled.status).toBe(201);
    // The fifth attempt above used the last auth token; the next is capped.
    expect((await register("erin", "twelve chars")).status).toBe(429);
  } finally {
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("removes an account's environments so their live tunnels close", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-remove-"));
  const fixture = testCertificate(directory, "relay.test");
  const state = new RelayState(NodePath.join(directory, "state.sqlite"));
  const relay = new RelayServer({
    relayHost: "relay.test",
    state,
    bindHost: "127.0.0.1",
    tlsPort: 0,
    httpPort: 0,
    getSecureContext: async () => NodeTls.createSecureContext(fixture),
  });
  const app = NodeHttp.createServer((_req, res) => res.end("environment"));
  let client: RelayTunnelClient | undefined;
  try {
    state.addUser("alice", ACCOUNT_PASSWORD);
    const keys = generateEnvironmentKeyPair();
    const env = state.enrollForUser({
      username: "alice",
      password: ACCOUNT_PASSWORD,
      publicKey: keys.publicKey,
      desiredSlug: "abcdef",
    });
    expect(env.slug).toBe("abcdef");
    const ports = await relay.start();
    client = new RelayTunnelClient({
      relayUrl: `https://relay.test:${ports.tlsPort}`,
      slug: "abcdef",
      privateKey: keys.privateKey,
      challenges: new HttpChallengeStore(),
      webSocketOptions: { rejectUnauthorized: false, lookup },
      allowLabel: () => false,
      getSecureContext: async () => NodeTls.createSecureContext(fixture),
      onSecureConnection: (socket) => app.emit("connection", socket),
    });
    const connected = NodeEvents.EventEmitter.once(client, "connected");
    client.start();
    await connected;
    const disconnected = NodeEvents.EventEmitter.once(client, "disconnected");
    expect(state.removeUser("alice")).toEqual({ removed: true, revoked: ["abcdef"] });
    await disconnected;
    expect(state.get("abcdef")).toBeUndefined();
    expect(state.listUsers()).toEqual([]);
  } finally {
    client?.stop();
    app.closeAllConnections();
    app.close();
    await relay.close();
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("migrates a pre-account state file and keeps its token-enrolled environments", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hhh-relay-migrate-"));
  const path = NodePath.join(directory, "state.sqlite");
  const old = new NodeSqlite.DatabaseSync(path);
  try {
    old.exec(`CREATE TABLE environments (slug TEXT PRIMARY KEY, publicKey TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE tokens (hash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
      CREATE TABLE blocked_labels (label TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);`);
    old.prepare("INSERT INTO environments VALUES (?, ?, ?)").run("abcdef", "old-key", 1);
  } finally {
    old.close();
  }
  const state = new RelayState(path);
  try {
    expect(state.get("abcdef")).toMatchObject({
      slug: "abcdef",
      publicKey: "old-key",
      userId: null,
    });
    state.addUser("alice", ACCOUNT_PASSWORD);
    expect(state.listUsers()).toHaveLength(1);
  } finally {
    state.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
