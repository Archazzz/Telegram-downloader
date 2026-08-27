export type TransferPhase = "Telegram 传输" | "网络传输" | "本地写入";

export class TransferMeter {
  private phase?: TransferPhase;
  private lastBytes = 0;
  private lastAt = 0;
  private rate = 0;

  update(phase: TransferPhase, written: number, now = performance.now()): number {
    if (this.phase !== phase || written < this.lastBytes) {
      this.phase = phase;
      this.lastBytes = written;
      this.lastAt = now;
      this.rate = 0;
      return 0;
    }
    if (this.lastAt === 0) {
      this.lastBytes = written;
      this.lastAt = now;
      return 0;
    }

    const elapsed = now - this.lastAt;
    const transferred = written - this.lastBytes;
    if (elapsed <= 0 || transferred <= 0) return this.rate;

    const instantaneous = transferred * 1_000 / elapsed;
    this.rate = this.rate > 0 ? this.rate * 0.7 + instantaneous * 0.3 : instantaneous;
    this.lastBytes = written;
    this.lastAt = now;
    return this.rate;
  }

  reset(): void {
    this.phase = undefined;
    this.lastBytes = 0;
    this.lastAt = 0;
    this.rate = 0;
  }
}
