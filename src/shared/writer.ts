import { WRITER_CHANNEL_NAME, WriterControlRequest, WriterControlResponse } from "./protocol";

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
  await ensureWriterDocument();
  const channel = new BroadcastChannel(WRITER_CHANNEL_NAME);
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
