import { discoverMessageMedia, findMessageRoot, MESSAGE_SELECTOR } from "../core/discovery";
import { ChunkAccumulator } from "../core/chunks";
import { BatchProgress } from "../core/batch";
import { DownloadError, errorCode, isAbortError, normalizeDownloadError } from "../core/errors";
import { MediaDescriptor, buildFileName, mediaElementUrl, parseStreamMetadata } from "../core/media";
import { DownloadQueue, QueueControl, QueueState } from "../core/queue";
import { validateRangeResponse } from "../core/range";
import { reserveMapEntry } from "../core/registry";
import { downloadTelegramBlob, TelegramBlob } from "../core/telegram";
import { abortableSleep, withAbortableTimeout } from "../core/timing";
import { TransferMeter, TransferPhase } from "../core/transfer";
import { attachmentPresentation, shouldWarnAboutLargeBlob } from "../core/ui-state";
import { revealVideoSource } from "../core/viewer";
import { DEFAULT_CONCURRENCY } from "../shared/settings";
import { BridgeClient } from "./bridge-client";

type MessageGroup = {
  id: string;
  root: HTMLElement;
  mediaIds: string[];
};

type DownloadViewItem = {
  id: string;
  fileName: string;
  thumbnailUrl: string;
  state: QueueState;
  written: number;
  total: number;
  phase?: TransferPhase;
  speedBytesPerSecond: number;
  meter: TransferMeter;
  canPause: boolean;
  detail?: string;
};

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" /></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>`;
const RETRY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>`;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
const TELEGRAM_RETRY_DELAYS = [1_000, 2_000];
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;
const bridge = new BridgeClient();
const mediaById = new Map<string, MediaDescriptor>();
const groups = new Map<string, MessageGroup>();
const groupIdByRoot = new WeakMap<HTMLElement, string>();
const downloadItems = new Map<string, DownloadViewItem>();
const pendingRoots = new Set<HTMLElement>();
let scanScheduled = false;
let queueRenderScheduled = false;
let queueCollapsed = false;
let viewerHintShown = false;
const warnedLargeMedia = new Set<string>();

const queue = new DownloadQueue<MediaDescriptor>(async ({ value }, control) => downloadWithRetry(value, control), DEFAULT_CONCURRENCY);

bridge.onSettingsChanged = (status) => {
  queue.setConcurrency(status.concurrency);
  postStats();
};

function formatProgress(value: number): string {
  return `${Math.min(99, Math.max(1, Math.round(value * 100)))}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function thumbnailUrl(media: MediaDescriptor): string {
  if (media.element instanceof HTMLVideoElement) return media.element.poster || media.element.currentSrc || "";
  return media.element.currentSrc || media.element.getAttribute("src") || "";
}

function showToast(message: string, options: { persistent?: boolean; timeout?: number } = {}): void {
  const persistent = options.persistent === true;
  if (persistent) {
    const duplicate = [...document.querySelectorAll<HTMLElement>(".tmd-toast[data-persistent='true']")]
      .some((toast) => toast.dataset.message === message);
    if (duplicate) return;
  } else {
    document.querySelector(".tmd-toast:not([data-persistent='true'])")?.remove();
  }
  const toast = document.createElement("div");
  toast.className = "tmd-toast";
  toast.dataset.persistent = String(persistent);
  toast.dataset.message = message;
  toast.setAttribute("role", persistent ? "alert" : "status");
  const copy = document.createElement("span");
  copy.textContent = message;
  toast.appendChild(copy);
  if (persistent) {
    toast.appendChild(queueActionButton("关闭提示", CLOSE_ICON, () => toast.remove()));
  }
  let stack = document.querySelector<HTMLElement>(".tmd-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "tmd-toast-stack";
    document.body.appendChild(stack);
  }
  stack.appendChild(toast);
  if (!persistent) window.setTimeout(() => toast.remove(), options.timeout ?? 3200);
}

