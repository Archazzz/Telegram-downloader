import { describe, expect, it } from "vitest";
import { DownloadQueue } from "../src/core/queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("DownloadQueue", () => {
  it("uses two concurrent tasks by default and deduplicates active keys", async () => {
    const gates = Array.from({ length: 4 }, deferred);
    let started = 0;
    const queue = new DownloadQueue<number>(async ({ value }) => {
      started += 1;
      await gates[value]!.promise;
    });

    expect(queue.maxConcurrency).toBe(2);
    expect(queue.enqueue({ key: "0", value: 0 })).toBe(true);
    expect(queue.enqueue({ key: "0", value: 0 })).toBe(false);
    queue.enqueueMany([1, 2, 3].map((value) => ({ key: String(value), value })));
    await Promise.resolve();
    expect(started).toBe(2);
    expect(queue.activeCount).toBe(2);
    expect(queue.queuedCount).toBe(2);

    gates[0]!.resolve();
    gates[1]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(4);
    gates[2]!.resolve();
    gates[3]!.resolve();
  });

  it("supports up to five concurrent downloads", async () => {
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const queue = new DownloadQueue<number>(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    }, 5);
    for (let value = 0; value < 8; value += 1) queue.enqueue({ key: String(value), value });
    await Promise.resolve();
    expect(queue.maxConcurrency).toBe(5);
    expect(peak).toBe(5);
    gate.resolve();
  });
});

