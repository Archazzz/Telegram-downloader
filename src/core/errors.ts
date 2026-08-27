export type DownloadErrorCode =
  | "BRIDGE_UNAVAILABLE"
  | "DIRECTORY_MISSING"
  | "DIRECTORY_PERMISSION"
  | "HTTP_CLIENT"
  | "HTTP_SERVER"
  | "INVALID_RANGE"
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
