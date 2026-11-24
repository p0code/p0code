import * as NodeNet from "node:net";

export interface ClientHello {
  servername: string;
  bytesConsumed: number;
  bytes: Buffer;
}
export class ClientHelloParser {
  private bytes = Buffer.alloc(0);
  private readonly maxBytes: number;
  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = maxBytes;
  }
  push(chunk: Buffer): ClientHello | undefined {
    if (this.bytes.length + chunk.length > this.maxBytes) throw new Error("ClientHello too large");
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const handshake: Buffer[] = [];
    let position = 0;
    let total = 0;
    while (position + 5 <= this.bytes.length) {
      if (this.bytes[position] !== 22 || this.bytes[position + 1] !== 3)
        throw new Error("Expected TLS handshake record");
      const length = this.bytes.readUInt16BE(position + 3);
      if (length > 18 * 1024 || !length) throw new Error("Invalid TLS record length");
      if (position + 5 + length > this.bytes.length) return undefined;
      handshake.push(this.bytes.subarray(position + 5, position + 5 + length));
      total += length;
      const body = Buffer.concat(handshake, total);
      if (body.length >= 4) {
        if (body[0] !== 1) throw new Error("Expected ClientHello");
        const size = body.readUIntBE(1, 3);
        if (size + 4 > this.maxBytes) throw new Error("ClientHello too large");
        if (body.length >= size + 4)
          return {
            servername: parseHello(body.subarray(4, size + 4)),
            bytesConsumed: this.bytes.length,
            bytes: this.bytes,
          };
      }
      position += length + 5;
    }
    return undefined;
  }
}

function parseHello(body: Buffer): string {
  let offset = 34;
  const need = (length: number): void => {
    if (offset + length > body.length) throw new Error("Truncated ClientHello");
  };
  const skipVector = (width: 1 | 2): void => {
    need(width);
    const length = body.readUIntBE(offset, width);
    offset += width;
    need(length);
    offset += length;
  };
  skipVector(1);
  skipVector(2);
  skipVector(1);
  need(2);
  const end = offset + 2 + body.readUInt16BE(offset);
  offset += 2;
  if (end !== body.length) throw new Error("Invalid extensions length");
  let servername: string | undefined;
  while (offset < end) {
    need(4);
    const type = body.readUInt16BE(offset);
    const size = body.readUInt16BE(offset + 2);
    offset += 4;
    need(size);
    if (type === 0) {
      if (servername || size < 5 || body.readUInt16BE(offset) !== size - 2)
        throw new Error("Invalid SNI extension");
      let cursor = offset + 2;
      while (cursor < offset + size) {
        if (cursor + 3 > offset + size) throw new Error("Truncated SNI");
        const kind = body[cursor];
        const length = body.readUInt16BE(cursor + 1);
        cursor += 3;
        if (!length || cursor + length > offset + size) throw new Error("Invalid SNI length");
        if (kind === 0) {
          if (servername) throw new Error("Duplicate SNI hostname");
          servername = body
            .subarray(cursor, cursor + length)
            .toString("ascii")
            .toLowerCase();
          if (
            !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(servername) ||
            servername.includes("..")
          )
            throw new Error("Invalid SNI hostname");
        }
        cursor += length;
      }
    }
    offset += size;
  }
  if (!servername) throw new Error("SNI required");
  return servername;
}

export function readClientHello(socket: NodeNet.Socket, timeoutMs = 10_000): Promise<ClientHello> {
  return new Promise((resolve, reject) => {
    const parser = new ClientHelloParser();
    const timer = setTimeout(() => fail(new Error("ClientHello timeout")), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => fail(new Error("Socket closed before ClientHello"));
    const onData = (chunk: Buffer): void => {
      try {
        const result = parser.push(chunk);
        if (result) {
          socket.pause();
          cleanup();
          resolve(result);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.resume();
  });
}
