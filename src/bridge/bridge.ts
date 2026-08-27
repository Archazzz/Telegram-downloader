import { BridgeRequest, BridgeResponse, WRITER_CHANNEL_NAME } from "../shared/protocol";
import { getSettings } from "../shared/settings";
import { errorCode } from "../core/errors";

const ALLOWED_ORIGINS = new Set([
  "https://web.telegram.org"
]);
const RELAY_TIMEOUT_MS = 30_000;

type PendingRelay = {
  event: MessageEvent;
  timeout: number;
};

const writerChannel = new BroadcastChannel(WRITER_CHANNEL_NAME);
const pending = new Map<string, PendingRelay>();
let writerReady = false;
let ensuringWriter: Promise<void> | null = null;

function relayKey(requestId: string, type: string): string {
  return `${requestId}:${type}`;
}

function respond(event: MessageEvent, response: BridgeResponse): void {
  (event.source as WindowProxy | null)?.postMessage(response, { targetOrigin: event.origin });
}

async function ensureWriter(): Promise<void> {
  if (writerReady) return;
  if (!ensuringWriter) {
    ensuringWriter = (async () => {
      const response = await chrome.runtime.sendMessage({ type: "ensure-offscreen-writer" }) as { ok?: boolean; error?: string } | undefined;
      if (!response?.ok) throw new Error(response?.error ?? "无法启动扩展写入器");
      writerReady = true;
    })().finally(() => { ensuringWriter = null; });
  }
  await ensuringWriter;
}

async function forwardRequest(event: MessageEvent, request: BridgeRequest): Promise<void> {
  await ensureWriter();
  const key = relayKey(request.requestId, request.type);
  const timeout = window.setTimeout(() => {
    pending.delete(key);
    writerReady = false;
    respond(event, {
      source: "telegram-media-downloader-bridge",
      type: `${request.type}:response`,
      requestId: request.requestId,
      ok: false,
      error: `扩展写入器请求超时：${request.type}`
    });
  }, RELAY_TIMEOUT_MS);
  pending.set(key, { event, timeout });
  writerChannel.postMessage(request);
}

writerChannel.addEventListener("message", (event: MessageEvent<BridgeResponse>) => {
  const response = event.data;
  if (response?.source !== "telegram-media-downloader-bridge" || !response.requestId || !response.type.endsWith(":response")) return;
  const requestType = response.type.slice(0, -":response".length);
  const key = relayKey(response.requestId, requestType);
  const relay = pending.get(key);
  if (!relay) return;
  window.clearTimeout(relay.timeout);
  pending.delete(key);
  respond(relay.event, response);
});

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || !ALLOWED_ORIGINS.has(event.origin)) return;
  const request = event.data as BridgeRequest;
  if (request?.source !== "telegram-media-downloader" || typeof request.type !== "string" || typeof request.requestId !== "string") return;
  void forwardRequest(event, request).catch((error) => {
    respond(event, {
      source: "telegram-media-downloader-bridge",
      type: `${request.type}:response`,
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: errorCode(error)
    });
  });
});

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.concurrency) return;
    void getSettings().then((settings) => {
      window.parent.postMessage({
        source: "telegram-media-downloader-bridge",
        type: "settings:changed",
        payload: { concurrency: settings.concurrency }
      }, eventOrigin());
    });
  });
}

function eventOrigin(): string {
  try {
    const origin = new URL(document.referrer).origin;
    return ALLOWED_ORIGINS.has(origin) ? origin : "https://web.telegram.org";
  } catch {
    return "https://web.telegram.org";
  }
}
