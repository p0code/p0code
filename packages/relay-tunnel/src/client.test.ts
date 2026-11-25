import { expect, it, vi } from "vite-plus/test";
import { generateEnvironmentKeyPair, verifyHandshake } from "./auth.ts";
import { HttpChallengeStore } from "./certificates.ts";
import { RelayTunnelClient } from "./client.ts";
import { decodeFrame, encodeFrame, FrameType } from "./codec.ts";

interface TestSocket {
  emit: (event: string, ...args: unknown[]) => boolean;
  sent: string[];
  frames: Array<string | Buffer>;
  terminated: boolean;
}
const { sockets } = vi.hoisted(() => ({ sockets: [] as TestSocket[] }));
vi.mock("ws", async () => {
  const NodeEvents = await import("node:events");
  return {
    default: class extends NodeEvents.EventEmitter {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      terminated = false;
      constructor() {
        super();
        sockets.push(this);
      }
      send(data: string | Buffer): void {
        this.sent.push(data.toString());
        this.frames.push(data);
      }
      frames: Array<string | Buffer> = [];
      terminate(): void {
        this.terminated = true;
      }
    },
  };
});

it("authenticates and reconnects with bounded jittered backoff, ignores stale closes, and stops retrying", async () => {
  sockets.length = 0;
  const keys = generateEnvironmentKeyPair();
  const options = {
    relayUrl: "https://relay.test",
    slug: "abcdef",
    privateKey: keys.privateKey,
    challenges: new HttpChallengeStore(),
    getSecureContext: async () => {
      throw new Error("unused");
    },
    onSecureConnection: () => {},
    backoffBaseMs: 100,
    backoffCapMs: 400,
  };
  const client = new RelayTunnelClient(options);
  using _random = vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers();
  const at = (index: number): TestSocket => {
    const socket = sockets[index];
    if (!socket) throw new Error("Missing socket");
    return socket;
  };
  try {
    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
    const first = at(0);
    first.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "challenge", nonce: "nonce" })),
      false,
    );
    const auth: unknown = JSON.parse(first.sent[0] ?? "null");
    expect(auth).toMatchObject({ type: "authenticate", slug: "abcdef" });
    if (
      !auth ||
      typeof auth !== "object" ||
      !("signature" in auth) ||
      typeof auth.signature !== "string"
    )
      throw new Error("Invalid signature");
    expect(verifyHandshake(keys.publicKey, "relay.test", "abcdef", "nonce", auth.signature)).toBe(
      true,
    );
    first.emit("message", Buffer.from('{"type":"authenticated"}'), false);
    first.emit("close");
    await vi.advanceTimersByTimeAsync(49);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    at(1).emit("close");
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(3);
    at(2).emit("close");
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(4);
    at(3).emit("close");
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(5);
    client.stop();
    client.start();
    expect(sockets).toHaveLength(6);
    expect(at(4).terminated).toBe(true);
    at(4).emit("close");
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(6);
    client.stop();
    at(5).emit("close");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.stop();
    vi.useRealTimers();
  }
});

it("asks allowLabel before anything else, so an unknown name never requests a certificate", async () => {
  sockets.length = 0;
  const keys = generateEnvironmentKeyPair();
  const asked: Array<{ port: number } | { name: string }> = [];
  const getSecureContext = vi.fn(async () => {
    throw new Error("no certificate for refused labels");
  });
  const client = new RelayTunnelClient({
    relayUrl: "https://relay.test",
    slug: "abcdef",
    privateKey: keys.privateKey,
    challenges: new HttpChallengeStore(),
    getSecureContext,
    onSecureConnection: () => {},
    allowLabel: (label) => {
      asked.push(label);
      return false;
    },
  });
  try {
    client.start();
    const socket = sockets[0];
    if (!socket) throw new Error("Missing socket");
    socket.emit("message", Buffer.from('{"type":"challenge","nonce":"n"}'), false);
    const connected = new Promise((resolve) => client.once("connected", resolve));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "authenticated",
          features: ["public-hosts"],
          publicDomain: "usercontent.test",
        }),
      ),
      false,
    );
    const info = { features: ["public-hosts"], publicDomain: "usercontent.test" };
    expect(await connected).toEqual(info);
    expect(client.relayInfo).toEqual(info);
    const open = (streamId: number, label: object) =>
      socket.emit(
        "message",
        encodeFrame({
          type: FrameType.OPEN,
          streamId,
          payload: Buffer.from(JSON.stringify(label)),
        }),
        true,
      );
    open(1, { label: "nope-abcdef", kind: "tls", name: "nope" });
    open(2, { label: "3000-abcdef", kind: "tls", port: 3000 });
    // Another environment's labels are refused without asking.
    open(3, { label: "docs-ghijkl", kind: "tls", name: "docs" });
    expect(asked).toEqual([{ name: "nope" }, { port: 3000 }]);
    expect(getSecureContext).not.toHaveBeenCalled();
    const resets = socket.frames
      .filter((frame): frame is Buffer => Buffer.isBuffer(frame))
      .map((frame) => decodeFrame(frame))
      .filter((frame) => frame.type === FrameType.CLOSE && frame.payload[0] === 1)
      .map((frame) => frame.streamId);
    expect(resets).toEqual([1, 2, 3]);
    socket.emit("close");
    expect(client.relayInfo).toBeUndefined();
  } finally {
    client.stop();
  }
});
