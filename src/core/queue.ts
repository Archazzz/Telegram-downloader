import { DEFAULT_CONCURRENCY, normalizeConcurrency } from "../shared/settings";

export type QueueState = "queued" | "running" | "success" | "error";

export type QueueTask<T> = {
  key: string;
  value: T;
  onState?: (state: QueueState, detail?: string) => void;
};

export class DownloadQueue<T> {
  private readonly pending: QueueTask<T>[] = [];
  private readonly activeKeys = new Set<string>();
  private running = 0;
  private concurrency = DEFAULT_CONCURRENCY;

  constructor(private readonly runner: (task: QueueTask<T>) => Promise<void>, concurrency = DEFAULT_CONCURRENCY) {
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
    if (this.activeKeys.has(task.key)) return false;
    this.activeKeys.add(task.key);
    this.pending.push(task);
    task.onState?.("queued");
    this.drain();
    return true;
  }

  enqueueMany(tasks: QueueTask<T>[]): number {
    return tasks.reduce((count, task) => count + Number(this.enqueue(task)), 0);
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) return;
      this.running += 1;
      task.onState?.("running");
      void this.runner(task)
        .then(() => task.onState?.("success"))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          task.onState?.("error", message);
        })
        .finally(() => {
          this.running -= 1;
          this.activeKeys.delete(task.key);
          this.drain();
        });
    }
  }
}

