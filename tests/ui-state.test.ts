import { describe, expect, it } from "vitest";
import { attachmentPresentation, badgePresentation, LARGE_BLOB_WARNING_BYTES, shouldWarnAboutLargeBlob } from "../src/core/ui-state";

describe("download UI state", () => {
  it("gives queued and failed attachment buttons visible, accessible states", () => {
    expect(attachmentPresentation("queued")).toMatchObject({ disabled: true, content: "queued", text: "等待", ariaLabel: "等待下载" });
    expect(attachmentPresentation("error", "网络连接中断")).toMatchObject({
      disabled: false,
      content: "error",
      text: "!",
      ariaLabel: "下载失败，点击重试：网络连接中断"
    });
  });

  it("prioritizes failed-task badges and caps large queue counts", () => {
    expect(badgePresentation({ mediaCount: 3, messageCount: 2, queueActive: 1, queuePending: 2, queueErrors: 1, queueComplete: 0 })).toMatchObject({ text: "!", color: "#d14b4b" });
    expect(badgePresentation({ mediaCount: 3, messageCount: 2, queueActive: 5, queuePending: 120, queueErrors: 0, queueComplete: 0 }).text).toBe("99+");
  });

  it("warns only for Blob-sized media at or above the safety threshold", () => {
    expect(shouldWarnAboutLargeBlob(LARGE_BLOB_WARNING_BYTES - 1)).toBe(false);
    expect(shouldWarnAboutLargeBlob(LARGE_BLOB_WARNING_BYTES)).toBe(true);
    expect(shouldWarnAboutLargeBlob(undefined)).toBe(false);
  });
});
