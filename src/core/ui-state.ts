import type { QueueState } from "./queue";

export type PageStats = {
  mediaCount: number;
  messageCount: number;
  queueActive: number;
  queuePending: number;
  queueErrors: number;
  queueComplete: number;
};

export type AttachmentPresentation = {
  ariaLabel: string;
  title: string;
  disabled: boolean;
  content: "download" | "success" | "paused" | "queued" | "progress" | "error";
  text?: string;
};

export function attachmentPresentation(state: QueueState, detail?: string): AttachmentPresentation {
  if (state === "queued") return { ariaLabel: "等待下载", title: "已加入下载队列", disabled: true, content: "queued", text: "等待" };
  if (state === "running") {
    const progress = detail?.endsWith("%") ? detail : undefined;
    return {
      ariaLabel: progress ? `正在下载 ${progress}` : detail ?? "正在下载",
      title: detail ?? "正在下载",
      disabled: true,
      content: progress ? "progress" : "download",
      text: progress
    };
  }
  if (state === "paused") return { ariaLabel: "下载已暂停", title: "下载已暂停", disabled: true, content: "paused", text: "Ⅱ" };
  if (state === "success") return { ariaLabel: "下载完成", title: "下载完成", disabled: false, content: "success" };
  if (state === "error") {
    const retryMessage = `下载失败，点击重试${detail ? `：${detail}` : ""}`;
    return { ariaLabel: retryMessage, title: retryMessage, disabled: false, content: "error", text: "!" };
  }
  if (state === "cancelled") return { ariaLabel: "下载已取消，点击重新下载", title: "下载已取消，点击重新下载", disabled: false, content: "download" };
  return { ariaLabel: "下载这个媒体", title: "下载这个媒体", disabled: false, content: "download" };
}

export function badgePresentation(stats: PageStats): { text: string; color: string; title: string } {
  if (stats.queueErrors > 0) return { text: "!", color: "#d14b4b", title: `${stats.queueErrors} 个下载失败` };
  const active = stats.queueActive + stats.queuePending;
  if (active > 0) return { text: active > 99 ? "99+" : String(active), color: "#0a84ff", title: `${stats.queueActive} 个下载中，${stats.queuePending} 个等待` };
  return { text: "", color: "#0a84ff", title: "Telegram Media Downloader" };
}

export const LARGE_BLOB_WARNING_BYTES = 512 * 1024 * 1024;

export function shouldWarnAboutLargeBlob(size?: number): boolean {
  return typeof size === "number" && Number.isFinite(size) && size >= LARGE_BLOB_WARNING_BYTES;
}
