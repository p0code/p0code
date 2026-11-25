import * as NodeStream from "node:stream";
import * as NodeEvents from "node:events";
import WebSocket, { type RawData } from "ws";
import { decodeFrame, encodeFrame, FrameType, type Frame } from "./codec.ts";

export interface StreamLabel {
  label: string;
  remoteAddr?: string;
  kind: "tls" | "http";
  /** Forwarded port, for `<port>-<envslug>` labels. */
  port?: number;
  /** Public tunnel name, for `<name>-<envslug>` labels. */
  name?: string;
}

/** What a hostname label means: `<envslug>`, `<port>-<envslug>` or `<name>-<envslug>`. */
export interface HostLabel {
  slug: string;
  port?: number;
  name?: string;
}

const ENV_SLUG = /^[a-z][a-z0-9]{5,31}$/;

/**
 * A public tunnel name: 1–30 lowercase letters, digits and single hyphens, not purely numeric
 * (numeric prefixes are forwarded ports). Double hyphens are refused so a label never looks
 * like an IDNA (`xn--`) label.
 */
export function isTunnelName(name: string): boolean {
  return name.length <= 30 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !/^[0-9]+$/.test(name);
}

/**
 * Splits a hostname label at its last hyphen. Env slugs never contain hyphens, so the split is
 * unambiguous. Returns undefined for anything outside the grammar.
 */
export function parseHostLabel(label: string): HostLabel | undefined {
  if (label.length > 63) return undefined;
  const dash = label.lastIndexOf("-");
  const slug = label.slice(dash + 1);
  if (!ENV_SLUG.test(slug)) return undefined;
  if (dash < 0) return { slug };
  const prefix = label.slice(0, dash);
  if (/^[0-9]+$/.test(prefix)) {
    const port = Number(prefix);
    return /^[1-9][0-9]{0,4}$/.test(prefix) && port <= 65535 ? { slug, port } : undefined;
  }
  return isTunnelName(prefix) ? { slug, name: prefix } : undefined;
}

export function parseStreamLabel(bytes: Buffer): StreamLabel {
  const value: unknown = JSON.parse(bytes.toString());
  if (
    !value ||
    typeof value !== "object" ||
    !("label" in value) ||
    typeof value.label !== "string" ||
    !("kind" in value) ||
    (value.kind !== "tls" && value.kind !== "http")
  ) {
    throw new Error("Invalid stream label");
  }
  const parsed = parseHostLabel(value.label);
  if (!parsed) throw new Error("Invalid stream label");
  // `port` and `name` must restate what the label says, so consumers can trust either.
  if (("port" in value ? value.port : undefined) !== parsed.port) throw new Error("Invalid port");
  if (("name" in value ? value.name : undefined) !== parsed.name) throw new Error("Invalid name");
  if ("remoteAddr" in value && typeof value.remoteAddr !== "string")
    throw new Error("Invalid remote address");
  return value as StreamLabel;
}
export function websocketBytes(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}
const WINDOW = 256 * 1024;
const DATA_SIZE = 16 * 1024;
type WriteCallback = (error?: Error | null) => void;

