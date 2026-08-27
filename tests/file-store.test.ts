import { describe, expect, it, vi } from "vitest";
import { FileStore } from "../src/core/file-store";

type MockFile = {
  writable: {
    write: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
};

function mockDirectory(): FileSystemDirectoryHandle & { files: Map<string, MockFile> } {
  const files = new Map<string, MockFile>();
  return {
    kind: "directory",
    name: "downloads",
    files,
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      let file = files.get(name);
      if (!file && !options?.create) throw new DOMException("missing", "NotFoundError");
      if (!file) {
        file = {
          writable: {
            write: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
            abort: vi.fn().mockResolvedValue(undefined)
          }
        };
        files.set(name, file);
      }
      return {
        kind: "file",
        name,
        createWritable: vi.fn().mockResolvedValue(file.writable)
      } as unknown as FileSystemFileHandle;
    }),
    removeEntry: vi.fn(async (name: string) => { files.delete(name); })
  } as unknown as FileSystemDirectoryHandle & { files: Map<string, MockFile> };
}

describe("offscreen file store", () => {
  it("removes an aborted file so a retry can reuse the original name", async () => {
    const directory = mockDirectory();
    const store = new FileStore();
    expect(await store.start(directory, "first", "video.mp4")).toBe("video.mp4");
    await store.write("first", new Uint8Array(new ArrayBuffer(4)));
    expect(directory.files.has("video.mp4")).toBe(true);

    expect(await store.abort("first")).toBe(true);
    expect(directory.files.has("video.mp4")).toBe(false);
    expect(await store.start(directory, "retry", "video.mp4")).toBe("video.mp4");
  });

  it("keeps a successfully closed file and reports its byte count", async () => {
    const directory = mockDirectory();
    const store = new FileStore();
    await store.start(directory, "request", "photo.jpg");
    await store.write("request", new Uint8Array(new ArrayBuffer(7)));
    expect(await store.close("request")).toBe(7);
    expect(directory.files.has("photo.jpg")).toBe(true);
    expect(store.openCount).toBe(0);
  });

  it("returns a non-retryable capacity error instead of silently overflowing", async () => {
    const directory = mockDirectory();
    const store = new FileStore(1);
    await store.start(directory, "first", "one.mp4");
    await expect(store.start(directory, "second", "two.mp4")).rejects.toMatchObject({ code: "WRITER_CAPACITY" });
  });
});
