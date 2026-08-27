import { describe, expect, it } from "vitest";
import { normalizeDownloadError } from "../src/core/errors";

describe("download error normalization", () => {
  it("turns network failures into an actionable Chinese error", () => {
    expect(normalizeDownloadError(new TypeError("Failed to fetch"))).toMatchObject({
      code: "NETWORK",
      message: "网络连接中断，请检查 VPN 或网络后重试"
    });
  });

  it("classifies detached disks and missing directories as non-transient", () => {
    expect(normalizeDownloadError(new DOMException("gone", "NotFoundError"))).toMatchObject({
      code: "FILESYSTEM_UNAVAILABLE",
      message: "下载目录或目标磁盘已不可用，请重新选择下载目录"
    });
  });

  it("classifies full disks without exposing the browser exception", () => {
    expect(normalizeDownloadError(new DOMException("quota", "QuotaExceededError"))).toMatchObject({
      code: "DISK_FULL",
      message: "目标磁盘空间不足，请清理空间或更换下载目录"
    });
  });
});
