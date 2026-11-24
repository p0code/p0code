export const FrameType = { OPEN: 1, DATA: 2, CLOSE: 3, WINDOW: 4, PING: 5, PONG: 6 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];
export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}
export const MAX_FRAME_SIZE = 64 * 1024;

export function encodeFrame(frame: Frame): Buffer {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffffffff) {
    throw new Error("Invalid stream ID");
  }
  const result = Buffer.allocUnsafe(5 + frame.payload.length);
  result[0] = frame.type;
  result.writeUInt32BE(frame.streamId, 1);
  frame.payload.copy(result, 5);
  if (result.length > MAX_FRAME_SIZE) throw new Error("Frame too large");
  return result;
}

export function decodeFrame(bytes: Buffer): Frame {
  if (bytes.length < 5 || bytes.length > MAX_FRAME_SIZE) throw new Error("Invalid frame size");
  const type = bytes[0];
  if (type === undefined || type < 1 || type > 6) throw new Error("Unknown frame type");
  return { type: type as FrameType, streamId: bytes.readUInt32BE(1), payload: bytes.subarray(5) };
}

// One frame per WebSocket message. WebSocket continuation fragments share that boundary.
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  push(bytes: Buffer, final: boolean): Frame | undefined {
    this.size += bytes.length;
    if (this.size > MAX_FRAME_SIZE) throw new Error("Frame too large");
    this.chunks.push(bytes);
    if (!final) return undefined;
    const frame = decodeFrame(Buffer.concat(this.chunks, this.size));
    this.chunks = [];
    this.size = 0;
    return frame;
  }
}
