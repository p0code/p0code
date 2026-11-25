// Node-native relay adapter has no Effect runtime; timers and clocks follow socket/token lifetimes.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import { WebSocketServer, type WebSocket } from "ws";
import { HandshakeChallenge } from "@t3tools/relay-tunnel/auth";
import {
  parseHostLabel,
  StreamMultiplexer,
  websocketBytes,
  type HostLabel,
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
  /** Idle timeout for visitor streams (port/name labels); the owner's `<slug>` keeps `idleTimeoutMs`. */
  visitorIdleTimeoutMs?: number;
  /** Route `<name>-<slug>` public tunnel hostnames. Off by default: they are refused at SNI. */
  publicHosts?: boolean;
  /** Separate domain for `<name>-<slug>` hostnames instead of the relay host. Needs publicHosts. */
  publicDomain?: string;
  /** Per visitor IP, for every label except an environment's own `<slug>`. */
  visitorLimits?: Partial<VisitorLimits>;
}
export interface VisitorLimits {
  /** New connections a visitor IP may open at once. */
  burst: number;
  /** New connections per second the burst refills at. */
  perSecond: number;
  /** Open connections per visitor IP. */
  concurrent: number;
}
const DEFAULT_VISITOR_LIMITS: VisitorLimits = { burst: 100, perSecond: 20, concurrent: 64 };
/** Mux streams kept free for the owner's own `<slug>` clients when visitors are busy. */
const OWNER_RESERVED_STREAMS = 16;
/** Quiet visitor streams are reaped after 15s; a silent drop has no FIN, only this timer. */
const VISITOR_IDLE_TIMEOUT_MS = 15_000;
/** Source-address buckets kept before the least recently used one is evicted. */
const BUCKET_LIMIT = 10_000;
const HOSTNAME = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** Eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Words(address: string): number[] | undefined {
  const value = address.split("%")[0] ?? "";
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parts = (part: string): string[] => (part ? part.split(":") : []);
  const left = parts(halves[0] ?? "");
  const right = parts(halves[1] ?? "");
  // A trailing dotted IPv4 tail is the last two groups.
  const dotted = right.at(-1)?.includes(".")
    ? right
    : left.at(-1)?.includes(".")
      ? left
      : undefined;
  if (dotted) {
    const last = dotted[dotted.length - 1];
    if (last === undefined || !NodeNet.isIPv4(last)) return undefined;
    const octets = last.split(".").map(Number);
    dotted.splice(
      dotted.length - 1,
      1,
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16),
    );
  }
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return undefined;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill("0"), ...right];
  const words = groups.map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : undefined;
}

/**
 * Bucket key for a source address: IPv6 clients are keyed by /64, so rotating the low bits buys no
 * extra budget. IPv4-mapped peers (`::ffff:a.b.c.d`) keep their IPv4 key.
 */
