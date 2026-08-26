import { discoverMessageMedia, findMessageRoot, MESSAGE_SELECTOR } from "../core/discovery";
import { MediaDescriptor, buildFileName } from "../core/media";
import { DownloadQueue, QueueState } from "../core/queue";
import { DEFAULT_CONCURRENCY } from "../shared/settings";
import { BridgeClient } from "./bridge-client";

type MessageGroup = {
  id: string;
  root: HTMLElement;
  mediaIds: string[];
  lastSeen: number;
};

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>`;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
const bridge = new BridgeClient();
const mediaById = new Map<string, MediaDescriptor>();
const groups = new Map<string, MessageGroup>();
const pendingRoots = new Set<HTMLElement>();
let scanScheduled = false;

const queue = new DownloadQueue<MediaDescriptor>(async ({ value }) => downloadWithRetry(value), DEFAULT_CONCURRENCY);

bridge.onSettingsChanged = (status) => {
  queue.setConcurrency(status.concurrency);
  postStats();
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatProgress(value: number): string {
  return `${Math.min(99, Math.max(1, Math.round(value * 100)))}%`;
}

function showToast(message: string, timeout = 3200): void {
  document.querySelector(".tmd-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "tmd-toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), timeout);
}

function setAttachmentState(mediaId: string, state: QueueState, detail?: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`.tmd-download-button[data-media-id="${CSS.escape(mediaId)}"]`)) {
    button.dataset.state = state;
    button.disabled = state === "queued" || state === "running";
    button.title = detail ?? (state === "success" ? "下载完成" : state === "error" ? "下载失败，点击重试" : "下载这个媒体");
    button.innerHTML = state === "success" ? CHECK_ICON : state === "running" && detail?.endsWith("%")
      ? `<span class="tmd-progress-label">${detail}</span>`
      : state === "error" ? `<span class="tmd-progress-label">!</span>` : DOWNLOAD_ICON;
  }
  if (state === "success" || state === "error") {
    window.setTimeout(() => resetAttachmentState(mediaId), 2600);
  }
}

function resetAttachmentState(mediaId: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`.tmd-download-button[data-media-id="${CSS.escape(mediaId)}"]`)) {
    button.dataset.state = "idle";
    button.disabled = false;
    button.title = "下载这个媒体";
    button.innerHTML = DOWNLOAD_ICON;
  }
}

function enqueueMedia(media: MediaDescriptor, batchTracker?: (state: QueueState) => void): boolean {
  return queue.enqueue({
    key: media.id,
    value: media,
    onState: (state, detail) => {
      setAttachmentState(media.id, state, detail);
      batchTracker?.(state);
      postStats();
      if (state === "error" && detail) showToast(detail);
    }
  });
}

function decorateAttachment(media: MediaDescriptor): void {
  media.host.classList.add("tmd-media-host");
  let button = media.host.querySelector<HTMLButtonElement>(":scope > .tmd-download-button");
  if (button?.dataset.mediaId !== media.id) {
    button?.remove();
    button = document.createElement("button");
    button.type = "button";
    button.className = "tmd-download-button";
    button.dataset.mediaId = media.id;
    button.dataset.state = "idle";
    button.setAttribute("aria-label", "下载这个媒体");
    button.title = "下载这个媒体";
    button.innerHTML = DOWNLOAD_ICON;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const latest = mediaById.get(button?.dataset.mediaId ?? "");
      if (latest && !enqueueMedia(latest)) showToast("这个文件已在下载队列中");
    });
    media.host.appendChild(button);
  }
}

function decorateBatch(group: MessageGroup): void {
  let actions = group.root.querySelector<HTMLElement>(":scope > .tmd-message-actions");
  if (group.mediaIds.length < 2) {
    actions?.remove();
    return;
  }
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "tmd-message-actions";
    group.root.appendChild(actions);
  }
  let button = actions.querySelector<HTMLButtonElement>(".tmd-batch-button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "tmd-batch-button";
    actions.appendChild(button);
  }
  button.innerHTML = `${DOWNLOAD_ICON}<span>下载本消息全部 ${group.mediaIds.length} 项</span>`;
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const snapshot = group.mediaIds.map((id) => mediaById.get(id)).filter((item): item is MediaDescriptor => Boolean(item));
    let finished = 0;
    let accepted = 0;
    const update = (state: QueueState) => {
      if (state === "success" || state === "error") finished += 1;
      button!.dataset.state = finished < accepted ? "running" : "success";
      button!.querySelector("span")!.textContent = finished < accepted ? `下载中 ${finished}/${accepted}` : `已完成 ${finished}/${accepted}`;
    };
    for (const media of snapshot) accepted += Number(enqueueMedia(media, update));
    if (accepted === 0) showToast("这些文件已在下载队列中");
    else {
      button!.dataset.state = "running";
      button!.querySelector("span")!.textContent = `下载中 0/${accepted}`;
    }
  };
}

function processMessage(root: HTMLElement): void {
  if (!root.isConnected) return;
  const discovered = discoverMessageMedia(root);
  if (discovered.length === 0) return;
  const groupId = discovered[0]!.messageId;
  const mediaIds: string[] = [];
  for (const media of discovered) {
    mediaById.set(media.id, media);
    mediaIds.push(media.id);
    decorateAttachment(media);
  }
  const group = { id: groupId, root, mediaIds, lastSeen: Date.now() };
  groups.set(groupId, group);
  decorateBatch(group);
}

function scheduleRoot(root: HTMLElement): void {
  pendingRoots.add(root);
  if (scanScheduled) return;
  scanScheduled = true;
  window.requestAnimationFrame(processPendingRoots);
}

function processPendingRoots(): void {
  scanScheduled = false;
  const roots = [...pendingRoots].slice(0, 24);
  roots.forEach((root) => pendingRoots.delete(root));
  roots.forEach(processMessage);
  if (pendingRoots.size > 0) scheduleRoot(pendingRoots.values().next().value as HTMLElement);
  postStats();
}

function scheduleNode(node: Node): void {
  if (!(node instanceof Element)) return;
  const root = node.matches(MESSAGE_SELECTOR) ? node as HTMLElement : findMessageRoot(node);
  if (root) scheduleRoot(root);
  for (const nested of node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) scheduleRoot(nested);
}

function pruneRegistry(): void {
  for (const [groupId, group] of groups) {
    if (group.root.isConnected) continue;
    groups.delete(groupId);
    group.mediaIds.forEach((id) => mediaById.delete(id));
  }
  postStats();
}

function postStats(): void {
  window.postMessage({
    source: "telegram-media-downloader",
    type: "page-stats",
    payload: {
      mediaCount: mediaById.size,
      messageCount: groups.size,
      queueActive: queue.activeCount,
      queuePending: queue.queuedCount
    }
  }, window.location.origin);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`服务器返回了无效的 Content-Range：${value}`);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function streamResponse(response: Response, fileRequestId: string, onProgress: (written: number) => void): Promise<number> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    await bridge.writeChunk(fileRequestId, buffer);
    onProgress(buffer.byteLength);
    return buffer.byteLength;
  }
  const reader = response.body.getReader();
  let written = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    await bridge.writeChunk(fileRequestId, value);
    written += value.byteLength;
    onProgress(written);
  }
  return written;
}

async function fetchIntoFile(media: MediaDescriptor, requestId: string, onProgress: (ratio: number) => void): Promise<void> {
  if (/^(blob:|data:)/.test(media.url)) {
    const response = await fetch(media.url);
    if (!response.ok) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    const total = media.size ?? (Number(response.headers.get("Content-Length")) || 0);
    await streamResponse(response, requestId, (written) => total && onProgress(written / total));
    return;
  }

  let offset = 0;
  let total = media.size ?? 0;
  for (;;) {
    const response = await fetch(media.url, { headers: { Range: `bytes=${offset}-` }, credentials: "include" });
    if (response.status !== 200 && response.status !== 206) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    const range = parseContentRange(response.headers.get("Content-Range"));
    if (range) {
      if (range.start !== offset) throw new Error("服务器返回的分块起点不正确");
      total = range.total;
    } else if (!total) {
      total = Number(response.headers.get("Content-Length")) || 0;
    }
    const before = offset;
    const written = await streamResponse(response, requestId, (chunkWritten) => {
      if (total) onProgress((before + chunkWritten) / total);
    });
    offset += written;
    if (written <= 0) throw new Error("下载已停滞，未收到新的媒体数据");
    if (!range || response.status === 200 || offset >= total) break;
    if (offset !== range.end + 1) throw new Error("下载分块长度与服务器声明不一致");
  }
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/目录|授权|取消|HTTP 4\d\d/.test(error.message)) return false;
  return true;
}

async function downloadWithRetry(media: MediaDescriptor): Promise<void> {
  const status = await bridge.status();
  queue.setConcurrency(status.concurrency);
  if (!status.folderName) throw new Error("请先打开扩展设置并选择下载目录");
  if (status.permission !== "granted") throw new Error("下载目录需要重新授权，请打开扩展设置");

  const fileName = buildFileName(media);
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    const requestId = crypto.randomUUID();
    try {
      await bridge.startFile(requestId, fileName, media.mimeType);
      await fetchIntoFile(media, requestId, (ratio) => setAttachmentState(media.id, "running", formatProgress(ratio)));
      await bridge.closeFile(requestId);
      return;
    } catch (error) {
      await bridge.abortFile(requestId);
      if (attempt >= RETRY_DELAYS.length || !retryable(error)) throw error;
      await sleep(RETRY_DELAYS[attempt]!);
    }
  }
}

function boot(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") scheduleNode(mutation.target);
      mutation.addedNodes.forEach(scheduleNode);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "data-src", "data-message-id", "data-mid"]
  });
  document.addEventListener("load", (event) => scheduleNode(event.target as Node), true);
  document.addEventListener("loadedmetadata", (event) => scheduleNode(event.target as Node), true);
  for (const root of document.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) scheduleRoot(root);
  window.setInterval(pruneRegistry, 30_000);
  void bridge.status().then((status) => queue.setConcurrency(status.concurrency)).catch(() => undefined);
  postStats();
}

if (document.documentElement) boot();
else document.addEventListener("DOMContentLoaded", boot, { once: true });
