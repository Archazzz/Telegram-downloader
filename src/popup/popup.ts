import { chooseDirectory, getDestinationStatus } from "../shared/destination";
import { getSettings } from "../shared/settings";

type PageStats = { mediaCount: number; messageCount: number; queueActive: number; queuePending: number };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少界面元素：${id}`);
  return found as T;
}

async function renderDestination(): Promise<void> {
  const status = await getDestinationStatus();
  element("folder-name").textContent = status.name ?? "尚未选择文件夹";
  const label = status.permission === "granted" ? "已授权，可直接保存" : status.permission === "prompt" ? "需要重新授权" : "请选择媒体保存位置";
  element("folder-status").textContent = label;
}

async function renderSettings(): Promise<void> {
  const settings = await getSettings();
  element("concurrency-value").textContent = `${settings.concurrency} 个任务`;
}

async function renderStats(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await chrome.runtime.sendMessage({ type: "get-active-stats" }) as { stats?: PageStats | null };
  const stats = response.stats;
  if (!stats) return;
  element("media-count").textContent = `已发现 ${stats.mediaCount} 个媒体`;
  element("media-detail").textContent = `${stats.messageCount} 条媒体消息 · ${stats.queueActive} 下载中 · ${stats.queuePending} 排队`;
}

function openOptions(): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  void chrome.runtime.sendMessage({ type: "open-options" });
}

document.addEventListener("DOMContentLoaded", () => {
  void Promise.all([renderDestination(), renderSettings(), renderStats()]);
  element<HTMLButtonElement>("choose-folder").addEventListener("click", async () => {
    try {
      await chooseDirectory();
      await renderDestination();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      element("folder-status").textContent = error instanceof Error ? error.message : "选择目录失败";
    }
  });
  for (const id of ["open-settings", "open-settings-icon", "open-settings-concurrency"]) {
    element<HTMLButtonElement>(id).addEventListener("click", openOptions);
  }
});
