import { describe, expect, it, vi } from "vitest";
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

  it("keeps draining when a UI state observer throws", async () => {
    const completed: number[] = [];
    const queue = new DownloadQueue<number>(async ({ value }) => { completed.push(value); }, 1);
    queue.enqueue({ key: "first", value: 1, onState: () => { throw new Error("broken UI"); } });
    queue.enqueue({ key: "second", value: 2, onState: () => { throw new Error("broken UI"); } });
    await vi.waitFor(() => expect(queue.activeCount + queue.queuedCount).toBe(0));
    expect(completed).toEqual([1, 2]);
  });

  it("pauses and resumes an active task cooperatively", async () => {
    const beforeChunk = deferred();
    const states: string[] = [];
    let completed = false;
    const queue = new DownloadQueue<number>(async (_task, control) => {
      await beforeChunk.promise;
      await control.waitIfPaused();
      completed = true;
    });

    queue.enqueue({ key: "pause-me", value: 1, onState: (state) => states.push(state) });
    expect(queue.pause("pause-me")).toBe(true);
    beforeChunk.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(states).toContain("paused");

    expect(queue.resume("pause-me")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(true);
    expect(states).toContain("success");
  });

  it("cancels waiting and active tasks without reporting an error", async () => {
    const gate = deferred();
    const waitingStates: string[] = [];
    const activeStates: string[] = [];
    const queue = new DownloadQueue<number>(async ({ key }, control) => {
      if (key === "active") {
        await new Promise<void>((resolve, reject) => {
          control.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          void gate.promise.then(resolve);
        });
      }
    }, 1);

    queue.enqueue({ key: "active", value: 1, onState: (state) => activeStates.push(state) });
    queue.enqueue({ key: "waiting", value: 2, onState: (state) => waitingStates.push(state) });
    expect(queue.queuedCount).toBe(1);
    expect(queue.cancel("waiting")).toBe(true);
    expect(queue.queuedCount).toBe(0);
    expect(waitingStates.at(-1)).toBe("cancelled");

    expect(queue.cancel("active")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeStates.at(-1)).toBe("cancelled");
    expect(activeStates).not.toContain("error");
    gate.resolve();
  });

  it("pauses, resumes, and cancels multiple tasks in one operation", async () => {
    const gate = deferred();
    const states = new Map<string, string>();
    const queue = new DownloadQueue<number>(async (_task, control) => {
      await gate.promise;
      await control.waitIfPaused();
    }, 2);
    for (let value = 0; value < 4; value += 1) {
      const key = String(value);
      queue.enqueue({ key, value, onState: (state) => states.set(key, state) });
    }

    expect(queue.pauseAll(["0", "1"])).toBe(2);
    expect(states.get("0")).toBe("paused");
    expect(queue.resumeAll(["0", "1"])).toBe(2);
    expect(states.get("1")).toBe("running");
    expect(queue.cancelAll(["0", "1", "2", "3"])).toBe(4);
    expect([...states.values()].every((state) => state === "cancelled")).toBe(true);
    gate.resolve();
  });

  it("conserves terminal states across 500 mixed queue tasks", async () => {
    const gate = deferred();
    const finalStates = new Map<string, string>();
    const queue = new DownloadQueue<number>(async ({ value }) => {
      await gate.promise;
      if (value % 17 === 0) throw new Error("injected failure");
    }, 5);

    for (let value = 0; value < 500; value += 1) {
      queue.enqueue({ key: String(value), value, onState: (state) => finalStates.set(String(value), state) });
    }
    for (let value = 10; value < 500; value += 10) queue.cancel(String(value));
    gate.resolve();
    await vi.waitFor(() => expect(queue.activeCount + queue.queuedCount).toBe(0));

    expect(finalStates.size).toBe(500);
    expect([...finalStates.values()].filter((state) => ["success", "error", "cancelled"].includes(state))).toHaveLength(500);
  });
});
