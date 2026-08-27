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
    const firstExpectation = expect(first).rejects.toThrow("桥接页未能加载");
    await vi.advanceTimersByTimeAsync(10_050);
    await firstExpectation;

    const frame = document.createElement("iframe");
    frame.src = "about:blank";
    frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
    frame.setAttribute(BRIDGE_READY_ATTRIBUTE, "");
    document.body.appendChild(frame);
    expect(frame.contentWindow).not.toBeNull();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    const second = client.status();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const request = postMessage.mock.calls[0]![0] as { requestId: string; type: string };
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        source: "telegram-media-downloader-bridge",
        type: `${request.type}:response`,
        requestId: request.requestId,
        ok: true,
        payload: { folderName: "Downloads", permission: "granted", concurrency: 2 }
      }
    }));

    await expect(second).resolves.toMatchObject({ folderName: "Downloads", permission: "granted" });
  });
});