export class MuxStream extends NodeStream.Duplex {
  private credit = WINDOW;
  private receiveCredit = WINDOW;
  private uncredited = 0;
  private pending: { bytes: Buffer; offset: number; callback: WriteCallback } | undefined;
  private peerFinished = false;
  private reset = false;
  readonly id: number;
  readonly metadata: StreamLabel;
  private readonly mux: StreamMultiplexer;
  constructor(id: number, metadata: StreamLabel, mux: StreamMultiplexer) {
    super({ allowHalfOpen: true, highWaterMark: DATA_SIZE });
    this.id = id;
    this.metadata = metadata;
    this.mux = mux;
    this.on("error", () => {});
  }
  override _read(): void {
    this.grant();
  }
  private grant(): void {
    if (!this.uncredited || this.destroyed) return;
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32BE(this.uncredited);
    this.receiveCredit += this.uncredited;
    this.uncredited = 0;
    this.mux.send({ type: FrameType.WINDOW, streamId: this.id, payload: bytes });
  }
  receive(bytes: Buffer): void {
    if (this.peerFinished || bytes.length > this.receiveCredit)
      throw new Error("Stream exceeded receive window");
    this.receiveCredit -= bytes.length;
    this.uncredited += bytes.length;
    if (this.push(bytes)) this.grant();
  }
  addCredit(amount: number): void {
    if (!amount || this.credit + amount > WINDOW) throw new Error("Invalid flow-control credit");
    this.credit += amount;
    this.flush();
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
    this.pending = { bytes, offset: 0, callback };
    this.flush();
  }
  private sending = false;
  private flush(): void {
    const pending = this.pending;
    if (!pending || this.sending || this.destroyed) return;
    if (pending.offset === pending.bytes.length) {
      this.pending = undefined;
      pending.callback();
      return;
    }
    if (!this.credit) return;
    const length = Math.min(DATA_SIZE, this.credit, pending.bytes.length - pending.offset);
    const payload = pending.bytes.subarray(pending.offset, pending.offset + length);
    pending.offset += length;
    this.credit -= length;
    this.sending = true;
    this.mux.send({ type: FrameType.DATA, streamId: this.id, payload }, (error) => {
      this.sending = false;
      if (error) this.destroy(error);
      else this.flush();
    });
  }
  finishFromPeer(reset: boolean): void {
    if (reset) {
      this.reset = true;
      this.destroy(new Error("Peer reset stream"));
    } else {
      this.peerFinished = true;
      this.push(null);
    }
  }
  override _final(callback: WriteCallback): void {
    this.mux.send(
      { type: FrameType.CLOSE, streamId: this.id, payload: Buffer.from([0]) },
      callback,
    );
  }
  override _destroy(error: Error | null, callback: WriteCallback): void {
    if (!this.reset && !(this.peerFinished && this.writableFinished)) {
      this.mux.send({ type: FrameType.CLOSE, streamId: this.id, payload: Buffer.from([1]) });
    }
    const pending = this.pending;
    this.pending = undefined;
    pending?.callback(error ?? new Error("Stream closed"));
    this.mux.remove(this.id);
    callback(error);
  }
}

