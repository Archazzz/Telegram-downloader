export type DownloadErrorCode =
  | "BRIDGE_UNAVAILABLE"
  | "DISK_FULL"
  | "DIRECTORY_MISSING"
  | "DIRECTORY_PERMISSION"
  | "FILESYSTEM_UNAVAILABLE"
  | "HTTP_CLIENT"
  | "HTTP_SERVER"
  | "INVALID_RANGE"
  | "NETWORK"
  | "NETWORK_STALLED"
  | "STALE_MEDIA_URL"
  | "WRITER_CAPACITY";

export class DownloadError extends Error {
  constructor(message: string, readonly code: DownloadErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadError";
  }
}

export function errorCode(error: unknown): DownloadErrorCode | undefined {
  return error instanceof DownloadError ? error.code : undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function normalizeDownloadError(error: unknown): Error {
  if (error instanceof DownloadError || isAbortError(error)) return error as Error;
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") {
      return new DownloadError("目标磁盘空间不足，请清理空间或更换下载目录", "DISK_FULL", { cause: error });
    }
    if (["NotFoundError", "NotReadableError", "InvalidStateError"].includes(error.name)) {
      return new DownloadError("下载目录或目标磁盘已不可用，请重新选择下载目录", "FILESYSTEM_UNAVAILABLE", { cause: error });
    }
    if (["NotAllowedError", "SecurityError"].includes(error.name)) {
      return new DownloadError("下载目录没有写入权限，请在扩展弹窗中重新授权", "DIRECTORY_PERMISSION", { cause: error });
    }
  }
  if (error instanceof Error && /failed to fetch|networkerror|err_network|network request failed|load failed/i.test(error.message)) {
    return new DownloadError("网络连接中断，请检查 VPN 或网络后重试", "NETWORK", { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
