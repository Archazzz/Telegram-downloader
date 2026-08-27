import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableSleep, withAbortableTimeout } from "../src/core/timing";

afterEach(() => vi.useRealTimers());

describe("abortable retry delay", () => {
  it("ends immediately when the download is cancelled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delay = abortableSleep(4_000, controller.signal);
    controller.abort();
    await expect(delay).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a stalled stream operation and runs its cleanup", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const operation = new Promise<void>(() => undefined);
    const result = withAbortableTimeout(operation, 60_000, new AbortController().signal, new Error("stalled"), cleanup);
    const expectation = expect(result).rejects.toThrow("stalled");
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
