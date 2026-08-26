import { BRIDGE_FRAME_ATTRIBUTE, BRIDGE_READY_ATTRIBUTE } from "../shared/protocol";

const FRAME_ID = "telegram-media-downloader-bridge";

function injectBridge(): void {
  if (document.getElementById(FRAME_ID)) return;
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.src = chrome.runtime.getURL("bridge.html");
  frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
  frame.addEventListener("load", () => frame.setAttribute(BRIDGE_READY_ATTRIBUTE, ""), { once: true });
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    left: "-10000px",
    top: "-10000px",
    border: "0",
    opacity: "0",
    pointerEvents: "none"
  });
  (document.documentElement ?? document).appendChild(frame);
}

if (document.documentElement) injectBridge();
else document.addEventListener("DOMContentLoaded", injectBridge, { once: true });

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (data?.source !== "telegram-media-downloader" || data.type !== "page-stats") return;
  void chrome.runtime.sendMessage({ type: "page-stats", payload: data.payload });
});
