import { describe, expect, it, vi } from "vitest";
import { reserveMapEntry } from "../src/core/registry";

describe("download view reservation", () => {
  it("does not replace or delete the running row when a duplicate enqueue is rejected", () => {
    const running = { state: "running" };
    const entries = new Map([["video", running]]);
    const accept = vi.fn();

    expect(reserveMapEntry(entries, "video", { state: "queued" }, accept)).toBe(false);
    expect(entries.get("video")).toBe(running);
    expect(accept).not.toHaveBeenCalled();
  });

  it("rolls back only the newly reserved row when the queue rejects it", () => {
    const entries = new Map<string, { state: string }>();
    expect(reserveMapEntry(entries, "video", { state: "queued" }, () => false)).toBe(false);
    expect(entries.has("video")).toBe(false);
  });
});
