import { discoverMessageMedia, findMessageRoot, MESSAGE_SELECTOR } from "../core/discovery";
import { MediaDescriptor, buildFileName } from "../core/media";
import { DownloadQueue, QueueControl, QueueState } from "../core/queue";
import { DEFAULT_CONCURRENCY } from "../shared/settings";
import { BridgeClient } from "./bridge-client";

type MessageGroup = {
  id: string;
  root: HTMLElement;
  mediaIds: string[];
  lastSeen: number;
};

type DownloadViewItem = {
  id: string;
  fileName: string;
  thumbnailUrl: string;
  state: QueueState;
  written: number;
  total: number;
  detail?: string;
};

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" /></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>`;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
const bridge = new BridgeClient();
const mediaById = new Map<string, MediaDescriptor>();
const groups = new Map<string, MessageGroup>();
const downloadItems = new Map<string, DownloadViewItem>();
const pendingRoots = new Set<HTMLElement>();
let scanScheduled = false;
let queueRenderScheduled = false;
let queueCollapsed = false;

const queue = new DownloadQueue<MediaDescriptor>(async ({ value }, control) => downloadWithRetry(value, control), DEFAULT_CONCURRENCY);

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function thumbnailUrl(media: MediaDescriptor): string {
  if (media.element instanceof HTMLVideoElement) return media.element.poster || media.element.currentSrc || "";
  return media.element.currentSrc || media.element.getAttribute("src") || "";
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
    button.disabled = state === "queued" || state === "running" || state === "paused";
    button.title = detail ?? (state === "success" ? "下载完成" : state === "error" ? "下载失败，点击重试" : state === "paused" ? "下载已暂停" : "下载这个媒体");
    button.innerHTML = state === "success" ? CHECK_ICON : state === "paused" ? `<span class="tmd-progress-label">Ⅱ</span>` : state === "running" && detail?.endsWith("%")
      ? `<span class="tmd-progress-label">${detail}</span>`
      : state === "error" ? `<span class="tmd-progress-label">!</span>` : DOWNLOAD_ICON;
  }
  if (state === "success" || state === "error" || state === "cancelled") {
    window.setTimeout(() => resetAttachmentState(mediaId), 2200);
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

function scheduleQueueRender(): void {
  if (queueRenderScheduled) return;
  queueRenderScheduled = true;
  window.requestAnimationFrame(() => {
    queueRenderScheduled = false;
    renderQueuePanel();
  });
}

function updateDownloadState(mediaId: string, state: QueueState, detail?: string): void {
  const item = downloadItems.get(mediaId);
  if (!item) return;
  item.state = state;
  if (detail) item.detail = detail;
  scheduleQueueRender();
  if (state === "success" || state === "error" || state === "cancelled") {
    window.setTimeout(() => {
      if (downloadItems.get(mediaId)?.state === state) {
        downloadItems.delete(mediaId);
        scheduleQueueRender();
      }
    }, 2200);
  }
}

function updateDownloadProgress(mediaId: string, written: number, total: number): void {
  const item = downloadItems.get(mediaId);
  if (!item) return;
  item.written = written;
  item.total = total;
  scheduleQueueRender();
}

function queueActionButton(label: string, icon: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tmd-queue-icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  return button;
}

function renderQueueRow(item: DownloadViewItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "tmd-queue-row";
  row.dataset.state = item.state;

  const preview = document.createElement("div");
  preview.className = "tmd-queue-preview";
  if (item.thumbnailUrl) {
    const image = document.createElement("img");
    image.src = item.thumbnailUrl;
    image.alt = "";
    preview.appendChild(image);
  } else {
    preview.innerHTML = DOWNLOAD_ICON;
  }

  const content = document.createElement("div");
  content.className = "tmd-queue-row-content";
  const name = document.createElement("strong");
  name.textContent = item.fileName;
  const detail = document.createElement("span");
  if (item.state === "queued") detail.textContent = "等待下载";
  else if (item.state === "cancelled") detail.textContent = "已取消";
  else if (item.state === "error") detail.textContent = item.detail ?? "下载失败";
  else if (item.state === "success") detail.textContent = "下载完成";
  else {
    const progress = item.total > 0 ? `${formatBytes(item.written)} / ${formatBytes(item.total)} (${Math.round(item.written / item.total * 100)}%)` : `${formatBytes(item.written)}`;
    detail.textContent = item.state === "paused" ? `已暂停 · ${progress}` : progress;
  }
  const track = document.createElement("div");
  track.className = "tmd-queue-progress";
  const fill = document.createElement("i");
  fill.style.width = item.total > 0 ? `${Math.min(100, item.written / item.total * 100)}%` : item.state === "running" ? "28%" : "0%";
  track.appendChild(fill);
  content.append(name, detail, track);

  const actions = document.createElement("div");
  actions.className = "tmd-queue-row-actions";
  if (item.state === "running") actions.appendChild(queueActionButton("暂停", PAUSE_ICON, () => queue.pause(item.id)));
  if (item.state === "paused") actions.appendChild(queueActionButton("继续", PLAY_ICON, () => queue.resume(item.id)));
  if (item.state === "queued" || item.state === "running" || item.state === "paused") {
    actions.appendChild(queueActionButton("取消", CLOSE_ICON, () => queue.cancel(item.id)));
  }
  row.append(preview, content, actions);
  return row;
}

function queueSection(title: string, items: DownloadViewItem[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "tmd-queue-section";
  const heading = document.createElement("h3");
  heading.textContent = `${title} ${items.length}`;
  section.appendChild(heading);
  items.forEach((item) => section.appendChild(renderQueueRow(item)));
  return section;
}

function renderQueuePanel(): void {
  const items = [...downloadItems.values()];
  let panel = document.querySelector<HTMLElement>(".tmd-queue-panel");
  if (items.length === 0) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("aside");
    panel.className = "tmd-queue-panel";
    panel.setAttribute("aria-label", "下载队列");
    document.body.appendChild(panel);
  }
  panel.replaceChildren();
  panel.classList.toggle("collapsed", queueCollapsed);

  const running = items.filter((item) => item.state === "running" || item.state === "paused");
  const waiting = items.filter((item) => item.state === "queued");
  const terminal = items.filter((item) => item.state === "success" || item.state === "error" || item.state === "cancelled");
  const totalBytes = items.reduce((sum, item) => sum + item.total, 0);
  const writtenBytes = items.reduce((sum, item) => sum + Math.min(item.written, item.total || item.written), 0);

  const header = document.createElement("header");
  const headingWrap = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = running.length > 0 ? "下载中" : waiting.length > 0 ? "等待下载" : "下载队列";
  const summary = document.createElement("span");
  summary.textContent = totalBytes > 0 ? `总进度：${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)} (${Math.round(writtenBytes / totalBytes * 100)}%)` : `${running.length} 个进行中 · ${waiting.length} 个等待`;
  headingWrap.append(heading, summary);
  const collapse = queueActionButton(queueCollapsed ? "展开下载队列" : "收起下载队列", COLLAPSE_ICON, () => {
    queueCollapsed = !queueCollapsed;
    scheduleQueueRender();
  });
  collapse.classList.add("tmd-queue-collapse");
  header.append(headingWrap, collapse);
  panel.appendChild(header);

  if (queueCollapsed) return;
  if (running.length > 0) panel.appendChild(queueSection("正在下载", running));
  if (waiting.length > 0) panel.appendChild(queueSection("等待中", waiting));
  if (terminal.length > 0) panel.appendChild(queueSection("最近状态", terminal));
}

function enqueueMedia(media: MediaDescriptor, batchTracker?: (state: QueueState) => void): boolean {
  downloadItems.set(media.id, {
    id: media.id,
    fileName: buildFileName(media),
    thumbnailUrl: thumbnailUrl(media),
    state: "queued",
    written: 0,
    total: media.size ?? 0
  });
  const accepted = queue.enqueue({
    key: media.id,
    value: media,
    onState: (state, detail) => {
      setAttachmentState(media.id, state, detail);
      updateDownloadState(media.id, state, detail);
      batchTracker?.(state);
      postStats();
      if (state === "error" && detail) showToast(detail);
    }
  });
  if (!accepted) downloadItems.delete(media.id);
  scheduleQueueRender();
  return accepted;
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
      if (state === "success" || state === "error" || state === "cancelled") finished += 1;
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
    group.mediaIds.forEach((id) => {
      if (!downloadItems.has(id)) mediaById.delete(id);
    });
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

async function streamResponse(
  response: Response,
  fileRequestId: string,
  control: QueueControl,
  onProgress: (written: number) => void
): Promise<number> {
  if (!response.body) {
    await control.waitIfPaused();
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (control.isCancelled) throw new DOMException("下载已取消", "AbortError");
    await bridge.writeChunk(fileRequestId, buffer);
    onProgress(buffer.byteLength);
    return buffer.byteLength;
  }
  const reader = response.body.getReader();
  let written = 0;
  for (;;) {
    await control.waitIfPaused();
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (control.isCancelled) throw new DOMException("下载已取消", "AbortError");
    await bridge.writeChunk(fileRequestId, value);
    written += value.byteLength;
    onProgress(written);
  }
  return written;
}

async function fetchIntoFile(
  media: MediaDescriptor,
  requestId: string,
  control: QueueControl,
  onProgress: (written: number, total: number) => void
): Promise<void> {
  if (/^(blob:|data:)/.test(media.url)) {
    const response = await fetch(media.url, { signal: control.signal });
    if (!response.ok) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    const total = media.size ?? (Number(response.headers.get("Content-Length")) || 0);
    await streamResponse(response, requestId, control, (written) => onProgress(written, total));
    return;
  }

  let offset = 0;
  let total = media.size ?? 0;
  for (;;) {
    await control.waitIfPaused();
    const response = await fetch(media.url, { headers: { Range: `bytes=${offset}-` }, credentials: "include", signal: control.signal });
    if (response.status !== 200 && response.status !== 206) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    const range = parseContentRange(response.headers.get("Content-Range"));
    if (range) {
      if (range.start !== offset) throw new Error("服务器返回的分块起点不正确");
      total = range.total;
    } else if (!total) {
      total = Number(response.headers.get("Content-Length")) || 0;
    }
    const before = offset;
    const written = await streamResponse(response, requestId, control, (chunkWritten) => onProgress(before + chunkWritten, total));
    offset += written;
    if (written <= 0) throw new Error("下载已停滞，未收到新的媒体数据");
    if (!range || response.status === 200 || offset >= total) break;
    if (offset !== range.end + 1) throw new Error("下载分块长度与服务器声明不一致");
  }
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (/目录|授权|取消|HTTP 4\d\d/.test(error.message)) return false;
  return true;
}

async function downloadWithRetry(media: MediaDescriptor, control: QueueControl): Promise<void> {
  const status = await bridge.status();
  queue.setConcurrency(status.concurrency);
  if (!status.folderName) throw new Error("请点击扩展图标并选择下载目录");
  if (status.permission !== "granted") throw new Error("下载目录需要重新授权，请点击扩展图标后重新授权一次");

  const fileName = buildFileName(media);
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    await control.waitIfPaused();
    const requestId = crypto.randomUUID();
    try {
      await bridge.startFile(requestId, fileName, media.mimeType);
      await fetchIntoFile(media, requestId, control, (written, total) => {
        updateDownloadProgress(media.id, written, total);
        if (total > 0) setAttachmentState(media.id, "running", formatProgress(written / total));
      });
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
