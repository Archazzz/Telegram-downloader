import { BRIDGE_FRAME_ATTRIBUTE } from "../shared/protocol";

const FRAME_ID = "telegram-media-downloader-bridge";

function injectBridge(): void {
  if (document.getElementById(FRAME_ID)) return;
  let bridgeUrl: string;
  try {
    // Reloading the extension invalidates this isolated world; a pending DOMContentLoaded callback
    // would otherwise throw "Extension context invalidated" from chrome.runtime.
    if (!chrome.runtime?.id) return;
    bridgeUrl = chrome.runtime.getURL("bridge.html");
  } catch {
    return;
  }
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.src = bridgeUrl;
  frame.setAttribute(BRIDGE_FRAME_ATTRIBUTE, "");
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
