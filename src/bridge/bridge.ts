import { buildFileName, sanitizeFileName } from "../core/media";
import { getDirectoryHandle, getDestinationStatus, queryDirectoryPermission } from "../shared/destination";
import { BridgeRequest, BridgeResponse } from "../shared/protocol";
import { getSettings } from "../shared/settings";

const ALLOWED_ORIGINS = new Set([
  "https://web.telegram.org",
  "https://webk.telegram.org",
  "https://webz.telegram.org"
]);
const MAX_OPEN_FILES = 5;

type OpenFile = {
  writable: FileSystemWritableFileStream;
  bytesWritten: number;
};

const openFiles = new Map<string, OpenFile>();

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

function respond(event: MessageEvent, response: BridgeResponse): void {
  (event.source as WindowProxy | null)?.postMessage(response, { targetOrigin: event.origin });
}

async function statusPayload() {
  const [destination, settings] = await Promise.all([getDestinationStatus(), getSettings()]);
  return { folderName: destination.name, permission: destination.permission, concurrency: settings.concurrency };
}

async function startFile(requestId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (openFiles.size >= MAX_OPEN_FILES) throw new Error("已达到最大并发写入数量");
  const directory = await getDirectoryHandle();
  if (!directory) throw new Error("请先在扩展设置中选择下载目录");
  const permission = await queryDirectoryPermission(directory);
  if (permission !== "granted") throw new Error("下载目录需要重新授权");
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

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || !ALLOWED_ORIGINS.has(event.origin)) return;
  const request = event.data as BridgeRequest;
  if (request?.source !== "telegram-media-downloader" || typeof request.type !== "string" || typeof request.requestId !== "string") return;

  void (async () => {
    try {
      const payload = request.payload ?? {};
      let result: Record<string, unknown>;
      switch (request.type) {
        case "status": result = await statusPayload(); break;
        case "file:start": result = await startFile(request.requestId, payload); break;
        case "file:chunk": result = await writeChunk(request.requestId, payload); break;
        case "file:close": result = await closeFile(request.requestId); break;
        case "file:abort": result = await abortFile(request.requestId); break;
        default: throw new Error(`未知桥接请求：${request.type}`);
      }
      respond(event, {
        source: "telegram-media-downloader-bridge",
        type: `${request.type}:response`,
        requestId: request.requestId,
        ok: true,
        payload: result
      });
    } catch (error) {
      respond(event, {
        source: "telegram-media-downloader-bridge",
        type: `${request.type}:response`,
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
});

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.concurrency) return;
    void statusPayload().then((payload) => {
      window.parent.postMessage({
        source: "telegram-media-downloader-bridge",
        type: "settings:changed",
        payload
      }, "*");
    });
  });
}

window.parent.postMessage({ source: "telegram-media-downloader-bridge", type: "ready" }, "*");
