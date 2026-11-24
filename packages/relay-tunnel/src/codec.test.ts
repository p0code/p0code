import { describe, expect, it } from "vite-plus/test";
import { decodeFrame, encodeFrame, FrameDecoder, FrameType, MAX_FRAME_SIZE } from "./codec.ts";

describe("mux codec", () => {
  it("roundtrips all frame types through arbitrary WebSocket continuation fragments", () => {
    for (const type of Object.values(FrameType)) {
      const frame = { type, streamId: 0x12345678, payload: Buffer.from([0, 255, 10, 0]) };
      const encoded = encodeFrame(frame);
      expect(decodeFrame(encoded)).toEqual(frame);
      const decoder = new FrameDecoder();
      for (let index = 0; index < encoded.length - 1; index++)
        expect(decoder.push(encoded.subarray(index, index + 1), false)).toBeUndefined();
      expect(decoder.push(encoded.subarray(-1), true)).toEqual(frame);
      expect(decoder.push(encoded, true)).toEqual(frame);
    }
  });
  it("rejects unknown, truncated, and oversized frames", () => {
    expect(() => decodeFrame(Buffer.from([1, 0]))).toThrow();
    expect(() => decodeFrame(Buffer.from([100, 0, 0, 0, 0]))).toThrow();
    expect(() => new FrameDecoder().push(Buffer.alloc(MAX_FRAME_SIZE + 1), false)).toThrow();
    expect(() => encodeFrame({ type: 1, streamId: -1, payload: Buffer.alloc(0) })).toThrow();
  });
});
