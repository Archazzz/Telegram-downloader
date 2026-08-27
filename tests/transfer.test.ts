import { describe, expect, it } from "vitest";
import { TransferMeter } from "../src/core/transfer";

describe("transfer rate meter", () => {
  it("calculates bytes per second from progress deltas", () => {
    const meter = new TransferMeter();
    expect(meter.update("网络传输", 1_000, 1_000)).toBe(0);
    expect(meter.update("网络传输", 3_000, 2_000)).toBe(2_000);
  });

  it("resets when the transfer phase changes", () => {
    const meter = new TransferMeter();
    meter.update("Telegram 传输", 1_000, 1_000);
    meter.update("Telegram 传输", 3_000, 2_000);
    expect(meter.update("本地写入", 0, 2_100)).toBe(0);
    expect(meter.update("本地写入", 4_000, 3_100)).toBe(4_000);
  });

  it("resets when a retry restarts byte progress", () => {
    const meter = new TransferMeter();
    meter.update("网络传输", 2_000, 1_000);
    meter.update("网络传输", 4_000, 2_000);
    expect(meter.update("网络传输", 0, 2_100)).toBe(0);
  });
});
