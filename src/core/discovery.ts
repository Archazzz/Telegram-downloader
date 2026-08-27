import { MediaDescriptor, detectKind, hashString, mediaElementUrl, parseStreamMetadata } from "./media";

export const MESSAGE_SELECTOR = [
  "[data-message-id]",
  "[data-mid]",
  "[data-message]",
  ".message",
  ".bubble",
  "[class*='Message']"
].join(",");

const MEDIA_SELECTOR = "img,video,audio";
const EXCLUDED_ANCESTOR_SELECTOR = "[class*='avatar'],[class*='emoji'],[class*='sticker'],[class*='reaction']";
const MEDIA_HOST_SELECTOR = [
  "[data-media-id]",
  "[class*='album-item']",
  "[class*='grid-item']",
  "[class*='media-container']",
  "[class*='Media']",
  ".media"
].join(",");

function hasMediaDimensions(element: HTMLImageElement | HTMLVideoElement | HTMLAudioElement): boolean {
  if (element instanceof HTMLVideoElement || element instanceof HTMLAudioElement) return true;
  const width = element.naturalWidth || element.clientWidth || Number(element.getAttribute("width")) || 0;
  const height = element.naturalHeight || element.clientHeight || Number(element.getAttribute("height")) || 0;
  return width >= 120 && height >= 90;
}

function isVideoPoster(element: HTMLImageElement, root: HTMLElement): boolean {
  const mediaContainer = element.closest<HTMLElement>(".media-container,.media-container-aspecter,.attachment");
  if (mediaContainer?.querySelector("video,.video-play,.video-time,[class*='video-play'],[class*='video-time']")) return true;

  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.classList.contains("video")) return true;
    if (ancestor === root) break;
    ancestor = ancestor.parentElement;
  }
  return false;
}

export function findMessageRoot(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(MESSAGE_SELECTOR);
}

export function stableMessageId(root: HTMLElement, urls: string[] = []): string {
  for (const attribute of ["data-message-id", "data-mid", "data-message", "data-id"]) {
    const value = root.getAttribute(attribute);
    if (value) return `telegram:${value}`;
  }
  const timestamp = root.querySelector("time")?.getAttribute("datetime") ?? root.getAttribute("data-timestamp") ?? "";
  const text = (root.textContent ?? "").trim().slice(0, 180);
  return `fallback:${hashString(`${location.pathname}|${timestamp}|${text}|${urls.join("|")}`)}`;
}

export function discoverMessageMedia(root: HTMLElement): MediaDescriptor[] {
  const candidates = [...root.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLAudioElement>(MEDIA_SELECTOR)]
    .filter((element) => !element.closest(EXCLUDED_ANCESTOR_SELECTOR))
    .filter(hasMediaDimensions)
    .map((element) => {
      const videoPoster = element instanceof HTMLImageElement && isVideoPoster(element, root);
      if (videoPoster) {
        const mediaHost = element.closest<HTMLElement>(MEDIA_HOST_SELECTOR);
        const loadedVideo = mediaHost?.querySelector<HTMLVideoElement>("video");
        if (loadedVideo && mediaElementUrl(loadedVideo)) return null;
      }
      return { element, url: mediaElementUrl(element), requiresViewer: videoPoster };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .filter(({ url }) => Boolean(url) && !url.startsWith("data:image/svg"));

  const messageId = stableMessageId(root, candidates.map(({ url }) => url));
  return candidates.map(({ element, url, requiresViewer }, attachmentIndex) => {
    const metadata = parseStreamMetadata(url);
    const kind = requiresViewer ? "video" : detectKind(element, metadata?.mimeType);
    const fingerprint = hashString(`${requiresViewer ? "video-poster" : url}|${metadata?.fileName ?? ""}|${metadata?.size ?? ""}`);
    const host = element.closest<HTMLElement>(MEDIA_HOST_SELECTOR) ?? element.parentElement ?? root;
    return {
      id: `${messageId}:${attachmentIndex}:${fingerprint}`,
      messageId,
      attachmentIndex,
      kind,
      url,
      fileName: metadata?.fileName,
      mimeType: metadata?.mimeType,
      size: metadata?.size,
      requiresViewer,
      fingerprint,
      element,
      host
    };
  });
}
