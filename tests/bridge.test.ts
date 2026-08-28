import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("extension bridge", () => {
  it("forwards page statistics without starting the offscreen file writer", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { id: "test-extension", sendMessage },
      storage: { onChanged: { addListener } }
    });
    vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../src/bridge/bridge");

    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent,
      origin: "https://web.telegram.org",
      data: {
        source: "telegram-media-downloader",
        type: "page:stats",
        requestId: "stats-1",
        payload: { stats: { mediaCount: 7, queueErrors: 1 } }
      }
    }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith({
      type: "page-stats",
      payload: { mediaCount: 7, queueErrors: 1 }
    });
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "ensure-offscreen-writer" });
  });

  it("reports an invalidated runtime without leaking an uncaught rejection", async () => {
    const sendMessage = vi.fn(() => { throw new Error("Extension context invalidated."); });
    vi.stubGlobal("chrome", {
      runtime: { id: "test-extension", sendMessage },
      storage: { onChanged: { addListener: vi.fn() } }
    });
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../src/bridge/bridge");

    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent,
      origin: "https://web.telegram.org",
      data: {
        source: "telegram-media-downloader",
        type: "page:stats",
        requestId: "stats-invalid",
        payload: { stats: { mediaCount: 1 } }
      }
    }));

    await vi.waitFor(() => expect(postMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "bridge:invalidated")).toBe(true));
  });
});
