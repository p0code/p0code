// Node-native relay adapter has no Effect runtime; timers and clocks follow socket/token lifetimes.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import { WebSocketServer, type WebSocket } from "ws";
import { HandshakeChallenge } from "@t3tools/relay-tunnel/auth";
import {
  StreamMultiplexer,
  websocketBytes,
  type MuxStream,
  type StreamLabel,
} from "@t3tools/relay-tunnel/mux";
import { readClientHello } from "@t3tools/relay-tunnel/sni";
import { HttpChallengeStore } from "@t3tools/relay-tunnel/certificates";
import { RelayState } from "./state.ts";

export interface RelayServerOptions {
  relayHost: string;
  state: RelayState;
  getSecureContext: (hostname: string) => Promise<NodeTls.SecureContext>;
  challenges?: HttpChallengeStore;
  bindHost?: string;
  tlsPort?: number;
  httpPort?: number;
  maxStreams?: number;
  idleTimeoutMs?: number;
}
interface Tunnel {
  ws: WebSocket;
  mux: StreamMultiplexer;
  publicKey: string;
}
export class RelayServer {
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly sockets = new Set<NodeNet.Socket>();
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private readonly control = NodeHttp.createServer((request, response) => {
    void this.handleControl(request, response);
  });
  private readonly tls = NodeTls.createServer(
    {
      minVersion: "TLSv1.2",
      handshakeTimeout: 30_000,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (hostname, callback) => {
        if (hostname !== this.options.relayHost) {
          callback(new Error("Unknown hostname"));
          return;
        }

        void this.options.getSecureContext(hostname).then(
          (context) => callback(null, context),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    },
    (socket) => {
      this.control.emit("connection", socket);
    },
  );
  private readonly httpsListener = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
    this.track(socket);
    void this.routeTls(socket).catch(() => socket.destroy());
  });
  private readonly httpListener = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
    this.track(socket);
    this.routeHttp(socket);
  });
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private allowAttempt(ip: string): boolean {
    const now = Date.now();
    const prior = this.buckets.get(ip) ?? { tokens: 10, at: now };
    const tokens = Math.min(10, prior.tokens + (now - prior.at) / 6000);
    if (!this.buckets.has(ip) && this.buckets.size >= 10000) return false;
    this.buckets.set(ip, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }
  private revocationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly options: RelayServerOptions;
  constructor(options: RelayServerOptions) {
    this.options = options;
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(options.relayHost))
      throw new Error("Invalid relay hostname");
    this.tls.on("tlsClientError", (_error, socket) => socket.destroy());
    this.control.on("upgrade", (request, socket, head) => {
      if (
        request.url !== "/_hhh/tunnel" ||
        request.headers.host?.split(":")[0] !== this.options.relayHost
      ) {
        socket.destroy();
        return;
      }
      if (!this.allowAttempt(request.socket.remoteAddress ?? "unknown")) {
        socket.end(
          "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (ws) => this.authenticate(ws));
    });
    this.control.headersTimeout = 10_000;
    this.control.requestTimeout = 15_000;
  }
  private track(socket: NodeNet.Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
  }
  async start(): Promise<{ tlsPort: number; httpPort: number }> {
    const listen = (server: typeof this.httpsListener, port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.options.bindHost ?? "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
    try {
      await listen(this.httpListener, this.options.httpPort ?? 80);
      await listen(this.httpsListener, this.options.tlsPort ?? 443);
    } catch (error) {
      await this.close();
      throw error;
    }
    this.revocationTimer = setInterval(() => this.refreshRevocations(), 1000);
    this.revocationTimer.unref();
    const tlsAddress = this.httpsListener.address();
    const httpAddress = this.httpListener.address();
    if (
      !tlsAddress ||
      typeof tlsAddress === "string" ||
      !httpAddress ||
      typeof httpAddress === "string"
    )
      throw new Error("Listeners unavailable");
    return { tlsPort: tlsAddress.port, httpPort: httpAddress.port };
  }
  refreshRevocations(): void {
    this.options.state.purgeExpiredTokens();
    for (const [ip, bucket] of this.buckets)
      if (Date.now() - bucket.at > 60_000) this.buckets.delete(ip);
    for (const [slug, tunnel] of this.tunnels) {
      if (this.options.state.get(slug)?.publicKey !== tunnel.publicKey) tunnel.mux.close();
    }
  }
  revoke(slug: string): boolean {
    const removed = this.options.state.revoke(slug);
    this.tunnels.get(slug)?.mux.close();
    return removed;
  }
  private async handleControl(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): Promise<void> {
    if (request.headers.host?.split(":")[0] !== this.options.relayHost) {
      response.writeHead(421).end();
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/_hhh/enroll") {
      response.writeHead(404).end();
      return;
    }
    if (!this.allowAttempt(request.socket.remoteAddress ?? "unknown")) {
      response.writeHead(429).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
        size += chunk.length;
        if (size > 8192) {
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (
        !body ||
        typeof body !== "object" ||
        !("token" in body) ||
        typeof body.token !== "string" ||
        !("publicKey" in body) ||
        typeof body.publicKey !== "string" ||
        ("desiredSlug" in body && typeof body.desiredSlug !== "string")
      )
        throw new Error("Invalid enrollment");
      const env = this.options.state.enroll(
        body.token,
        body.publicKey,
        "desiredSlug" in body ? (body.desiredSlug as string) : undefined,
      );
      response
        .writeHead(201, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ slug: env.slug, relayHost: this.options.relayHost }));
    } catch {
      if (!response.headersSent) response.writeHead(400).end("Enrollment rejected");
    }
  }
  private authenticate(ws: WebSocket): void {
    const challenge = new HandshakeChallenge(this.options.relayHost);
    const timeout = setTimeout(() => ws.terminate(), 10_000);
    ws.on("error", () => {});
    ws.once("close", () => clearTimeout(timeout));
    ws.send(JSON.stringify({ type: "challenge", nonce: challenge.nonce }));
    ws.once("message", (data, binary) => {
      try {
        if (binary) throw new Error("Expected auth");
        const body: unknown = JSON.parse(websocketBytes(data).toString());
        if (
          !body ||
          typeof body !== "object" ||
          !("type" in body) ||
          body.type !== "authenticate" ||
          !("slug" in body) ||
          typeof body.slug !== "string" ||
          !("signature" in body) ||
          typeof body.signature !== "string"
        )
          throw new Error("Invalid auth");
        const env = this.options.state.get(body.slug);
        if (!env || !challenge.verify(env.publicKey, body.slug, body.signature))
          throw new Error("Auth rejected");
        clearTimeout(timeout);
        const peerLimit = "maxStreams" in body ? body.maxStreams : 128;
        if (
          typeof peerLimit !== "number" ||
          !Number.isInteger(peerLimit) ||
          peerLimit < 1 ||
          peerLimit > 65535
        )
          throw new Error("Invalid stream limit");
        const maxStreams = Math.min(this.options.maxStreams ?? 128, peerLimit);
        ws.send(JSON.stringify({ type: "authenticated", maxStreams }));
        const mux = new StreamMultiplexer(ws, {
          initiator: true,
          maxStreams,
          ...(this.options.idleTimeoutMs ? { idleTimeoutMs: this.options.idleTimeoutMs } : {}),
        });
        this.tunnels.get(body.slug)?.mux.close();
        const tunnel = { ws, mux, publicKey: env.publicKey };
        this.tunnels.set(body.slug, tunnel);
        mux.once("close", () => {
          if (this.tunnels.get(env.slug) === tunnel) this.tunnels.delete(env.slug);
        });
      } catch {
        clearTimeout(timeout);
        ws.close(1008, "Authentication rejected");
      }
    });
  }
  private destination(
    hostname: string,
    kind: "http" | "tls",
    remoteAddr?: string,
  ): { tunnel: Tunnel; metadata: StreamLabel } | undefined {
    const suffix = `.${this.options.relayHost}`;
    if (!hostname.endsWith(suffix)) return undefined;
    const label = hostname.slice(0, -suffix.length);
    const match = /^(?:([1-9][0-9]{0,4})-)?([a-z][a-z0-9]{5,31})$/.exec(label);
    if (!match) return undefined;
    const slug = match[2];
    const port = match[1] ? Number(match[1]) : undefined;
    if (!slug || (port !== undefined && port > 65535)) return undefined;
    const tunnel = this.tunnels.get(slug);
    if (!tunnel || this.options.state.get(slug)?.publicKey !== tunnel.publicKey) return undefined;
    return {
      tunnel,
      metadata: { label, kind, ...(remoteAddr ? { remoteAddr } : {}), ...(port ? { port } : {}) },
    };
  }
  private bridge(socket: NodeNet.Socket, stream: MuxStream, initial: Buffer): void {
    socket.once("error", () => stream.destroy());
    stream.once("error", () => socket.destroy());
    socket.once("close", () => stream.destroy());
    stream.once("close", () => socket.destroy());
    stream.write(initial, (error) => {
      if (error) socket.destroy();
      else socket.pipe(stream);
    });
    stream.pipe(socket);
  }
  private async routeTls(socket: NodeNet.Socket): Promise<void> {
    const hello = await readClientHello(socket);
    if (hello.servername === this.options.relayHost) {
      // Keep the peeked bytes buffered until TLSSocket takes ownership of the socket.
      socket.unshift(hello.bytes);
      this.tls.emit("connection", socket);
      return;
    }
    const destination = this.destination(hello.servername, "tls", socket.remoteAddress);
    if (!destination) {
      socket.destroy();
      return;
    }
    this.bridge(socket, destination.tunnel.mux.open(destination.metadata), hello.bytes);
  }
  private routeHttp(socket: NodeNet.Socket): void {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    socket.once("close", () => clearTimeout(timer));
    const onData = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16 * 1024) {
        socket.destroy();
        return;
      }
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      const lines = bytes.subarray(0, end).toString("latin1").split("\r\n");
      const request = /^([A-Z]+) (\/[^\s]*) HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
      const hosts = lines.filter((line) => /^host:/i.test(line));
      const hostname =
        hosts.length === 1
          ? hosts[0]?.slice(5).trim().toLowerCase().replace(/:\d+$/, "")
          : undefined;
      if (!request || !hostname || !/^[a-z0-9.-]+$/.test(hostname)) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (hostname !== this.options.relayHost && !hostname.endsWith(`.${this.options.relayHost}`)) {
        socket.end(
          "HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      const path = request[2] ?? "/";
      const isChallenge = /^\/\.well-known\/acme-challenge\/[A-Za-z0-9_-]+$/.test(path);
      if (isChallenge && request[1] === "GET") {
        if (hostname === this.options.relayHost) {
          const value = this.options.challenges?.get(hostname, path);
          const body = value ?? "Not found";
          socket.end(
            `HTTP/1.1 ${value === undefined ? "404 Not Found" : "200 OK"}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
          return;
        }
        const destination = this.destination(hostname, "http", socket.remoteAddress);
        if (destination) {
          try {
            this.bridge(socket, destination.tunnel.mux.open(destination.metadata), bytes);
          } catch {
            socket.destroy();
          }
          return;
        }
      }
      if (isChallenge) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      socket.end(
        `HTTP/1.1 308 Permanent Redirect\r\nLocation: https://${hostname}${path}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    socket.on("data", onData);
  }
  async close(): Promise<void> {
    clearInterval(this.revocationTimer);
    for (const tunnel of this.tunnels.values()) tunnel.mux.close();
    for (const ws of this.webSockets.clients) ws.terminate();
    for (const socket of this.sockets) socket.destroy();
    this.control.closeAllConnections();
    this.webSockets.close();
    await Promise.all(
      [this.httpsListener, this.httpListener].map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
  }
}
