import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeDirectory: vi.fn(),
  chooseDirectory: vi.fn(),
  getDestinationStatus: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  activateWriterDirectory: vi.fn(),
  getWriterDirectoryStatus: vi.fn()
}));

vi.mock("../src/shared/destination", () => ({
  authorizeDirectory: mocks.authorizeDirectory,
  chooseDirectory: mocks.chooseDirectory,
  getDestinationStatus: mocks.getDestinationStatus
}));
vi.mock("../src/shared/settings", () => ({
  MIN_CONCURRENCY: 1,
  MAX_CONCURRENCY: 5,
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings
}));
vi.mock("../src/shared/writer", () => ({
  activateWriterDirectory: mocks.activateWriterDirectory,
  getWriterDirectoryStatus: mocks.getWriterDirectoryStatus
}));

describe("popup UI", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <strong id="folder-name"></strong><span id="folder-status"></span><button id="choose-folder"></button>
      <div id="concurrency-options"></div>
      <strong id="media-count"></strong><span id="media-detail"></span><span class="live-dot"></span>`;
    mocks.getDestinationStatus.mockResolvedValue({ name: "Archive", permission: "denied" });
    mocks.getWriterDirectoryStatus.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({ concurrency: 2 });
    mocks.saveSettings.mockResolvedValue(undefined);
  });

  it("renders a recoverable denied state and refreshes live page statistics", async () => {
    let currentStats = { mediaCount: 8, messageCount: 4, queueActive: 2, queuePending: 3, queueErrors: 0, queueComplete: 1 };
    let runtimeListener: ((message: unknown) => boolean) | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async () => ({ stats: currentStats })),
        onMessage: { addListener: vi.fn((listener) => { runtimeListener = listener; }) }
      }
    });
    const { initPopup } = await import("../src/popup/popup");
    initPopup();

    await vi.waitFor(() => expect(document.getElementById("choose-folder")?.textContent).toBe("重新选择"));
    expect(document.getElementById("folder-status")?.textContent).toBe("目录访问已关闭，请重新选择");
    expect(document.getElementById("media-detail")?.textContent).toContain("2 下载中 · 3 等待");

    currentStats = { ...currentStats, queueActive: 0, queuePending: 0, queueErrors: 2 };
    runtimeListener?.({ type: "page-stats-updated" });
    await vi.waitFor(() => expect(document.getElementById("media-detail")?.textContent).toContain("2 失败"));
    expect(document.querySelector(".live-dot")?.classList.contains("is-connected")).toBe(true);
  });
});
