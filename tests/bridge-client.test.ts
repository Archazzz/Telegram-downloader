import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/content/bridge-client";
import { BRIDGE_FRAME_ATTRIBUTE, BRIDGE_READY_ATTRIBUTE } from "../src/shared/protocol";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("bridge client readiness", () => {
  it("allows a later request to retry after the first bridge load timeout", async () => {
    vi.useFakeTimers();
    const client = new BridgeClient();
    const first = client.status();
    const firstExpectation = expect(first).rejects.toThrow("桥接页不存在");
    await vi.advanceTimersByTimeAsync(3_050);
    await firstExpectation;

    const frame = document.createElement("iframe");
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    document.body.appendChild(frame);
    expect(frame.contentWindow).not.toBeNull();
    // A live bridge page is cross-origin, so contentDocument stays null (happy-dom would expose one).
    Object.defineProperty(frame, "contentDocument", { get: () => null, configurable: true });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    const second = client.status();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    const ping = postMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "bridge:ready",
        requestId: ping.requestId,
        ok: true
      }
    }));
    await vi.waitFor(() => expect(postMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));
    const request = postMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((item) => item.type === "status")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: request.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));

    await expect(second).resolves.toMatchObject({ folderName: "Downloads", permission: "granted" });
  });

  it("recreates a stale bridge iframe and retries status once after an extension reload", async () => {
    vi.useFakeTimers();
    const staleFrame = document.createElement("iframe");
    staleFrame.id = "telegram-media-downloader-bridge";
    staleFrame.src = "about:blank";
    staleFrame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    staleFrame.setAttribute(BRIDGE_READY_ATTRIBUTE, "");
    document.body.appendChild(staleFrame);
    const stalePostMessage = vi.spyOn(staleFrame.contentWindow!, "postMessage");
    const client = new BridgeClient();

    const status = client.status();
    await vi.advanceTimersByTimeAsync(100);
    expect(stalePostMessage.mock.calls.length).toBeGreaterThan(0);
    expect(stalePostMessage.mock.calls.every((call) => (call[0] as { type?: string }).type === "bridge:ping")).toBe(true);
    await vi.advanceTimersByTimeAsync(2_950);

    const replacement = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)!;
    expect(replacement).not.toBe(staleFrame);
    Object.defineProperty(replacement, "contentDocument", { get: () => null, configurable: true });
    const replacementPostMessage = vi.spyOn(replacement.contentWindow!, "postMessage");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(replacementPostMessage).toHaveBeenCalled());

    const ping = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "bridge:ready",
        requestId: ping.requestId,
        ok: true
      }
    }));
    await vi.waitFor(() => expect(replacementPostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));

    const request = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((item) => item.type === "status")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: request.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));

    await expect(status).resolves.toMatchObject({ folderName: "Downloads", permission: "granted" });
  });

  it("catches a postMessage origin race and rebuilds the bridge before retrying", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    frame.id = "telegram-media-downloader-bridge";
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    document.body.appendChild(frame);
    Object.defineProperty(frame, "contentDocument", { get: () => null, configurable: true });
    const stalePostMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
      if ((message as { type?: string }).type === "status") {
        throw new DOMException("The target origin does not match the recipient window's origin", "SecurityError");
      }
    });
    const client = new BridgeClient();

    const status = client.status();
    await vi.waitFor(() => expect(stalePostMessage).toHaveBeenCalled());
    const ping = stalePostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "bridge:ready",
        requestId: ping.requestId,
        ok: true
      }
    }));
    await vi.waitFor(() => expect(stalePostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));

    await vi.waitFor(() => expect(document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)).not.toBe(frame));
    const replacement = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)!;
    Object.defineProperty(replacement, "contentDocument", { get: () => null, configurable: true });
    const replacementPostMessage = vi.spyOn(replacement.contentWindow!, "postMessage");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(replacementPostMessage).toHaveBeenCalled());
    const replacementPing = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "bridge:ready",
        requestId: replacementPing.requestId,
        ok: true
      }
    }));
    await vi.waitFor(() => expect(replacementPostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));

    const statusCall = replacementPostMessage.mock.calls.find((call) => (call[0] as { type?: string }).type === "status")!;
    expect(statusCall[1]).toBe("null");
    const request = statusCall[0] as { requestId: string };
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: request.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));

    await expect(status).resolves.toMatchObject({ permission: "granted" });
  });

  it("rebuilds the bridge when the verified frame falls back to a same-origin document after a reload", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    frame.id = "telegram-media-downloader-bridge";
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    document.body.appendChild(frame);
    // A live bridge page is cross-origin (contentDocument null); after an extension reload the dead
    // frame falls back to a same-origin about:blank whose document becomes readable.
    let stale = false;
    Object.defineProperty(frame, "contentDocument", { get: () => (stale ? document : null), configurable: true });
    const framePostMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const client = new BridgeClient();

    const first = client.status();
    await vi.waitFor(() => expect(framePostMessage).toHaveBeenCalled());
    const ping = framePostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { source: "telegram-media-downloader-bridge", type: "bridge:ready", requestId: ping.requestId, ok: true }
    }));
    await vi.waitFor(() => expect(framePostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));
    const firstRequest = framePostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((item) => item.type === "status")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: firstRequest.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));
    await expect(first).resolves.toMatchObject({ permission: "granted" });

    stale = true;
    framePostMessage.mockClear();

    const second = client.status();
    await vi.advanceTimersByTimeAsync(3_050);
    // The stale window must never receive another request, so no strict-targetOrigin postMessage can misfire.
    expect(framePostMessage.mock.calls.filter((call) => (call[0] as { type?: string }).type === "status")).toHaveLength(0);

    const replacement = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)!;
    expect(replacement).not.toBe(frame);
    Object.defineProperty(replacement, "contentDocument", { get: () => null, configurable: true });
    const replacementPostMessage = vi.spyOn(replacement.contentWindow!, "postMessage");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(replacementPostMessage).toHaveBeenCalled());
    const replacementPing = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: { source: "telegram-media-downloader-bridge", type: "bridge:ready", requestId: replacementPing.requestId, ok: true }
    }));
    await vi.waitFor(() => expect(replacementPostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));

    const secondRequest = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((item) => item.type === "status")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: secondRequest.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));
    await expect(second).resolves.toMatchObject({ permission: "granted" });
  });

  it("rebuilds immediately when the bridge reports an invalidated runtime", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    frame.id = "telegram-media-downloader-bridge";
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    Object.defineProperty(frame, "contentDocument", { get: () => null, configurable: true });
    document.body.appendChild(frame);
    const framePostMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const client = new BridgeClient();

    const status = client.status();
    await vi.waitFor(() => expect(framePostMessage).toHaveBeenCalled());
    const ping = framePostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { source: "telegram-media-downloader-bridge", type: "bridge:ready", requestId: ping.requestId, ok: true }
    }));
    await vi.waitFor(() => expect(framePostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "bridge:invalidated",
        ok: false,
        error: "扩展写入桥接页已失效，正在重新连接",
        errorCode: "BRIDGE_UNAVAILABLE"
      }
    }));

    await vi.waitFor(() => expect(document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)).not.toBe(frame));
    const replacement = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)!;
    Object.defineProperty(replacement, "contentDocument", { get: () => null, configurable: true });
    const replacementPostMessage = vi.spyOn(replacement.contentWindow!, "postMessage");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(replacementPostMessage).toHaveBeenCalled());
    const replacementPing = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: { source: "telegram-media-downloader-bridge", type: "bridge:ready", requestId: replacementPing.requestId, ok: true }
    }));
    await vi.waitFor(() => expect(replacementPostMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "status")).toBe(true));
    const retried = replacementPostMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "status")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: replacement.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "status:response",
        requestId: retried.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));

    await expect(status).resolves.toMatchObject({ permission: "granted" });
  });

  it("keeps a large file close request alive beyond the default bridge timeout", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    Object.defineProperty(frame, "contentDocument", { get: () => null, configurable: true });
    document.body.appendChild(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const client = new BridgeClient();

    const closing = client.closeFile("large-file");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    const ping = postMessage.mock.calls.map((call) => call[0] as { requestId: string; type: string }).find((request) => request.type === "bridge:ping")!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { source: "telegram-media-downloader-bridge", type: "bridge:ready", requestId: ping.requestId, ok: true }
    }));
    await vi.waitFor(() => expect(postMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "file:close")).toBe(true));
    let settled = false;
    void closing.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: "file:close:response",
        requestId: "large-file",
        ok: true,
        payload: { bytesWritten: 1024 }
      }
    }));
    await expect(closing).resolves.toBe(1024);
  });
});
