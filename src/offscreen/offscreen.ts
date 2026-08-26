import { buildFileName, sanitizeFileName } from "../core/media";
import { getDirectoryHandle, getDestinationStatus, queryDirectoryPermission } from "../shared/destination";
import { BridgeRequest, BridgeResponse, WRITER_CHANNEL_NAME } from "../shared/protocol";
import { getSettings } from "../shared/settings";

const MAX_OPEN_FILES = 5;

type OpenFile = {
  writable: FileSystemWritableFileStream;
  bytesWritten: number;
};

const openFiles = new Map<string, OpenFile>();
const writerChannel = new BroadcastChannel(WRITER_CHANNEL_NAME);

function splitFileName(fileName: string): { stem: string; extension: string } {
  const index = fileName.lastIndexOf(".");
  if (index <= 0) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, index), extension: fileName.slice(index) };
}

async function createUniqueFile(directory: FileSystemDirectoryHandle, requestedName: string): Promise<{ fileName: string; handle: FileSystemFileHandle }> {
  const { stem, extension } = splitFileName(requestedName);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const fileName = suffix === 0 ? requestedName : `${stem} (${suffix})${extension}`;
    try {
      await directory.getFileHandle(fileName);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return { fileName, handle: await directory.getFileHandle(fileName, { create: true }) };
      }
      throw error;
    }
  }
  throw new Error("无法生成不重复的下载文件名");
}

async function statusPayload(): Promise<Record<string, unknown>> {
  const [destination, settings] = await Promise.all([getDestinationStatus(), getSettings()]);
  return { folderName: destination.name, permission: destination.permission, concurrency: settings.concurrency };
}

async function startFile(requestId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (openFiles.size >= MAX_OPEN_FILES) throw new Error("已达到最大并发写入数量");
  const directory = await getDirectoryHandle();
  if (!directory) throw new Error("请先在扩展设置中选择下载目录");
  const permission = await queryDirectoryPermission(directory);
  if (permission !== "granted") throw new Error("下载目录需要重新授权，请点击扩展图标后重新授权一次");
  const rawName = typeof payload.fileName === "string" ? payload.fileName : buildFileName({ id: requestId, kind: "video" });
  const requestedName = sanitizeFileName(rawName);
  const { fileName, handle } = await createUniqueFile(directory, requestedName);
  const writable = await handle.createWritable({ keepExistingData: false });
  openFiles.set(requestId, { writable, bytesWritten: 0 });
  return { fileName };
}

async function writeChunk(requestId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const file = openFiles.get(requestId);
  if (!file) throw new Error("下载文件句柄不存在或已关闭");
  if (!(payload.chunk instanceof ArrayBuffer)) throw new Error("下载数据块格式无效");
  const chunk = new Uint8Array(payload.chunk);
  await file.writable.write(chunk);
  file.bytesWritten += chunk.byteLength;
  return { bytesWritten: file.bytesWritten };
}

async function closeFile(requestId: string): Promise<Record<string, unknown>> {
  const file = openFiles.get(requestId);
  if (!file) throw new Error("下载文件句柄不存在或已关闭");
  await file.writable.close();
  openFiles.delete(requestId);
  return { bytesWritten: file.bytesWritten };
}

async function abortFile(requestId: string): Promise<Record<string, unknown>> {
  const file = openFiles.get(requestId);
  if (!file) return { aborted: false };
  await file.writable.abort().catch(() => undefined);
  openFiles.delete(requestId);
  return { aborted: true };
}

async function handleRequest(request: BridgeRequest): Promise<Record<string, unknown>> {
  const payload = request.payload ?? {};
  switch (request.type) {
    case "status": return statusPayload();
    case "file:start": return startFile(request.requestId, payload);
    case "file:chunk": return writeChunk(request.requestId, payload);
    case "file:close": return closeFile(request.requestId);
    case "file:abort": return abortFile(request.requestId);
    default: throw new Error(`未知写入请求：${request.type}`);
  }
}

writerChannel.addEventListener("message", (event: MessageEvent<BridgeRequest>) => {
  const request = event.data;
  if (request?.source !== "telegram-media-downloader" || typeof request.type !== "string" || typeof request.requestId !== "string") return;
  void handleRequest(request)
    .then((payload) => writerChannel.postMessage({
      source: "telegram-media-downloader-bridge",
      type: `${request.type}:response`,
      requestId: request.requestId,
      ok: true,
      payload
    } satisfies BridgeResponse))
    .catch((error) => writerChannel.postMessage({
      source: "telegram-media-downloader-bridge",
      type: `${request.type}:response`,
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies BridgeResponse));
});
