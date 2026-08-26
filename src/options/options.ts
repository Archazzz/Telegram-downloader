import { chooseDirectory, getDestinationStatus, getDirectoryHandle, requestDirectoryPermission } from "../shared/destination";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY, getSettings, saveSettings } from "../shared/settings";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少界面元素：${id}`);
  return found as T;
}

let selectedConcurrency = DEFAULT_CONCURRENCY;

function renderConcurrency(): void {
  const container = element("concurrency-options");
  container.replaceChildren();
  for (let value = MIN_CONCURRENCY; value <= MAX_CONCURRENCY; value += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `segment${value === selectedConcurrency ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(value === selectedConcurrency));
    button.innerHTML = `<strong>${value}</strong><span>个任务</span>`;
    button.addEventListener("click", () => {
      selectedConcurrency = value;
      renderConcurrency();
    });
    container.appendChild(button);
  }
}

async function renderDestination(): Promise<void> {
  const status = await getDestinationStatus();
  element("folder-name").textContent = status.name ?? "尚未选择文件夹";
  element("folder-permission").textContent = status.permission === "granted" ? "已授权，可直接保存" : status.permission === "prompt" ? "点击按钮重新授权" : "需要选择并授权目录";
  const button = element<HTMLButtonElement>("choose-folder");
  button.textContent = status.name ? (status.permission === "granted" ? "更换目录" : "重新授权") : "选择下载目录";
}

async function handleChooseDirectory(): Promise<void> {
  const status = await getDestinationStatus();
  if (status.name && status.permission === "prompt") {
    const handle = await getDirectoryHandle();
    if (handle && await requestDirectoryPermission(handle) === "granted") {
      await renderDestination();
      return;
    }
  }
  await chooseDirectory();
  await renderDestination();
}

document.addEventListener("DOMContentLoaded", () => {
  void (async () => {
    const settings = await getSettings();
    selectedConcurrency = settings.concurrency;
    renderConcurrency();
    await renderDestination();
  })();

  element<HTMLButtonElement>("choose-folder").addEventListener("click", async () => {
    try {
      await handleChooseDirectory();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      element("folder-permission").textContent = error instanceof Error ? error.message : "选择目录失败";
    }
  });

  element<HTMLButtonElement>("save-settings").addEventListener("click", async () => {
    const status = element("save-status");
    await saveSettings({ concurrency: selectedConcurrency });
    status.textContent = `已保存：并发 ${selectedConcurrency}`;
    window.setTimeout(() => { status.textContent = ""; }, 2500);
  });
});