export interface MultiplexerOptions {
  initiator: boolean;
  maxStreams?: number;
  /**
   * Idle timeout per stream. A function receives the stream's label, so a caller can reap visitor
   * streams sooner than the owner's own.
   */
  idleTimeoutMs?: number | ((metadata: StreamLabel) => number);
}
export class StreamMultiplexer extends NodeEvents.EventEmitter {
  private readonly streams = new Map<number, MuxStream>();
  private nextId = 1;
  private lastPeerId = 0;
  private closed = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private awaitingPong = false;
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly ws: WebSocket;
  private readonly options: MultiplexerOptions;
  constructor(ws: WebSocket, options: MultiplexerOptions) {
    super();
    this.ws = ws;
    this.options = options;
    ws.on("message", this.onMessage);
    ws.once("close", this.onClose);
    ws.on("error", this.onClose);
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        ws.terminate();
        return;
      }
      this.awaitingPong = true;
      this.send({ type: FrameType.PING, streamId: 0, payload: Buffer.alloc(0) });
    }, 30_000);
    this.heartbeat.unref();
  }
  /** Streams open right now, in either direction. */
  get streamCount(): number {
    return this.streams.size;
  }
  get maxStreams(): number {
    return this.options.maxStreams ?? 128;
  }
  open(metadata: StreamLabel): MuxStream {
    if (
      !this.options.initiator ||
      this.closed ||
      this.nextId > 0xffffffff ||
      this.streams.size >= this.maxStreams
    )
      throw new Error("Cannot open stream");
    const id = this.nextId++;
    const stream = this.create(id, metadata);
    this.send({
      type: FrameType.OPEN,
      streamId: id,
      payload: Buffer.from(JSON.stringify(metadata)),
    });
    return stream;
  }
  private create(id: number, metadata: StreamLabel): MuxStream {
    const stream = new MuxStream(id, metadata, this);
    this.streams.set(id, stream);
    this.touch(id);
    return stream;
  }
  private touch(id: number): void {
    const prior = this.idleTimers.get(id);
    if (prior) clearTimeout(prior);
    const configured = this.options.idleTimeoutMs;
    const metadata = this.streams.get(id)?.metadata;
    const timeout =
      typeof configured === "function"
        ? metadata
          ? configured(metadata)
          : 120_000
        : (configured ?? 120_000);
    const timer = setTimeout(() => this.streams.get(id)?.destroy(), timeout);
    timer.unref();
    this.idleTimers.set(id, timer);
  }
  remove(id: number): void {
    this.streams.delete(id);
    clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
  }
  send(frame: Frame, callback?: WriteCallback): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      callback?.(new Error("Tunnel closed"));
      return;
    }
    if (this.streams.has(frame.streamId)) this.touch(frame.streamId);
    this.ws.send(encodeFrame(frame), { binary: true }, (error) => {
      callback?.(error);
      if (error) this.close();
    });
  }
  private readonly onMessage = (data: RawData, binary: boolean): void => {
    try {
      if (!binary) throw new Error("Expected binary mux frame");
      const frame = decodeFrame(websocketBytes(data));
      if (frame.type === FrameType.PING || frame.type === FrameType.PONG) {
        if (frame.streamId || frame.payload.length) throw new Error("Invalid ping/pong");
        if (frame.type === FrameType.PING) this.send({ ...frame, type: FrameType.PONG });
        else this.awaitingPong = false;
        return;
      }
      if (!frame.streamId) throw new Error("Invalid stream ID");
      if (frame.type === FrameType.OPEN) {
        if (this.options.initiator || frame.streamId <= this.lastPeerId)
          throw new Error("Invalid stream open");
        this.lastPeerId = frame.streamId;
        if (this.streams.size >= this.maxStreams) {
          this.send({ type: FrameType.CLOSE, streamId: frame.streamId, payload: Buffer.from([1]) });
          return;
        }
        try {
          this.emit("stream", this.create(frame.streamId, parseStreamLabel(frame.payload)));
        } catch {
          this.send({ type: FrameType.CLOSE, streamId: frame.streamId, payload: Buffer.from([1]) });
        }

        return;
      }
      const stream = this.streams.get(frame.streamId);
      // A reset can cross frames already in flight on the other side.
      if (!stream) {
        if (frame.type === FrameType.CLOSE) return;
        if (
          (frame.streamId >= this.nextId && this.options.initiator) ||
          (!this.options.initiator && frame.streamId > this.lastPeerId)
        )
          this.send({ type: FrameType.CLOSE, streamId: frame.streamId, payload: Buffer.from([1]) });
        return;
      }
      this.touch(frame.streamId);
      try {
        switch (frame.type) {
          case FrameType.DATA:
            stream.receive(frame.payload);
            break;
          case FrameType.WINDOW:
            if (frame.payload.length !== 4) throw new Error("Invalid WINDOW");
            stream.addCredit(frame.payload.readUInt32BE());
            break;
          case FrameType.CLOSE:
            if (frame.payload.length !== 1 || (frame.payload[0] !== 0 && frame.payload[0] !== 1))
              throw new Error("Invalid CLOSE");
            stream.finishFromPeer(frame.payload[0] === 1);
            break;
        }
      } catch (error) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } catch {
      this.close();
    }
  };
  private readonly onClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const stream of this.streams.values()) stream.destroy(new Error("Tunnel disconnected"));
    this.ws.off("message", this.onMessage);
    this.emit("close");
  };
  close(): void {
    this.onClose();
    this.ws.terminate();
  }
}
