import { authorizeDirectory, chooseDirectory, getDestinationStatus } from "../shared/destination";
import { getSettings, MAX_CONCURRENCY, MIN_CONCURRENCY, saveSettings } from "../shared/settings";
import { activateWriterDirectory, getWriterDirectoryStatus } from "../shared/writer";

type PageStats = { mediaCount: number; messageCount: number; queueActive: number; queuePending: number };
const RESPONSIBILITY_KEY = "responsibilityAccepted";

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
    prompt: "需要重新授权",
    denied: "授权已被拒绝",
    unsupported: "当前浏览器不支持目录写入",
    missing: "请选择媒体保存位置"
  } as const;
  element("folder-status").textContent = labels[status.permission];
  element<HTMLButtonElement>("choose-folder").textContent = status.permission === "missing" ? "选择" : status.permission === "prompt" ? "授权" : "更换";
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
  if (!stats) return;
  element("media-count").textContent = `已发现 ${stats.mediaCount} 个媒体`;
  element("media-detail").textContent = `${stats.messageCount} 条媒体消息 · ${stats.queueActive} 下载中 · ${stats.queuePending} 等待`;
  document.querySelector(".live-dot")?.classList.add("is-connected");
}

async function renderResponsibilityNotice(): Promise<void> {
  const notice = element<HTMLElement>("responsibility-notice");
  const stored = await chrome.storage.local.get(RESPONSIBILITY_KEY) as Record<string, unknown>;
  notice.hidden = stored[RESPONSIBILITY_KEY] === true;
}

document.addEventListener("DOMContentLoaded", () => {
  void Promise.all([renderDestination(), renderSettings(), renderStats(), renderResponsibilityNotice()]);
  element<HTMLButtonElement>("accept-responsibility").addEventListener("click", async () => {
    await chrome.storage.local.set({ [RESPONSIBILITY_KEY]: true });
    element<HTMLElement>("responsibility-notice").hidden = true;
  });
  element<HTMLButtonElement>("choose-folder").addEventListener("click", async () => {
    try {
      const status = await getDestinationStatus();
      const handle = status.permission === "prompt" ? await authorizeDirectory() : await chooseDirectory();
      const writerStatus = await activateWriterDirectory(handle);
      if (writerStatus.permission !== "granted") throw new Error("目录已选择，但写入器未获得权限，请重新授权一次");
      await renderDestination();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      element("folder-status").textContent = error instanceof Error ? error.message : "选择目录失败";
    }
  });
});
