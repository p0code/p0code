import * as NodeEvents from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vite-plus/test";
import { StreamMultiplexer, type MuxStream, websocketBytes } from "./mux.ts";
import { decodeFrame, FrameType } from "./codec.ts";

async function pair(maxStreams = 128) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const accepted = NodeEvents.EventEmitter.once(server, "connection");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await NodeEvents.EventEmitter.once(ws, "open");
  const [peer] = (await accepted) as [WebSocket];
  const relay = new StreamMultiplexer(ws, { initiator: true, maxStreams });
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