function setAttachmentState(mediaId: string, state: QueueState, detail?: string): void {
  const presentation = attachmentPresentation(state, detail);
  for (const button of document.querySelectorAll<HTMLButtonElement>(`.tmd-download-button[data-media-id="${CSS.escape(mediaId)}"]`)) {
    button.dataset.state = state;
    button.disabled = presentation.disabled;
    button.title = presentation.title;
    button.setAttribute("aria-label", presentation.ariaLabel);
    button.innerHTML = presentation.content === "success" ? CHECK_ICON
      : presentation.text ? `<span class="tmd-progress-label">${presentation.text}</span>`
      : DOWNLOAD_ICON;
  }
  if (state === "success" || state === "cancelled") {
    window.setTimeout(() => resetAttachmentState(mediaId), 2200);
  }
}

function resetAttachmentState(mediaId: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`.tmd-download-button[data-media-id="${CSS.escape(mediaId)}"]`)) {
    button.dataset.state = "idle";
    button.disabled = false;
    button.title = "下载这个媒体";
    button.setAttribute("aria-label", "下载这个媒体");
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
  const previousState = item.state;
  item.state = state;
  if (state === "paused" || (previousState === "paused" && state === "running")) {
    item.meter.reset();
    item.speedBytesPerSecond = 0;
  }
  if (detail) item.detail = detail;
  scheduleQueueRender();
}

function updateDownloadProgress(mediaId: string, written: number, total: number, phase: TransferPhase): void {
  const item = downloadItems.get(mediaId);
  if (!item) return;
  item.written = written;
  item.total = total;
  item.phase = phase;
  item.canPause = phase !== "Telegram 传输";
  item.speedBytesPerSecond = item.meter.update(phase, written);
  scheduleQueueRender();
}

function setDownloadPausable(mediaId: string, canPause: boolean): void {
  const item = downloadItems.get(mediaId);
  if (!item) return;
  item.canPause = canPause;
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
    const transfer = item.state === "running" && item.speedBytesPerSecond > 0 ? ` · ${formatSpeed(item.speedBytesPerSecond)}` : "";
    const phase = item.phase ? ` · ${item.phase}` : "";
    detail.textContent = item.state === "paused" ? `已暂停 · ${progress}${phase}` : `${progress}${transfer}${phase}`;
  }
  const track = document.createElement("div");
  track.className = "tmd-queue-progress";
  const fill = document.createElement("i");
  fill.style.width = item.total > 0 ? `${Math.min(100, item.written / item.total * 100)}%` : item.state === "running" ? "28%" : "0%";
  track.appendChild(fill);
  content.append(name, detail, track);

  const actions = document.createElement("div");
  actions.className = "tmd-queue-row-actions";
  if (item.state === "running" && item.canPause) actions.appendChild(queueActionButton("暂停", PAUSE_ICON, () => queue.pause(item.id)));
  if (item.state === "paused") actions.appendChild(queueActionButton("继续", PLAY_ICON, () => queue.resume(item.id)));
  if (item.state === "queued" || item.state === "running" || item.state === "paused") {
    actions.appendChild(queueActionButton("取消", CLOSE_ICON, () => queue.cancel(item.id)));
  }
  if (item.state === "error") {
    actions.appendChild(queueActionButton("重试", RETRY_ICON, () => retryDownload(item.id)));
    actions.appendChild(queueActionButton("清除此失败任务", CLOSE_ICON, () => removeDownloadItem(item.id)));
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

function queueTextButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tmd-queue-text-button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  return button;
}

function dismissPersistentToast(message?: string): void {
  if (!message) return;
  for (const toast of document.querySelectorAll<HTMLElement>(".tmd-toast[data-persistent='true']")) {
    if (toast.dataset.message === message) toast.remove();
  }
}

function removeDownloadItem(mediaId: string): void {
  dismissPersistentToast(downloadItems.get(mediaId)?.detail);
  downloadItems.delete(mediaId);
  resetAttachmentState(mediaId);
  scheduleQueueRender();
  postStats();
}

