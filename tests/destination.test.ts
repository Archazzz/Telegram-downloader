import { describe, expect, it, vi } from "vitest";
import { ensureDirectoryPermission } from "../src/shared/destination";

function directoryHandle(query: PermissionState, request: PermissionState): FileSystemDirectoryHandle {
  return {
    queryPermission: vi.fn().mockResolvedValue(query),
    requestPermission: vi.fn().mockResolvedValue(request)
  } as unknown as FileSystemDirectoryHandle;
}

describe("directory permission recovery", () => {
  it("reuses an already-granted directory without prompting", async () => {
    const handle = directoryHandle("granted", "denied") as FileSystemDirectoryHandle & { requestPermission: ReturnType<typeof vi.fn> };
    expect(await ensureDirectoryPermission(handle)).toBe(true);
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it("requests write access once when the stored handle is promptable", async () => {
    const handle = directoryHandle("prompt", "granted") as FileSystemDirectoryHandle & { requestPermission: ReturnType<typeof vi.fn> };
    expect(await ensureDirectoryPermission(handle)).toBe(true);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("reports an unavailable directory when permission is denied", async () => {
    const handle = directoryHandle("denied", "denied");
    expect(await ensureDirectoryPermission(handle)).toBe(false);
  });
});
