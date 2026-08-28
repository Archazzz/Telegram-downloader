import { BridgeRequest, BridgeResponse, BRIDGE_REQUEST_TIMEOUT_MS, FILE_COMMIT_TIMEOUT_MS, WRITER_CHANNEL_NAME } from "../shared/protocol";
import { getSettings } from "../shared/settings";
import { DownloadError, errorCode } from "../core/errors";

const ALLOWED_ORIGINS = new Set([
  "https://web.telegram.org"
]);
type PendingRelay = {
  event: MessageEvent;
  timeout: number;
};

const writerChannel = new BroadcastChannel(WRITER_CHANNEL_NAME);
const pending = new Map<string, PendingRelay>();
let writerReady = false;
let ensuringWriter: Promise<void> | null = null;
let bridgeInvalidated = false;

function relayKey(requestId: string, type: string): string {
  return `${requestId}:${type}`;
}

function respond(event: MessageEvent, response: BridgeResponse): void {
  (event.source as WindowProxy | null)?.postMessage(response, { targetOrigin: event.origin });
}

function runtimeAvailable(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function invalidatedError(cause?: unknown): DownloadError {
  return new DownloadError("扩展写入桥接页已失效，正在重新连接", "BRIDGE_UNAVAILABLE", cause === undefined ? undefined : { cause });
}

function notifyInvalidated(cause?: unknown): void {
  if (bridgeInvalidated) return;
  bridgeInvalidated = true;
  writerReady = false;
  const error = invalidatedError(cause);
  for (const relay of pending.values()) {
    window.clearTimeout(relay.timeout);
    respond(relay.event, {
      source: "telegram-media-downloader-bridge",
      type: `${(relay.event.data as BridgeRequest).type}:response`,
      requestId: (relay.event.data as BridgeRequest).requestId,
      ok: false,
      error: error.message,
      errorCode: error.code
    });
  }
  pending.clear();
  try {
    window.parent.postMessage({
      source: "telegram-media-downloader-bridge",
      type: "bridge:invalidated",
      ok: false,
      error: error.message,
      errorCode: error.code
    } satisfies BridgeResponse, eventOrigin());
  } catch {
    // The parent may already be unloading; the next request will rebuild the frame.
  }
}

async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  if (bridgeInvalidated || !runtimeAvailable()) {
    const error = invalidatedError();
    notifyInvalidated(error);
    throw error;
  }
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch (error) {
    if (!runtimeAvailable() || (error instanceof Error && /extension context invalidated/i.test(error.message))) {
      notifyInvalidated(error);
      throw invalidatedError(error);
    }
    throw error;
  }
}

function relayTimeout(type: string): number {
  return type === "file:close" ? FILE_COMMIT_TIMEOUT_MS : BRIDGE_REQUEST_TIMEOUT_MS;
}

async function ensureWriter(): Promise<void> {
  if (writerReady) return;
  if (!ensuringWriter) {
    ensuringWriter = (async () => {
      const response = await sendRuntimeMessage<{ ok?: boolean; error?: string } | undefined>({ type: "ensure-offscreen-writer" });
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
  }, relayTimeout(request.type));
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
  if (request.type === "bridge:ping") {
    if (bridgeInvalidated || !runtimeAvailable()) {
      notifyInvalidated();
      return;
    }
    respond(event, {
      source: "telegram-media-downloader-bridge",
      type: "bridge:ready",
      requestId: request.requestId,
      ok: true
    });
    return;
  }
  if (request.type === "page:stats") {
    void sendRuntimeMessage({
      type: "page-stats",
      payload: request.payload?.stats
    }).then(() => respond(event, {
      source: "telegram-media-downloader-bridge",
      type: "page:stats:response",
      requestId: request.requestId,
      ok: true
    })).catch((error) => respond(event, {
      source: "telegram-media-downloader-bridge",
      type: "page:stats:response",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: errorCode(error)
    }));
    return;
  }
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
    }).catch((error) => {
      if (!runtimeAvailable()) notifyInvalidated(error);
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
