import { authorizeDirectory, chooseDirectory, getDestinationStatus } from "../shared/destination";
import { normalizeDownloadError } from "../core/errors";
import { PageStats } from "../core/ui-state";
import { getSettings, MAX_CONCURRENCY, MIN_CONCURRENCY, saveSettings } from "../shared/settings";
import { activateWriterDirectory, getWriterDirectoryStatus } from "../shared/writer";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少界面元素：${id}`);
  return found as T;
}

async function renderDestination(): Promise<void> {
  const storedStatus = await getDestinationStatus();
  const writerStatus = await getWriterDirectoryStatus().catch(() => null);
  const status = writerStatus?.folderName === storedStatus.name && writerStatus.permission === "granted"
    ? { name: writerStatus.folderName, permission: writerStatus.permission }
    : storedStatus;
  element("folder-name").textContent = status.name ?? "尚未选择文件夹";
  const labels = {
    granted: "已授权，可直接保存",
    prompt: "需要授权后才能写入",
    denied: "目录访问已关闭，请重新选择",
    unsupported: "当前浏览器不支持目录写入",
    missing: "请选择媒体保存位置"
  } as const;
  element("folder-status").textContent = labels[status.permission];
  element<HTMLButtonElement>("choose-folder").textContent = status.permission === "missing" ? "选择" : status.permission === "prompt" ? "授权" : status.permission === "denied" ? "重新选择" : "更换";
}

async function selectConcurrency(value: number): Promise<void> {
  await saveSettings({ concurrency: value });
  document.querySelectorAll<HTMLButtonElement>(".segment-button").forEach((button) => {
    const selected = Number(button.dataset.value) === value;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function renderSettings(): Promise<void> {
  const settings = await getSettings();
  const container = element("concurrency-options");
  container.replaceChildren();
  for (let value = MIN_CONCURRENCY; value <= MAX_CONCURRENCY; value += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-button";
    button.dataset.value = String(value);
    button.textContent = String(value);
    button.setAttribute("aria-label", `同时下载 ${value} 个任务`);
    button.addEventListener("click", () => void selectConcurrency(value));
    container.append(button);
  }
  await selectConcurrency(settings.concurrency);
}

async function renderStats(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await chrome.runtime.sendMessage({ type: "get-active-stats" }) as { stats?: PageStats | null } | undefined;
  const stats = response?.stats;
  if (!stats) {
    element("media-count").textContent = "未连接 Telegram 页面";
    element("media-detail").textContent = "打开 Telegram Web 后自动检索";
    document.querySelector(".live-dot")?.classList.remove("is-connected");
    return;
  }
  element("media-count").textContent = `已发现 ${stats.mediaCount} 个媒体`;
  element("media-detail").textContent = `${stats.messageCount} 条媒体消息 · ${stats.queueActive} 下载中 · ${stats.queuePending} 等待${stats.queueErrors > 0 ? ` · ${stats.queueErrors} 失败` : ""}`;
  document.querySelector(".live-dot")?.classList.add("is-connected");
}

function renderDestinationFallback(error: unknown): void {
  element("folder-name").textContent = "下载目录暂不可用";
  element("folder-status").textContent = normalizeDownloadError(error).message;
  element<HTMLButtonElement>("choose-folder").textContent = "重试";
}

function renderSettingsFallback(): void {
  const container = element("concurrency-options");
  container.replaceChildren();
  container.textContent = "并发设置暂不可用";
}

function renderStatsFallback(): void {
  element("media-count").textContent = "页面状态暂不可用";
  element("media-detail").textContent = "请保持 Telegram 页面打开后重试";
  document.querySelector(".live-dot")?.classList.remove("is-connected");
}

export function initPopup(): void {
  void renderDestination().catch(renderDestinationFallback);
  void renderSettings().catch(renderSettingsFallback);
  void renderStats().catch(renderStatsFallback);
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const typed = message as { type?: string };
    if (typed.type === "page-stats-updated") void renderStats().catch(renderStatsFallback);
    return false;
  });
  element<HTMLButtonElement>("choose-folder").addEventListener("click", async () => {
    const button = element<HTMLButtonElement>("choose-folder");
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = "处理中…";
    try {
      const status = await getDestinationStatus();
      const handle = status.permission === "prompt" ? await authorizeDirectory() : await chooseDirectory();
      const writerStatus = await activateWriterDirectory(handle);
      if (writerStatus.permission !== "granted") throw new Error("目录已选择，但写入器未获得权限，请重新授权一次");
      await renderDestination();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      element("folder-status").textContent = normalizeDownloadError(error).message;
      window.setTimeout(() => void renderDestination(), 4200);
    } finally {
      button.disabled = false;
      if (button.textContent === "处理中…") button.textContent = previousLabel;
    }
  });
}

document.addEventListener("DOMContentLoaded", initPopup, { once: true });