function retryDownload(mediaId: string): void {
  const media = mediaById.get(mediaId);
  if (!media) {
    showToast("原消息媒体已失效，请重新滚动到该消息后再试", { persistent: true });
    return;
  }
  dismissPersistentToast(downloadItems.get(mediaId)?.detail);
  downloadItems.delete(mediaId);
  resetAttachmentState(mediaId);
  if (!enqueueMedia(media)) showToast("任务仍在结束处理中，请稍后重试");
}

function clearCompletedDownloads(): void {
  for (const [id, item] of downloadItems) {
    if (item.state === "success" || item.state === "cancelled") removeDownloadItem(id);
  }
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
  const aggregateSpeed = running.reduce((sum, item) => sum + item.speedBytesPerSecond, 0);

  const header = document.createElement("header");
  const headingWrap = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = running.length > 0 ? "下载中" : waiting.length > 0 ? "等待下载" : "下载队列";
  const summary = document.createElement("span");
  summary.textContent = totalBytes > 0
    ? `总进度：${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)} (${Math.round(writtenBytes / totalBytes * 100)}%)${aggregateSpeed > 0 ? ` · ${formatSpeed(aggregateSpeed)}` : ""}`
    : `${running.length} 个进行中 · ${waiting.length} 个等待`;
  headingWrap.append(heading, summary);
  const collapse = queueActionButton(queueCollapsed ? "展开下载队列" : "收起下载队列", COLLAPSE_ICON, () => {
    queueCollapsed = !queueCollapsed;
    scheduleQueueRender();
  });
  collapse.classList.add("tmd-queue-collapse");
  header.append(headingWrap, collapse);
  panel.appendChild(header);

  if (queueCollapsed) return;
  const toolbar = document.createElement("div");
  toolbar.className = "tmd-queue-toolbar";
  const pausable = running.filter((item) => item.state === "running" && item.canPause).map((item) => item.id);
  const paused = running.filter((item) => item.state === "paused").map((item) => item.id);
  const cancellable = [...running, ...waiting].map((item) => item.id);
  const completed = terminal.filter((item) => item.state === "success" || item.state === "cancelled");
  if (pausable.length > 0) toolbar.appendChild(queueTextButton("暂停全部", () => queue.pauseAll(pausable)));
  if (paused.length > 0) toolbar.appendChild(queueTextButton("继续全部", () => queue.resumeAll(paused)));
  if (cancellable.length > 0) toolbar.appendChild(queueTextButton("取消全部", () => queue.cancelAll(cancellable)));
  if (completed.length > 0) toolbar.appendChild(queueTextButton("清除完成", clearCompletedDownloads));
  if (toolbar.childElementCount > 0) panel.appendChild(toolbar);
  if (running.length > 0) panel.appendChild(queueSection("正在下载", running));
  if (waiting.length > 0) panel.appendChild(queueSection("等待中", waiting));
  if (terminal.length > 0) panel.appendChild(queueSection("最近状态", terminal));
}

