import {
  WRITER_CHANNEL_NAME,
  WriterControlRequest,
  WriterControlResponse,
  WriterLifecycleRequest,
  WriterLifecycleResponse
} from "./protocol";

type EnsureWriterResponse = {
  ok?: boolean;
  error?: string;
};

export async function ensureWriterDocument(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await chrome.runtime.sendMessage({ type: "ensure-offscreen-writer" }) as EnsureWriterResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "无法启动扩展写入器");
}

type WriterDirectoryStatus = {
  folderName: string | null;
  permission: PermissionState | "missing";
};

async function writerRequest(
  type: WriterControlRequest["type"],
  handle?: FileSystemDirectoryHandle
): Promise<WriterDirectoryStatus> {
  const channel = new BroadcastChannel(WRITER_CHANNEL_NAME);
  const ownerId = crypto.randomUUID();
  try {
    await ensureWriterDocument();
  } catch (error) {
    channel.close();
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    let onReady: (event: MessageEvent<WriterLifecycleResponse>) => void;
    const ping = (): void => channel.postMessage({
      source: "telegram-media-downloader-bridge-lifecycle",
      type: "writer:ping",
      ownerId
    } satisfies WriterLifecycleRequest);
    const interval = window.setInterval(ping, 100);
    const timeout = window.setTimeout(() => {
      channel.removeEventListener("message", onReady);
      window.clearInterval(interval);
      channel.close();
      reject(new Error("扩展写入器未能就绪"));
    }, 5_000);
    onReady = (event: MessageEvent<WriterLifecycleResponse>): void => {
      const response = event.data;
      if (response?.source !== "telegram-media-downloader-writer" || response.type !== "writer:ready" || response.ownerId !== ownerId) return;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      channel.removeEventListener("message", onReady);
      resolve();
    };
    channel.addEventListener("message", onReady);
    ping();
  });
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      channel.close();
      reject(new Error("扩展写入器目录同步超时"));
    }, 5_000);
    channel.addEventListener("message", (event: MessageEvent<WriterControlResponse>) => {
      const response = event.data;
      if (response?.source !== "telegram-media-downloader-writer" || response.requestId !== requestId) return;
      window.clearTimeout(timeout);
      channel.close();
      if (response.ok && response.payload) resolve(response.payload);
      else reject(new Error(response.error ?? "扩展写入器目录同步失败"));
    });
    channel.postMessage({
      source: "telegram-media-downloader-popup",
      type,
      requestId,
      handle
    } satisfies WriterControlRequest);
  });
}

export async function activateWriterDirectory(handle: FileSystemDirectoryHandle): Promise<WriterDirectoryStatus> {
  return writerRequest("directory:activate", handle);
}

export async function getWriterDirectoryStatus(): Promise<WriterDirectoryStatus> {
  return writerRequest("directory:status");
}
