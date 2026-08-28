import { DownloadError } from "./errors";
import { sanitizeFileName } from "./media";

type OpenFile = {
  directory: FileSystemDirectoryHandle;
  fileName: string;
  writable: FileSystemWritableFileStream;
  bytesWritten: number;
};

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

  constructor(private readonly maxOpenFiles = 25) {}

  get openCount(): number {
    return this.openFiles.size;
  }

  async start(directory: FileSystemDirectoryHandle, requestId: string, rawName: string, replaceEmpty = false): Promise<string> {
    if (this.openFiles.has(requestId)) throw new Error("下载文件句柄已存在");
    if (this.openFiles.size >= this.maxOpenFiles) {
      throw new DownloadError("已达到扩展级最大并发写入数量，请减少同时打开的 Telegram 标签页", "WRITER_CAPACITY");
    }
    const requestedName = sanitizeFileName(rawName);
    const { fileName, handle } = await createUniqueFile(directory, requestedName, replaceEmpty);
    try {
      const writable = await handle.createWritable({ keepExistingData: false });
      this.openFiles.set(requestId, { directory, fileName, writable, bytesWritten: 0 });
      return fileName;
    } catch (error) {
      await directory.removeEntry(fileName).catch(() => undefined);
      throw error;
    }
  }

  async write(requestId: string, chunk: Uint8Array<ArrayBuffer>): Promise<number> {
    const file = this.openFiles.get(requestId);
    if (!file) throw new Error("下载文件句柄不存在或已关闭");
    await file.writable.write(chunk);
    file.bytesWritten += chunk.byteLength;
    return file.bytesWritten;
  }

  async close(requestId: string): Promise<number> {
    const file = this.openFiles.get(requestId);
    if (!file) throw new Error("下载文件句柄不存在或已关闭");
    try {
      await file.writable.close();
      this.openFiles.delete(requestId);
      return file.bytesWritten;
    } catch (error) {
      await this.discard(requestId, file);
      throw error;
    }
  }

  async abort(requestId: string): Promise<boolean> {
    const file = this.openFiles.get(requestId);
    if (!file) return false;
    await this.discard(requestId, file);
    return true;
  }

  private async discard(requestId: string, file: OpenFile): Promise<void> {
    await file.writable.abort().catch(() => undefined);
    this.openFiles.delete(requestId);
    await file.directory.removeEntry(file.fileName).catch(() => undefined);
  }
}