function enqueueMedia(media: MediaDescriptor, batchTracker?: (state: QueueState) => void): boolean {
  const viewItem: DownloadViewItem = {
    id: media.id,
    fileName: buildFileName(media),
    thumbnailUrl: thumbnailUrl(media),
    state: "queued",
    written: 0,
    total: media.size ?? 0,
    speedBytesPerSecond: 0,
    meter: new TransferMeter(),
    canPause: true
  };
  const accepted = reserveMapEntry(downloadItems, media.id, viewItem, () => queue.enqueue({
      key: media.id,
      value: media,
      onState: (state, detail) => {
        setAttachmentState(media.id, state, detail);
        updateDownloadState(media.id, state, detail);
        batchTracker?.(state);
        postStats();
        if (state === "error" && detail) showToast(detail, { persistent: true });
      }
    }));
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
      const current = latest ? downloadItems.get(latest.id) : undefined;
      if (current?.state === "error") retryDownload(current.id);
      else if (latest && !enqueueMedia(latest)) showToast("这个文件已在下载队列中");
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
    const progress = new BatchProgress();
    const update = (state: QueueState) => {
      progress.record(state);
      const summary = progress.summary();
      button!.dataset.state = summary.state;
      button!.disabled = !summary.done;
      button!.querySelector("span")!.textContent = summary.label;
    };
    for (const media of snapshot) {
      if (enqueueMedia(media, update)) progress.accept();
    }
    if (progress.total === 0) showToast("这些文件已在下载队列中");
    else {
      button!.dataset.state = "running";
      button!.disabled = true;
      button!.querySelector("span")!.textContent = `下载中 0/${progress.total}`;
    }
  };
}

function processMessage(root: HTMLElement): void {
  if (!root.isConnected) return;
  const discovered = discoverMessageMedia(root);
  if (discovered.length === 0) return;
  const groupId = discovered[0]!.messageId;
  const previousGroupId = groupIdByRoot.get(root);
  if (previousGroupId && previousGroupId !== groupId) {
    const previousGroup = groups.get(previousGroupId);
    groups.delete(previousGroupId);
    previousGroup?.mediaIds.forEach((id) => {
      if (!downloadItems.has(id)) mediaById.delete(id);
    });
  }
  const previousIds = new Set(groups.get(groupId)?.mediaIds ?? []);
  const mediaIds: string[] = [];
  for (const media of discovered) {
    mediaById.set(media.id, media);
    mediaIds.push(media.id);
    previousIds.delete(media.id);
    decorateAttachment(media);
  }
  previousIds.forEach((id) => {
    if (!downloadItems.has(id)) mediaById.delete(id);
  });
  const group = { id: groupId, root, mediaIds };
  groups.set(groupId, group);
  groupIdByRoot.set(root, groupId);
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
  const retainedMediaIds = new Set(downloadItems.keys());
  for (const [groupId, group] of groups) {
    if (group.root.isConnected) {
      group.mediaIds.forEach((id) => retainedMediaIds.add(id));
    } else {
      groups.delete(groupId);
      groupIdByRoot.delete(group.root);
    }
  }
  for (const mediaId of mediaById.keys()) {
    if (!retainedMediaIds.has(mediaId)) mediaById.delete(mediaId);
  }
  postStats();
}

function postStats(): void {
  const items = [...downloadItems.values()];
  bridge.updatePageStats({
    mediaCount: mediaById.size,
    messageCount: groups.size,
    queueActive: queue.activeCount,
    queuePending: queue.queuedCount,
    queueErrors: items.filter((item) => item.state === "error").length,
    queueComplete: items.filter((item) => item.state === "success" || item.state === "cancelled").length
  });
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
  const accumulator = new ChunkAccumulator();
  let written = 0;
  const flush = async (chunk: Uint8Array<ArrayBuffer> | null): Promise<void> => {
    if (!chunk) return;
    if (control.isCancelled) throw new DOMException("下载已取消", "AbortError");
    await bridge.writeChunk(fileRequestId, chunk);
    written += chunk.byteLength;
    onProgress(written);
  };
  for (;;) {
    await control.waitIfPaused();
    const { done, value } = await withAbortableTimeout(
      reader.read(),
      STREAM_INACTIVITY_TIMEOUT_MS,
      control.signal,
      new DownloadError("媒体流 60 秒没有收到新数据，请检查 VPN 或网络后重试", "NETWORK_STALLED"),
      () => { void reader.cancel(); }
    );
    if (done) break;
    if (!value?.byteLength) continue;
    await flush(accumulator.push(value));
  }
  await flush(accumulator.flush());
  return written;
}

