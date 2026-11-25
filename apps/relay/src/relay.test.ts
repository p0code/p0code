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
import { RelayState } from "./state.ts";
import { RelayServer } from "./server.ts";

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

    // Headroom: two owner connections plus one visitor fill the visitor share (6 - 3), so the
    // next visitor is refused while the owner can still connect.
    sockets.push(await openTls(ports.tlsPort, "abcdef.relay.test"));
    sockets.push(await openTls(ports.tlsPort, "abcdef.relay.test"));
    sockets.push(await openTls(ports.tlsPort, "docs-abcdef.usercontent.test"));
    await expect(openTls(ports.tlsPort, "docs-abcdef.usercontent.test")).rejects.toThrow();
    sockets.push(await openTls(ports.tlsPort, "abcdef.relay.test"));
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
