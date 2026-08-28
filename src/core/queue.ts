import { DEFAULT_CONCURRENCY, normalizeConcurrency } from "../shared/settings";

export type QueueState = "queued" | "running" | "paused" | "success" | "error" | "cancelled";

export type QueueTask<T> = {
  key: string;
  value: T;
  onState?: (state: QueueState, detail?: string) => void;
};

export type QueueControl = {
  readonly signal: AbortSignal;
  readonly isPaused: boolean;
  readonly isCancelled: boolean;
  waitIfPaused(): Promise<void>;
};

type ManagedTask<T> = {
  task: QueueTask<T>;
  state: "queued" | "running" | "paused";
  paused: boolean;
  cancelled: boolean;
  abortController: AbortController;
  resumeWaiters: Set<() => void>;
};

function cancelledError(): DOMException {
  return new DOMException("下载已取消", "AbortError");
}

export class DownloadQueue<T> {
  private readonly pending: ManagedTask<T>[] = [];
  private readonly tasks = new Map<string, ManagedTask<T>>();
  private running = 0;
  private concurrency = DEFAULT_CONCURRENCY;

  constructor(private readonly runner: (task: QueueTask<T>, control: QueueControl) => Promise<void>, concurrency = DEFAULT_CONCURRENCY) {
    this.concurrency = normalizeConcurrency(concurrency);
  }

  get activeCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  get maxConcurrency(): number {
    return this.concurrency;
  }

  setConcurrency(value: number): void {
    this.concurrency = normalizeConcurrency(value);
    this.drain();
  }

  enqueue(task: QueueTask<T>): boolean {
    if (this.tasks.has(task.key)) return false;
    const managed: ManagedTask<T> = {
      task,
      state: "queued",
      paused: false,
      cancelled: false,
      abortController: new AbortController(),
      resumeWaiters: new Set()
    };
    this.tasks.set(task.key, managed);
    this.pending.push(managed);
    task.onState?.("queued");
    this.drain();
    return true;
  }

  enqueueMany(tasks: QueueTask<T>[]): number {
    return tasks.reduce((count, task) => count + Number(this.enqueue(task)), 0);
  }

  pause(key: string): boolean {
    const managed = this.tasks.get(key);
    if (!managed || managed.state !== "running" || managed.cancelled) return false;
    managed.paused = true;
    managed.state = "paused";
    managed.task.onState?.("paused");
    return true;
  }

  resume(key: string): boolean {
    const managed = this.tasks.get(key);
    if (!managed || managed.state !== "paused" || managed.cancelled) return false;
    managed.paused = false;
    managed.state = "running";
    for (const resolve of managed.resumeWaiters) resolve();
    managed.resumeWaiters.clear();
    managed.task.onState?.("running");
    return true;
  }

  pauseAll(keys: Iterable<string> = this.tasks.keys()): number {
    let changed = 0;
    for (const key of keys) changed += Number(this.pause(key));
    return changed;
  }

  resumeAll(keys: Iterable<string> = this.tasks.keys()): number {
    let changed = 0;
    for (const key of keys) changed += Number(this.resume(key));
    return changed;
  }

  cancelAll(keys: Iterable<string> = this.tasks.keys()): number {
    let changed = 0;
    for (const key of [...keys]) changed += Number(this.cancel(key));
    return changed;
  }

  cancel(key: string): boolean {
    const managed = this.tasks.get(key);
    if (!managed || managed.cancelled) return false;
    managed.cancelled = true;
    managed.paused = false;
    managed.abortController.abort();
    for (const resolve of managed.resumeWaiters) resolve();
    managed.resumeWaiters.clear();

    if (managed.state === "queued") {
      const index = this.pending.indexOf(managed);
      if (index >= 0) this.pending.splice(index, 1);
      this.tasks.delete(key);
      managed.task.onState?.("cancelled");
      return true;
    }

    managed.task.onState?.("cancelled");
    return true;
  }

  private controlFor(managed: ManagedTask<T>): QueueControl {
    return {
      signal: managed.abortController.signal,
      get isPaused() { return managed.paused; },
      get isCancelled() { return managed.cancelled; },
      waitIfPaused: async () => {
        while (managed.paused && !managed.cancelled) {
          await new Promise<void>((resolve) => managed.resumeWaiters.add(resolve));
        }
        if (managed.cancelled) throw cancelledError();
      }
    };
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const managed = this.pending.shift();
      if (!managed || managed.cancelled) continue;
      this.running += 1;
      managed.state = "running";
      managed.task.onState?.("running");
      const control = this.controlFor(managed);
      void this.runner(managed.task, control)
        .then(() => {
          if (!managed.cancelled) managed.task.onState?.("success");
        })
        .catch((error: unknown) => {
          if (managed.cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
          const message = error instanceof Error ? error.message : String(error);
          managed.task.onState?.("error", message);
        })
        .finally(() => {
          this.running -= 1;
          this.tasks.delete(managed.task.key);
          this.drain();
        });
    }
  }
}
