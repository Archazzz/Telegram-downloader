import { QueueState } from "./queue";

export type BatchSummary = {
  state: "running" | "success" | "error";
  label: string;
  done: boolean;
};

export class BatchProgress {
  total = 0;
  finished = 0;
  succeeded = 0;
  failed = 0;
  cancelled = 0;

  accept(): void {
    this.total += 1;
  }

  record(state: QueueState): void {
    if (state === "success") this.succeeded += 1;
    else if (state === "error") this.failed += 1;
    else if (state === "cancelled") this.cancelled += 1;
    else return;
    this.finished += 1;
  }

  summary(): BatchSummary {
    if (this.finished < this.total) {
      return { state: "running", label: `下载中 ${this.finished}/${this.total}`, done: false };
    }
    if (this.failed > 0 || this.cancelled > 0) {
      const parts = [`成功 ${this.succeeded}`];
      if (this.failed > 0) parts.push(`失败 ${this.failed}`);
      if (this.cancelled > 0) parts.push(`取消 ${this.cancelled}`);
      return { state: "error", label: parts.join(" · "), done: true };
    }
    return { state: "success", label: `已完成 ${this.succeeded}/${this.total}`, done: true };
  }
}
