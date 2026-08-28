import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelector("iframe[data-tmd-bridge]")?.remove();
});

describe("isolated-world injector", () => {
  it("does not retain a runtime listener that can outlive the extension context", async () => {
    const sendMessage = vi.fn();
    const runtime = {
      getURL: vi.fn(() => "about:blank"),
      sendMessage
    } as unknown as typeof chrome.runtime;
    vi.stubGlobal("chrome", { runtime });
    await import("../src/content/injector");

    expect(() => window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: {
        source: "telegram-media-downloader",
        type: "page-stats",
        payload: { mediaCount: 2 }
      }
    }))).not.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