export function sourceKey(address: string | undefined): string {
  if (!address) return "unknown";
  if (!NodeNet.isIPv6(address)) return address;
  const words = ipv6Words(address);
  if (!words) return address;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const [high, low] = [words[6]!, words[7]!];
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(":")}::/64`;
}

/** Port and public-name labels are visitors; the bare `<slug>` carries the owner's own clients. */
function isVisitorLabel(metadata: StreamLabel): boolean {
  return metadata.port !== undefined || metadata.name !== undefined;
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
  /**
   * Stores a bucket and keeps the map bounded. Re-insertion keeps Map order least-recently-used
   * first, so a first-seen address evicts the oldest bucket instead of being refused.
   */
  private rememberBucket(
    map: Map<string, { tokens: number; at: number }>,
    key: string,
    bucket: { tokens: number; at: number },
  ): void {
    map.delete(key);
    map.set(key, bucket);
    while (map.size > BUCKET_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
  private allowAttempt(address: string | undefined): boolean {
    const key = sourceKey(address);
    const now = Date.now();
    const prior = this.buckets.get(key) ?? { tokens: 10, at: now };
    const tokens = Math.min(10, prior.tokens + (now - prior.at) / 6000);
    this.rememberBucket(this.buckets, key, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }
  private readonly visitorBuckets = new Map<string, { tokens: number; at: number }>();
  private readonly visitorConnections = new Map<string, number>();
  private admitVisitor(socket: NodeNet.Socket): boolean {
    const limits = { ...DEFAULT_VISITOR_LIMITS, ...this.options.visitorLimits };
    const key = sourceKey(socket.remoteAddress);
    const open = this.visitorConnections.get(key) ?? 0;
    if (open >= limits.concurrent) return false;
    const now = Date.now();
    const prior = this.visitorBuckets.get(key);
    const tokens = Math.min(
      limits.burst,
      (prior?.tokens ?? limits.burst) + ((now - (prior?.at ?? now)) / 1000) * limits.perSecond,
    );
    this.rememberBucket(this.visitorBuckets, key, { tokens: Math.max(0, tokens - 1), at: now });
    if (tokens < 1) return false;
    this.visitorConnections.set(key, open + 1);
    socket.once("close", () => {
      const left = (this.visitorConnections.get(key) ?? 1) - 1;
      if (left > 0) this.visitorConnections.set(key, left);
      else this.visitorConnections.delete(key);
    });
    return true;
  }
  /** Every socket piped into a tunnel, by hostname label, so `block` can cut it. */
  private readonly bridged = new Map<NodeNet.Socket, string>();
  private revocationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly options: RelayServerOptions;
  constructor(options: RelayServerOptions) {
    this.options = options;
    if (!HOSTNAME.test(options.relayHost)) throw new Error("Invalid relay hostname");
    const publicDomain = options.publicDomain;
    if (publicDomain !== undefined) {
      if (!options.publicHosts) throw new Error("A public domain needs public hosts enabled");
      if (!HOSTNAME.test(publicDomain)) throw new Error("Invalid public domain");
      if (
        publicDomain === options.relayHost ||
        publicDomain.endsWith(`.${options.relayHost}`) ||
        options.relayHost.endsWith(`.${publicDomain}`)
      )
        throw new Error("The public domain must not overlap the relay host");
    }
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
    for (const [ip, bucket] of this.visitorBuckets)
      if (Date.now() - bucket.at > 60_000) this.visitorBuckets.delete(ip);
    this.closeBlocked();
    for (const [slug, tunnel] of this.tunnels) {
      if (this.options.state.get(slug)?.publicKey !== tunnel.publicKey) tunnel.mux.close();
    }
  }
  /** Refuse one hostname label from now on and cut its live connections. */
  block(label: string): boolean {
    const added = this.options.state.block(label);
    this.closeBlocked();
    return added;
  }
  private closeBlocked(): void {
    if (!this.bridged.size) return;
    const blocked = new Set(this.options.state.blockedLabels());
    for (const [socket, label] of this.bridged) if (blocked.has(label)) socket.destroy();
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
        ws.send(
          JSON.stringify({
            type: "authenticated",
            maxStreams,
            features: this.options.publicHosts ? ["public-hosts"] : [],
            ...(this.options.publicDomain ? { publicDomain: this.options.publicDomain } : {}),
          }),
        );
        const mux = new StreamMultiplexer(ws, {
          initiator: true,
          maxStreams,
          idleTimeoutMs: (metadata) =>
            isVisitorLabel(metadata)
              ? (this.options.visitorIdleTimeoutMs ?? VISITOR_IDLE_TIMEOUT_MS)
              : (this.options.idleTimeoutMs ?? 120_000),
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
  /**
   * `<slug>` and `<port>-<slug>` live under the relay host. `<name>-<slug>` lives under the public
   * domain when there is one, else the relay host, and only with public hosts on. The environment
   * decides whether a name exists; the relay keeps no registry.
   */
  private hostLabel(hostname: string): (HostLabel & { label: string }) | undefined {
    const { relayHost, publicDomain, publicHosts } = this.options;
    const underPublic = publicDomain !== undefined && hostname.endsWith(`.${publicDomain}`);
    const suffix = `.${underPublic ? publicDomain : relayHost}`;
    if (!hostname.endsWith(suffix)) return undefined;
    const label = hostname.slice(0, -suffix.length);
    const parsed = parseHostLabel(label);
    if (!parsed) return undefined;
    if (parsed.name === undefined) return underPublic ? undefined : { label, ...parsed };
    if (!publicHosts || underPublic !== (publicDomain !== undefined)) return undefined;
    return { label, ...parsed };
  }
  private destination(
    hostname: string,
    kind: "http" | "tls",
    remoteAddr?: string,
  ): { tunnel: Tunnel; metadata: StreamLabel } | undefined {
    const host = this.hostLabel(hostname);
    if (!host || this.options.state.isBlocked(host.label)) return undefined;
    const tunnel = this.tunnels.get(host.slug);
    if (!tunnel || this.options.state.get(host.slug)?.publicKey !== tunnel.publicKey)
      return undefined;
    return {
      tunnel,
      metadata: {
        label: host.label,
        kind,
        ...(remoteAddr ? { remoteAddr } : {}),
        ...(host.port !== undefined ? { port: host.port } : {}),
        ...(host.name !== undefined ? { name: host.name } : {}),
      },
    };
  }
  /**
   * Opens the mux stream for a routed socket. Every label keeps the owner's reserved streams free;
   * port/name visitors are also admitted per IP. The relay cannot tell owner from visitor on a
   * bare `<slug>`, so that label gets the same headroom cap without the per-IP visitor budget.
   */
  private openStream(
    socket: NodeNet.Socket,
    { tunnel, metadata }: { tunnel: Tunnel; metadata: StreamLabel },
  ): MuxStream | undefined {
    const { maxStreams, streamCount } = tunnel.mux;
    const reserved = Math.min(OWNER_RESERVED_STREAMS, Math.floor(maxStreams / 2));
    if (streamCount >= maxStreams - reserved) return undefined;
    if (isVisitorLabel(metadata) && !this.admitVisitor(socket)) return undefined;
    let stream: MuxStream;
    try {
      stream = tunnel.mux.open(metadata);
    } catch {
      return undefined;
    }
    this.bridged.set(socket, metadata.label);
    socket.once("close", () => this.bridged.delete(socket));
    return stream;
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
    const stream = destination && this.openStream(socket, destination);
    if (!stream) {
      socket.destroy();
      return;
    }
    this.bridge(socket, stream, hello.bytes);
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
      const ownDomain = (domain: string | undefined): boolean =>
        domain !== undefined && (hostname === domain || hostname.endsWith(`.${domain}`));
      if (!ownDomain(this.options.relayHost) && !ownDomain(this.options.publicDomain)) {
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
        const stream = destination && this.openStream(socket, destination);
        if (stream) {
          this.bridge(socket, stream, bytes);
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