async function fetchIntoFile(
  media: MediaDescriptor,
  requestId: string,
  control: QueueControl,
  onProgress: (written: number, total: number) => void
): Promise<void> {
  if (/^(blob:|data:)/.test(media.url)) {
    let response: Response;
    try {
      response = await fetch(media.url, { signal: control.signal });
    } catch (error) {
      if (media.url.startsWith("blob:") && !isAbortError(error)) {
        throw new DownloadError("媒体地址已失效，请让该消息重新进入视口后重试", "STALE_MEDIA_URL", { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      const code = response.status >= 400 && response.status < 500 ? "HTTP_CLIENT" : "HTTP_SERVER";
      throw new DownloadError(`媒体请求失败：HTTP ${response.status}`, code);
    }
    const total = media.size ?? (Number(response.headers.get("Content-Length")) || 0);
    await streamResponse(response, requestId, control, (written) => onProgress(written, total));
    return;
  }

  let offset = 0;
  let total = media.size ?? 0;
  for (;;) {
    await control.waitIfPaused();
    const response = await fetch(media.url, { headers: { Range: `bytes=${offset}-` }, credentials: "include", signal: control.signal });
    const range = validateRangeResponse(offset, response.status, response.headers.get("Content-Range"));
    if (range) {
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
  if (isAbortError(error)) return false;
  return !(["DIRECTORY_MISSING", "DIRECTORY_PERMISSION", "DISK_FULL", "FILESYSTEM_UNAVAILABLE", "HTTP_CLIENT", "STALE_MEDIA_URL", "WRITER_CAPACITY"] as const).includes(
    errorCode(error) as "DIRECTORY_MISSING" | "DIRECTORY_PERMISSION" | "DISK_FULL" | "FILESYSTEM_UNAVAILABLE" | "HTTP_CLIENT" | "STALE_MEDIA_URL" | "WRITER_CAPACITY"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshMediaSource(media: MediaDescriptor): MediaDescriptor {
  const currentUrl = mediaElementUrl(media.element);
  if (!currentUrl || currentUrl === media.url) return media;
  const metadata = parseStreamMetadata(currentUrl);
  return {
    ...media,
    url: currentUrl,
    fileName: metadata?.fileName ?? media.fileName,
    mimeType: metadata?.mimeType ?? media.mimeType,
    size: metadata?.size ?? media.size
  };
}

async function downloadTelegramWithRetry(media: MediaDescriptor, control: QueueControl): Promise<{ blob: TelegramBlob | null; error?: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS.length; attempt += 1) {
    await control.waitIfPaused();
    if (attempt > 0) {
      const retryDetail = `Telegram 原生下载重试 ${attempt}/${TELEGRAM_RETRY_DELAYS.length}…`;
      updateDownloadState(media.id, "running", retryDetail);
      setAttachmentState(media.id, "running", retryDetail);
    }
    try {
      const blob = await downloadTelegramBlob(media, control.signal, (written, total) => {
        updateDownloadProgress(media.id, written, total, "Telegram 传输");
        if (total > 0) setAttachmentState(media.id, "running", formatProgress(written / total));
      });
      return { blob };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const normalized = normalizeDownloadError(error);
      lastError = normalized;
      if (attempt >= TELEGRAM_RETRY_DELAYS.length || !retryable(normalized)) break;
      await abortableSleep(TELEGRAM_RETRY_DELAYS[attempt]!, control.signal);
    }
  }
  return { blob: null, error: lastError };
}

async function downloadWithRetry(media: MediaDescriptor, control: QueueControl): Promise<void> {
  const status = await bridge.status();
  queue.setConcurrency(status.concurrency);
  if (!status.folderName) throw new Error("请点击扩展图标并选择下载目录");
  if (status.permission !== "granted") throw new Error("下载目录需要重新授权，请点击扩展图标后重新授权一次");

  let resolvedMedia = media;
  let telegramBlob: TelegramBlob | null = null;
  let telegramError: unknown;
  let dismissViewer: (() => void) | undefined;
  if (media.requiresViewer) {
    if (shouldWarnAboutLargeBlob(media.size) && !warnedLargeMedia.has(media.id)) {
      warnedLargeMedia.add(media.id);
      showToast("这个大视频会占用较多浏览器内存，请保持 Telegram 页面打开", { timeout: 8000 });
    }
    setDownloadPausable(media.id, false);
    updateDownloadState(media.id, "running", "正在读取 Telegram 原始视频…");
    setAttachmentState(media.id, "running", "正在读取 Telegram 原始视频…");
    await control.waitIfPaused();
    const telegramResult = await downloadTelegramWithRetry(media, control);
    telegramBlob = telegramResult.blob;
    telegramError = telegramResult.error;
    if (telegramBlob) {
      resolvedMedia = {
        ...media,
        requiresViewer: false,
        fileName: telegramBlob.fileName ?? media.fileName,
        mimeType: telegramBlob.mimeType ?? media.mimeType ?? "video/mp4",
        size: telegramBlob.size
      };
    } else {
      if (!viewerHintShown) {
        viewerHintShown = true;
        showToast("需要临时打开 Telegram 播放器读取视频，下载结束后会自动关闭", { timeout: 6500 });
      }
      updateDownloadState(media.id, "running", "正在打开视频…");
      setAttachmentState(media.id, "running", "正在打开视频…");
      let url: string;
      try {
        const revealed = await revealVideoSource(media, control.signal);
        url = revealed.url;
        dismissViewer = revealed.dismiss;
      } catch (viewerError) {
        if (telegramError) {
          throw new Error(`Telegram 原生下载失败：${errorMessage(telegramError)}；预览回退失败：${errorMessage(viewerError)}`);
        }
        throw viewerError;
      }
      const metadata = parseStreamMetadata(url);
      resolvedMedia = {
        ...media,
        url,
        requiresViewer: false,
        fileName: metadata?.fileName ?? media.fileName,
        mimeType: metadata?.mimeType ?? media.mimeType ?? "video/mp4",
        size: metadata?.size ?? media.size
      };
    }
    const item = downloadItems.get(media.id);
    if (item) {
      item.fileName = buildFileName(resolvedMedia);
      item.total = resolvedMedia.size ?? item.total;
      scheduleQueueRender();
    }
  }

  if (!telegramBlob) {
    resolvedMedia = refreshMediaSource(resolvedMedia);
  }
  const fileName = buildFileName(resolvedMedia);
  try {
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      await control.waitIfPaused();
      if (!telegramBlob) resolvedMedia = refreshMediaSource(resolvedMedia);
      const requestId = crypto.randomUUID();
      try {
        await bridge.startFile(requestId, fileName, resolvedMedia.mimeType);
        const progress = (written: number, total: number): void => {
          updateDownloadProgress(media.id, written, total, telegramBlob ? "本地写入" : "网络传输");
          if (total > 0) setAttachmentState(media.id, "running", formatProgress(written / total));
        };
        if (telegramBlob) {
          if (shouldWarnAboutLargeBlob(telegramBlob.size) && !warnedLargeMedia.has(media.id)) {
            warnedLargeMedia.add(media.id);
            showToast("这个大视频正在使用浏览器内存写入，请保持 Telegram 页面打开", { timeout: 8000 });
          }
          const response = new Response(telegramBlob.blob);
          await streamResponse(response, requestId, control, (written) => progress(written, telegramBlob!.size));
        } else {
          await fetchIntoFile(resolvedMedia, requestId, control, progress);
        }
        await bridge.closeFile(requestId);
        return;
      } catch (error) {
        const normalized = normalizeDownloadError(error);
        await bridge.abortFile(requestId);
        if (attempt >= RETRY_DELAYS.length || !retryable(normalized)) throw normalized;
        await abortableSleep(RETRY_DELAYS[attempt]!, control.signal);
      }
    }
  } finally {
    dismissViewer?.();
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
