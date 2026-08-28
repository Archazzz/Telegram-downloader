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

    const replacement = document.querySelector<HTMLIFrameElement>(`iframe[${BRIDGE_FRAME_ATTRIBUTE}]`)!;
    expect(replacement).not.toBe(frame);
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
});
