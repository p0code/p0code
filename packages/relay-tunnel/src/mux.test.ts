import * as NodeEvents from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vite-plus/test";
import {
  isTunnelName,
  parseHostLabel,
  parseStreamLabel,
  StreamMultiplexer,
  type MultiplexerOptions,
  type MuxStream,
  websocketBytes,
} from "./mux.ts";
import { decodeFrame, FrameType } from "./codec.ts";

async function pair(maxStreams = 128, idleTimeoutMs?: MultiplexerOptions["idleTimeoutMs"]) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const accepted = NodeEvents.EventEmitter.once(server, "connection");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await NodeEvents.EventEmitter.once(ws, "open");
  const [peer] = (await accepted) as [WebSocket];
  const relay = new StreamMultiplexer(ws, {
    initiator: true,
    maxStreams,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
  });
  const env = new StreamMultiplexer(peer, { initiator: false, maxStreams });
  return {
    relay,
    env,
    peer,
    async close() {
      relay.close();
      env.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("stalls a writer at its credit window while another stream progresses, then resumes without losing bytes", async () => {
  const connection = await pair();
  try {
    const incoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const stream = connection.relay.open({ label: "abcdef", kind: "tls" });
    const [receiver] = (await incoming) as [MuxStream];
    let received = 0;
    const fullWindow = new Promise<void>((resolve) =>
      connection.peer.on("message", (data) => {
        const frame = decodeFrame(websocketBytes(data));
        if (frame.type === FrameType.DATA && frame.streamId === stream.id) {
          received += frame.payload.length;
          if (received === 256 * 1024) resolve();
        }
      }),
    );
    let completed = false;
    const payload = Buffer.alloc(1024 * 1024, 0xab);
    const written = new Promise<void>((resolve, reject) =>
      stream.write(payload, (error) => {
        completed = true;
        if (error) reject(error);
        else resolve();
      }),
    );
    await fullWindow;
    expect(completed).toBe(false);
    const next = NodeEvents.EventEmitter.once(connection.env, "stream");
    const fast = connection.relay.open({ label: "ghijkl", kind: "tls" });
    const [fastPeer] = (await next) as [MuxStream];
    const fastData = NodeEvents.EventEmitter.once(fastPeer, "data");
    fast.end("unblocked");
    expect((await fastData)[0].toString()).toBe("unblocked");
    const chunks: Buffer[] = [];
    receiver.on("data", (bytes: Buffer) => chunks.push(bytes));
    const ended = NodeEvents.EventEmitter.once(receiver, "end");
    await written;
    stream.end();
    await ended;
    expect(Buffer.concat(chunks)).toEqual(payload);
    const response = NodeEvents.EventEmitter.once(stream, "data");
    receiver.end("after half-close");
    expect((await response)[0].toString()).toBe("after half-close");
  } finally {
    await connection.close();
  }
});

it("rejects environment-initiated streams and caps streams", async () => {
  const connection = await pair(1);
  try {
    expect(() => connection.env.open({ label: "abcdef", kind: "tls" })).toThrow();
    const incoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const stream = connection.relay.open({ label: "abcdef", kind: "tls" });
    const [receiver] = (await incoming) as [MuxStream];
    expect(() => connection.relay.open({ label: "ghijkl", kind: "tls" })).toThrow();
    const closed = new Promise<void>((resolve) => receiver.once("close", resolve));
    stream.destroy();
    await closed;
    expect(connection.env.streamCount).toBe(0);
  } finally {
    await connection.close();
  }
});

it("resets an excess stream and malformed stream credit without dropping its peers", async () => {
  const connection = await pair(1);
  try {
    const incoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const stream = connection.relay.open({ label: "abcdef", kind: "tls" });
    const [receiver] = (await incoming) as [MuxStream];
    const reset = new Promise<void>((resolve) => connection.peer.once("message", () => resolve()));
    connection.relay.send({
      type: FrameType.OPEN,
      streamId: 99,
      payload: Buffer.from(JSON.stringify({ label: "ghijkl", kind: "tls" })),
    });
    await reset;
    const data = NodeEvents.EventEmitter.once(receiver, "data");
    stream.write("still alive");
    expect((await data)[0].toString()).toBe("still alive");
    const closed = new Promise<void>((resolve) => receiver.once("close", resolve));
    connection.relay.send({
      type: FrameType.WINDOW,
      streamId: stream.id,
      payload: Buffer.from([0]),
    });
    await closed;
    const next = NodeEvents.EventEmitter.once(connection.env, "stream");
    // OPEN IDs remain monotonic even when a capacity reset was sent.
    connection.relay.send({
      type: FrameType.OPEN,
      streamId: 100,
      payload: Buffer.from(JSON.stringify({ label: "ghijkl", kind: "tls" })),
    });
    expect(((await next)[0] as MuxStream).id).toBe(100);
  } finally {
    await connection.close();
  }
});

it("parses host labels: env slug, numeric port prefix, or a public tunnel name", () => {
  expect(parseHostLabel("abcdef")).toEqual({ slug: "abcdef" });
  expect(parseHostLabel("3000-abcdef")).toEqual({ slug: "abcdef", port: 3000 });
  expect(parseHostLabel("65535-abcdef")).toEqual({ slug: "abcdef", port: 65535 });
  expect(parseHostLabel("docs-abcdef")).toEqual({ slug: "abcdef", name: "docs" });
  expect(parseHostLabel("pub-abcdef")).toEqual({ slug: "abcdef", name: "pub" });
  expect(parseHostLabel("my-app-2-abcdef")).toEqual({ slug: "abcdef", name: "my-app-2" });
  expect(parseHostLabel("3d-abcdef")).toEqual({ slug: "abcdef", name: "3d" });
  for (const label of [
    "",
    "abc",
    "-abcdef",
    "0-abcdef",
    "0300-abcdef",
    "65536-abcdef",
    "docs--x-abcdef",
    "docs--abcdef",
    "Docs-abcdef",
    "docs_x-abcdef",
    "docs-1abcdef",
    `${"a".repeat(31)}-abcdef`,
  ])
    expect(parseHostLabel(label), label).toBeUndefined();
  expect(isTunnelName("a".repeat(30))).toBe(true);
  expect(isTunnelName("123")).toBe(false);
});

it("refuses stream labels whose port or name does not restate the label", () => {
  const parse = (value: object) => () => parseStreamLabel(Buffer.from(JSON.stringify(value)));
  expect(parse({ label: "docs-abcdef", kind: "tls", name: "docs" })()).toMatchObject({
    name: "docs",
  });
  expect(parse({ label: "docs-abcdef", kind: "tls" })).toThrow();
  expect(parse({ label: "docs-abcdef", kind: "tls", name: "other" })).toThrow();
  expect(parse({ label: "docs-abcdef", kind: "tls", port: 80 })).toThrow();
  expect(parse({ label: "80-abcdef", kind: "http" })).toThrow();
  expect(parse({ label: "80-abcdef", kind: "http", port: 80, name: "80" })).toThrow();
  expect(parse({ label: "abcdef", kind: "tls", name: "docs" })).toThrow();
  expect(parse({ label: "not a label", kind: "tls" })).toThrow();
});

it("exposes the open stream count and limit", async () => {
  const connection = await pair(3);
  try {
    expect(connection.relay.maxStreams).toBe(3);
    const incoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const stream = connection.relay.open({ label: "docs-abcdef", kind: "tls", name: "docs" });
    await incoming;
    expect(connection.relay.streamCount).toBe(1);
    expect(connection.env.streamCount).toBe(1);
    stream.destroy();
    expect(connection.relay.streamCount).toBe(0);
  } finally {
    await connection.close();
  }
});

it("reaps an idle visitor stream while the owner's own stream stays open", async () => {
  // Visitor streams (port/name labels) get a short idle timeout; the bare slug keeps the owner's.
  const connection = await pair(8, (metadata) => (metadata.name === undefined ? 5_000 : 100));
  try {
    const visitorIncoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const visitor = connection.relay.open({ label: "docs-abcdef", kind: "tls", name: "docs" });
    await visitorIncoming;
    const ownerIncoming = NodeEvents.EventEmitter.once(connection.env, "stream");
    const owner = connection.relay.open({ label: "abcdef", kind: "tls" });
    await ownerIncoming;
    await NodeEvents.EventEmitter.once(visitor, "close");
    expect(visitor.destroyed).toBe(true);
    expect(connection.relay.streamCount).toBe(1);
    expect(owner.destroyed).toBe(false);
  } finally {
    await connection.close();
  }
});
