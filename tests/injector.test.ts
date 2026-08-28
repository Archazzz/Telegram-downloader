import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelector("iframe[data-tmd-bridge]")?.remove();
});

describe("isolated-world injector", () => {
  it("silently stops forwarding stats after the extension context is invalidated", async () => {
    const sendMessage = vi.fn();
    const runtime = {
      getURL: vi.fn(() => "about:blank"),
      sendMessage
    } as unknown as typeof chrome.runtime;
    Object.defineProperty(runtime, "id", {
      get: () => { throw new Error("Extension context invalidated."); }
    });
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
