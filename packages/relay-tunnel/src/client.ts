import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import type { ClientOptions } from "ws";
import * as NodeNet from "node:net";
import WebSocket from "ws";
import { signHandshake } from "./auth.ts";
import { StreamMultiplexer, websocketBytes, type MuxStream, type StreamLabel } from "./mux.ts";
import { HttpChallengeStore } from "./certificates.ts";

export interface RelayTunnelClientOptions {
  relayUrl: string;
  slug: string;
  privateKey: string;
  challenges: HttpChallengeStore;
  getSecureContext: (hostname: string) => Promise<NodeTls.SecureContext>;
  onSecureConnection: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void;
  /** Must authorize forwarded port labels before obtaining their certificates. */
  allowPort?: (port: number) => boolean;
  webSocketOptions?: Pick<ClientOptions, "ca" | "rejectUnauthorized"> & {
    lookup?: NodeNet.LookupFunction;
  };
  maxStreams?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}
export class RelayTunnelClient extends NodeEvents.EventEmitter {
  private ws: WebSocket | undefined;
  private mux: StreamMultiplexer | undefined;
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly challengeServer = NodeHttp.createServer((request, response) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const value =
      request.method === "GET" ? this.options.challenges.get(host, request.url ?? "") : undefined;
    response.writeHead(value === undefined ? 404 : 200, {
      "content-type": "text/plain",
      connection: "close",
    });
    response.end(value ?? "Not found");
  });
  private readonly options: RelayTunnelClientOptions;
  constructor(options: RelayTunnelClientOptions) {
    super();
    this.options = options;
    if (!/^[a-z][a-z0-9]{5,31}$/.test(options.slug)) throw new Error("Invalid relay slug");
    if (new URL(options.relayUrl).protocol !== "https:") throw new Error("Relay requires HTTPS");
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.mux?.close();
    this.ws?.terminate();
    this.challengeServer.closeAllConnections();
  }
  private report(error: unknown): void {
    this.emit("connectionError", error instanceof Error ? error : new Error(String(error)));
  }
  private connect(): void {
    if (this.stopped) return;
    const url = new URL("/_hhh/tunnel", this.options.relayUrl);
    if (url.protocol !== "https:") throw new Error("Relay requires HTTPS");
    const relayHost = url.hostname;
    url.protocol = "wss:";
    const ws = new WebSocket(url, {
      ...this.options.webSocketOptions,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    const authTimer = setTimeout(() => ws.terminate(), 10_000);
    const authenticate = (data: WebSocket.RawData, binary: boolean): void => {
      if (this.stopped || this.ws !== ws) return;
      try {
        if (binary) throw new Error("Unexpected auth message");
        const value: unknown = JSON.parse(websocketBytes(data).toString());
        if (!value || typeof value !== "object" || !("type" in value))
          throw new Error("Invalid auth response");
        if (value.type === "challenge" && "nonce" in value && typeof value.nonce === "string") {
          ws.send(
            JSON.stringify({
              type: "authenticate",
              slug: this.options.slug,
              maxStreams: this.options.maxStreams ?? 128,
              signature: signHandshake(
                this.options.privateKey,
                relayHost,
                this.options.slug,
                value.nonce,
              ),
            }),
          );
        } else if (value.type === "authenticated") {
          clearTimeout(authTimer);
          ws.off("message", authenticate);
          const maxStreams = "maxStreams" in value ? value.maxStreams : 128;
          if (
            typeof maxStreams !== "number" ||
            !Number.isInteger(maxStreams) ||
            maxStreams < 1 ||
            maxStreams > (this.options.maxStreams ?? 128)
          )
            throw new Error("Invalid stream limit");
          const mux = new StreamMultiplexer(ws, { initiator: false, maxStreams });
          this.mux = mux;
          mux.on("stream", (stream: MuxStream) => this.accept(stream, relayHost));
          this.attempt = 0;
          this.emit("connected");
        } else throw new Error("Authentication rejected");
      } catch (error) {
        this.report(error);
        ws.terminate();
      }
    };
    ws.on("message", authenticate);
    ws.on("error", (error) => this.report(error));
    ws.once("close", () => {
      clearTimeout(authTimer);
      if (this.ws !== ws) return;
      this.emit("disconnected");
      if (this.stopped) return;
      const maximum = Math.min(
        this.options.backoffCapMs ?? 30_000,
        (this.options.backoffBaseMs ?? 500) * 2 ** Math.min(this.attempt++, 16),
      );
      this.timer = setTimeout(() => this.connect(), maximum * (0.5 + Math.random() * 0.5));
      this.timer.unref();
    });
  }
  private accept(stream: MuxStream, relayHost: string): void {
    const metadata = stream.metadata;
    const portLabel = new RegExp(`^([1-9][0-9]{0,4})-${this.options.slug}$`).exec(metadata.label);
    const port = portLabel ? Number(portLabel[1]) : undefined;
    if (
      metadata.label !== this.options.slug &&
      (!port || port > 65535 || !this.options.allowPort?.(port))
    ) {
      stream.destroy();
      return;
    }
    if (metadata.port !== port) {
      stream.destroy();
      return;
    }
    if (metadata.kind === "http") {
      this.challengeServer.emit("connection", stream);
      return;
    }
    const hostname = `${metadata.label}.${relayHost}`;
    const tls = new NodeTls.TLSSocket(stream, {
      isServer: true,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        if (servername !== hostname) {
          callback(new Error("SNI differs from stream label"));
          return;
        }
        void this.options.getSecureContext(servername).then(
          (context) => callback(null, context),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
    const timer = setTimeout(() => tls.destroy(new Error("TLS handshake timeout")), 30_000);
    tls.once("close", () => clearTimeout(timer));
    tls.on("error", (error) => {
      this.report(error);
      stream.destroy();
    });
    tls.once("secure", () => {
      clearTimeout(timer);
      if (!tls.servername || tls.servername !== hostname) {
        tls.destroy();
        return;
      }
      try {
        this.options.onSecureConnection(tls, metadata);
      } catch (error) {
        this.report(error);
        tls.destroy();
      }
    });
  }
}
