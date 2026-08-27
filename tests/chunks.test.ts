import { describe, expect, it } from "vitest";
import { ChunkAccumulator } from "../src/core/chunks";

function bytes(length: number, value: number): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(length);
  chunk.fill(value);
  return chunk;
}

describe("write chunk accumulation", () => {
  it("coalesces small network chunks into fewer writer requests", () => {
    const accumulator = new ChunkAccumulator(10);
    expect(accumulator.push(bytes(4, 1))).toBeNull();
    expect(accumulator.push(bytes(4, 2))).toBeNull();
    const combined = accumulator.push(bytes(4, 3));
    expect(combined).toHaveLength(12);
    expect([...combined!]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(accumulator.flush()).toBeNull();
  });

  it("flushes the remaining tail at end of stream", () => {
    const accumulator = new ChunkAccumulator(10);
    accumulator.push(bytes(3, 7));
    expect([...accumulator.flush()!]).toEqual([7, 7, 7]);
  });
});
