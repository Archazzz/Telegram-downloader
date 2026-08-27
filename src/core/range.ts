import { DownloadError } from "./errors";

export type ContentRange = { start: number; end: number; total: number };

export function parseContentRange(value: string | null): ContentRange | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) throw new DownloadError(`服务器返回了无效的 Content-Range：${value}`, "INVALID_RANGE");
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

export function validateRangeResponse(offset: number, status: number, contentRange: string | null): ContentRange | null {
  if (status !== 200 && status !== 206) {
    const code = status >= 400 && status < 500 ? "HTTP_CLIENT" : "HTTP_SERVER";
    throw new DownloadError(`媒体请求失败：HTTP ${status}`, code);
  }
  if (offset > 0 && status === 200) {
    throw new DownloadError("服务器在断点续传时忽略了 Range，已停止写入以防文件损坏", "INVALID_RANGE");
  }
  const range = parseContentRange(contentRange);
  if (status === 206 && !range) {
    throw new DownloadError("服务器返回 206 但缺少 Content-Range", "INVALID_RANGE");
  }
  if (range && range.start !== offset) {
    throw new DownloadError("服务器返回的分块起点不正确", "INVALID_RANGE");
  }
  return range;
}
