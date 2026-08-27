import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableSleep } from "../src/core/timing";

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
});
