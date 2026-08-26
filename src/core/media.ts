export type MediaKind = "image" | "video" | "gif" | "audio";

export type MediaDescriptor = {
  id: string;
  messageId: string;
  attachmentIndex: number;
  kind: MediaKind;
  url: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  fingerprint: string;
  element: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
  host: HTMLElement;
};

export type StreamMetadata = {
  fileName?: string;
  mimeType?: string;
  size?: number;
};

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a"
};

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function parseStreamMetadata(url: string): StreamMetadata | null {
  try {
    const marker = "/stream/";
    const markerIndex = url.indexOf(marker);
    if (markerIndex < 0) return null;
    const encoded = url.slice(markerIndex + marker.length).split(/[?#]/, 1)[0];
    if (!encoded) return null;
    const decoded = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
    const fileName = typeof decoded.fileName === "string" ? decoded.fileName : undefined;
    const mimeType = typeof decoded.mimeType === "string" ? decoded.mimeType : undefined;
    const size = typeof decoded.size === "number" && decoded.size >= 0 ? decoded.size : undefined;
    return fileName || mimeType || size !== undefined ? { fileName, mimeType, size } : null;
  } catch {
    return null;
  }
}

export function extensionFromMime(mimeType?: string): string | null {
  if (!mimeType) return null;
  return MIME_EXTENSIONS[mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? ""] ?? null;
}

export function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  return reserved.test(cleaned) ? `_${cleaned}` : cleaned || "telegram-media";
}

export function buildFileName(media: Pick<MediaDescriptor, "fileName" | "mimeType" | "kind" | "id">): string {
  const fallbackExtension = media.kind === "image" ? "jpg" : media.kind === "video" ? "mp4" : "bin";
  const base = sanitizeFileName(media.fileName ?? `telegram-${media.kind}-${media.id}`);
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  return `${base}.${extensionFromMime(media.mimeType) ?? fallbackExtension}`;
}

export function mediaElementUrl(element: HTMLImageElement | HTMLVideoElement | HTMLAudioElement): string {
  return element.currentSrc || element.getAttribute("src") || element.getAttribute("data-src") || "";
}

export function detectKind(element: Element, mimeType?: string): MediaKind {
  if (element instanceof HTMLVideoElement) return "video";
  if (element instanceof HTMLAudioElement) return "audio";
  if (mimeType === "image/gif") return "gif";
  return "image";
}

