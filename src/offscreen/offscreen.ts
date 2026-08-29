import { DownloadError, errorCode, normalizeDownloadError } from "../core/errors";
import { FileStore } from "../core/file-store";
import { buildFileName } from "../core/media";
import { getDirectoryHandle, queryDirectoryPermission } from "../shared/destination";
import {
  BridgeRequest,
  BridgeResponse,
  WRITER_CHANNEL_NAME,
  WriterControlRequest,
  WriterControlResponse,
  WriterLifecycleRequest,
  WriterLifecycleResponse
} from "../shared/protocol";
import { getSettings } from "../shared/settings";

const fileStore = new FileStore(25);
const writerChannel = new BroadcastChannel(WRITER_CHANNEL_NAME);
let activeDirectory: FileSystemDirectoryHandle | null = null;
const STALE_FILE_LEASE_MS = 10 * 60_000;

async function directoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!activeDirectory) activeDirectory = await getDirectoryHandle();
  return activeDirectory;
}

async function statusPayload(): Promise<Record<string, unknown>> {
  const [directory, settings] = await Promise.all([directoryHandle(), getSettings()]);
  const permission = directory ? await queryDirectoryPermission(directory) : "missing";
  return { folderName: directory?.name ?? null, permission, concurrency: settings.concurrency };
}

async function startFile(requestId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const directory = await directoryHandle();
  if (!directory) throw new DownloadError("请先在扩展弹窗中选择下载目录", "DIRECTORY_MISSING");
  const permission = await queryDirectoryPermission(directory);
  if (permission !== "granted") throw new DownloadError("下载目录需要重新授权，请点击扩展图标后重新授权一次", "DIRECTORY_PERMISSION");
  const rawName = typeof payload.fileName === "string" ? payload.fileName : buildFileName({ id: requestId, kind: "video" });
  const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : undefined;
  const fileName = await fileStore.start(directory, requestId, rawName, payload.replaceEmpty === true, ownerId);
  return { fileName };
}

async function writeChunk(requestId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!(payload.chunk instanceof ArrayBuffer)) throw new Error("下载数据块格式无效");
  const chunk = new Uint8Array(payload.chunk);
  return { bytesWritten: await fileStore.write(requestId, chunk) };
}

async function abortFile(requestId: string): Promise<Record<string, unknown>> {
  return { aborted: await fileStore.abort(requestId) };
}

async function handleRequest(request: BridgeRequest): Promise<Record<string, unknown>> {
  const payload = request.payload ?? {};
  switch (request.type) {
    case "status": return statusPayload();
    case "file:start": return startFile(request.requestId, payload);
    case "file:chunk": return writeChunk(request.requestId, payload);
    case "file:close": {
      const expectedBytes = typeof payload.expectedBytes === "number" ? payload.expectedBytes : undefined;
      return { bytesWritten: await fileStore.close(request.requestId, expectedBytes) };
    }
    case "file:abort": return abortFile(request.requestId);
    default: throw new Error(`未知写入请求：${request.type}`);
  }
}

writerChannel.addEventListener("message", (event: MessageEvent<BridgeRequest>) => {
  const request = event.data as BridgeRequest | WriterControlRequest | WriterLifecycleRequest;
  if (request?.source === "telegram-media-downloader-bridge-lifecycle") {
    if (request.type === "writer:ping") {
      writerChannel.postMessage({
        source: "telegram-media-downloader-writer",
        type: "writer:ready",
        ownerId: request.ownerId
      } satisfies WriterLifecycleResponse);
    } else if (request.type === "writer:heartbeat") {
      fileStore.touchOwner(request.ownerId);
    } else if (request.type === "writer:disconnect") {
      void fileStore.abortOwner(request.ownerId);
    }
    return;
  }
  if (request?.source === "telegram-media-downloader-popup") {
    const respond = (response: WriterControlResponse): void => writerChannel.postMessage(response);
    if (request.type === "directory:activate" && request.handle?.kind === "directory") {
      activeDirectory = request.handle;
    }
    if (request.type !== "directory:activate" && request.type !== "directory:status") return;
    void directoryHandle()
      .then(async (directory) => respond({
        source: "telegram-media-downloader-writer",
        type: `${request.type}:response`,
        requestId: request.requestId,
        ok: true,
        payload: {
          folderName: directory?.name ?? null,
          permission: directory ? await queryDirectoryPermission(directory) : "missing"
        }
      }))
      .catch((error) => {
        const normalized = normalizeDownloadError(error);
        respond({
          source: "telegram-media-downloader-writer",
          type: `${request.type}:response`,
          requestId: request.requestId,
          ok: false,
          error: normalized.message
        });
      });
    return;
  }
  if (request?.source !== "telegram-media-downloader" || typeof request.type !== "string" || typeof request.requestId !== "string") return;
  void handleRequest(request)
    .then((payload) => writerChannel.postMessage({
      source: "telegram-media-downloader-bridge",
      type: `${request.type}:response`,
      requestId: request.requestId,
      ok: true,
      payload
    } satisfies BridgeResponse))
    .catch((error) => {
      const normalized = normalizeDownloadError(error);
      writerChannel.postMessage({
        source: "telegram-media-downloader-bridge",
        type: `${request.type}:response`,
        requestId: request.requestId,
        ok: false,
        error: normalized.message,
        errorCode: errorCode(normalized)
      } satisfies BridgeResponse);
    });
});

writerChannel.postMessage({
  source: "telegram-media-downloader-writer",
  type: "writer:ready"
} satisfies WriterLifecycleResponse);

window.setInterval(() => { void fileStore.reapStale(STALE_FILE_LEASE_MS); }, 60_000);
