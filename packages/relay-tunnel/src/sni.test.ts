import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeEvents from "node:events";
import { expect, it } from "vite-plus/test";
import { ClientHelloParser } from "./sni.ts";

async function captureHello(): Promise<Buffer> {
  const listener = NodeNet.createServer();
  listener.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const accepted = NodeEvents.EventEmitter.once(listener, "connection");
  const client = NodeTls.connect({
    host: "127.0.0.1",
    port: address.port,
    servername: "abcdef.relay.test",
    rejectUnauthorized: false,
  });
  client.on("error", () => {});
  const [socket] = await accepted;
  try {
    const [bytes] = await NodeEvents.EventEmitter.once(socket, "data");
    return bytes as Buffer;
  } finally {
    client.destroy();
    socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

it("parses real ClientHello with byte fragmentation and fragmentation across TLS records, replaying all bytes", async () => {
  const hello = await captureHello();
  const parser = new ClientHelloParser();
  for (const byte of hello.subarray(0, -1))
    expect(parser.push(Buffer.from([byte]))).toBeUndefined();
  const result = parser.push(hello.subarray(-1));
  expect(result?.servername).toBe("abcdef.relay.test");
  expect(result?.bytesConsumed).toBe(hello.length);
  expect(result?.bytes).toEqual(hello);
  const length = hello.readUInt16BE(3);
  const payload = hello.subarray(5, length + 5);
  const records = [payload.subarray(0, 2), payload.subarray(2, 40), payload.subarray(40)].map(
    (part) => {
      const header = Buffer.from([22, 3, 1, 0, 0]);
      header.writeUInt16BE(part.length, 3);
      return Buffer.concat([header, part]);
    },
  );
  const split = new ClientHelloParser();
  expect(split.push(records[0]!)).toBeUndefined();
  expect(split.push(records[1]!)).toBeUndefined();
  expect(split.push(records[2]!)?.servername).toBe("abcdef.relay.test");
  expect(() => new ClientHelloParser(8).push(hello)).toThrow("too large");
  expect(() => new ClientHelloParser().push(Buffer.from([23, 3, 3, 0, 1, 0]))).toThrow();
  const oversized = Buffer.from([22, 3, 3, 255, 255]);
  expect(() => new ClientHelloParser().push(oversized)).toThrow();
});
