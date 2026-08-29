import { DownloadError } from "./errors";
import { sanitizeFileName } from "./media";

type OpenFile = {
  directory: FileSystemDirectoryHandle;
  fileName: string;
  writable: FileSystemWritableFileStream;
  bytesWritten: number;
  ownerId?: string;
  lastTouched: number;
  closing?: Promise<number>;
};

type ClosedFile = { bytesWritten: number; fileName: string };

function splitFileName(fileName: string): { stem: string; extension: string } {
  const index = fileName.lastIndexOf(".");
  if (index <= 0) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, index), extension: fileName.slice(index) };
}

async function createUniqueFile(
  directory: FileSystemDirectoryHandle,
  requestedName: string,
  replaceEmpty = false
): Promise<{ fileName: string; handle: FileSystemFileHandle }> {
  const { stem, extension } = splitFileName(requestedName);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const fileName = suffix === 0 ? requestedName : `${stem} (${suffix})${extension}`;
    try {
      const existing = await directory.getFileHandle(fileName);
      if (suffix === 0 && replaceEmpty && (await existing.getFile()).size === 0) {
        await directory.removeEntry(fileName);
        return { fileName, handle: await directory.getFileHandle(fileName, { create: true }) };
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return { fileName, handle: await directory.getFileHandle(fileName, { create: true }) };
      }
      throw error;
    }
  }
  throw new Error("无法生成不重复的下载文件名");
}

export class FileStore {
  private readonly openFiles = new Map<string, OpenFile>();
  private readonly closedFiles = new Map<string, ClosedFile>();

  constructor(private readonly maxOpenFiles = 25) {}

  get openCount(): number {
    return this.openFiles.size;
  }

  async start(
    directory: FileSystemDirectoryHandle,
    requestId: string,
    rawName: string,
    replaceEmpty = false,
    ownerId?: string
  ): Promise<string> {
    const open = this.openFiles.get(requestId);
    if (open) {
      open.lastTouched = Date.now();
      return open.fileName;
    }
    const closed = this.closedFiles.get(requestId);
    if (closed) return closed.fileName;
    if (this.openFiles.size >= this.maxOpenFiles) {
      throw new DownloadError("已达到扩展级最大并发写入数量，请减少同时打开的 Telegram 标签页", "WRITER_CAPACITY");
    }
    const requestedName = sanitizeFileName(rawName);
    const { fileName, handle } = await createUniqueFile(directory, requestedName, replaceEmpty);
    try {
      const writable = await handle.createWritable({ keepExistingData: false });
      this.openFiles.set(requestId, { directory, fileName, writable, bytesWritten: 0, ownerId, lastTouched: Date.now() });
      return fileName;
    } catch (error) {
      await directory.removeEntry(fileName).catch(() => undefined);
      throw error;
    }
  }

  async write(requestId: string, chunk: Uint8Array<ArrayBuffer>): Promise<number> {
    const file = this.openFiles.get(requestId);
    if (!file) throw new Error("下载文件句柄不存在或已关闭");
    if (file.closing) throw new Error("下载文件正在完成写入，不能继续追加数据");
    await file.writable.write(chunk);
    file.bytesWritten += chunk.byteLength;
    file.lastTouched = Date.now();
    return file.bytesWritten;
  }

  async close(requestId: string, expectedBytes?: number): Promise<number> {
    const closed = this.closedFiles.get(requestId);
    if (closed) return closed.bytesWritten;
    const file = this.openFiles.get(requestId);
    if (!file) throw new Error("下载文件句柄不存在或已关闭");
    if (file.closing) return file.closing;
    file.closing = (async () => {
      try {
        if (expectedBytes !== undefined && expectedBytes > 0 && file.bytesWritten !== expectedBytes) {
          throw new DownloadError(
            `文件写入不完整：预期 ${expectedBytes} 字节，实际 ${file.bytesWritten} 字节`,
            "WRITE_INTEGRITY"
          );
        }
        await file.writable.close();
        this.openFiles.delete(requestId);
        this.rememberClosed(requestId, { bytesWritten: file.bytesWritten, fileName: file.fileName });
        return file.bytesWritten;
      } catch (error) {
        await this.discard(requestId, file);
        throw error;
      }
    })();
    return file.closing;
  }

  async abort(requestId: string): Promise<boolean> {
    const file = this.openFiles.get(requestId);
    if (!file) return false;
    await this.discard(requestId, file);
    return true;
  }

  touchOwner(ownerId: string): void {
    const now = Date.now();
    for (const file of this.openFiles.values()) {
      if (file.ownerId === ownerId) file.lastTouched = now;
    }
  }

  async abortOwner(ownerId: string): Promise<number> {
    const requestIds = [...this.openFiles]
      .filter(([, file]) => file.ownerId === ownerId && !file.closing)
      .map(([requestId]) => requestId);
    await Promise.all(requestIds.map((requestId) => this.abort(requestId)));
    return requestIds.length;
  }

  async reapStale(maxIdleMs: number, now = Date.now()): Promise<number> {
    const requestIds = [...this.openFiles]
      .filter(([, file]) => !file.closing && now - file.lastTouched >= maxIdleMs)
      .map(([requestId]) => requestId);
    await Promise.all(requestIds.map((requestId) => this.abort(requestId)));
    return requestIds.length;
  }

  private rememberClosed(requestId: string, result: ClosedFile): void {
    this.closedFiles.set(requestId, result);
    while (this.closedFiles.size > 100) {
      const oldest = this.closedFiles.keys().next();
      if (oldest.done) break;
      this.closedFiles.delete(oldest.value);
    }
  }

  private async discard(requestId: string, file: OpenFile): Promise<void> {
    await file.writable.abort().catch(() => undefined);
    this.openFiles.delete(requestId);
    await file.directory.removeEntry(file.fileName).catch(() => undefined);
  }
}
