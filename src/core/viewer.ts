import { MediaDescriptor, mediaElementUrl } from "./media";

const VIEWER_SELECTOR = [
  ".media-viewer",
  "[class*='media-viewer']",
  "[class*='MediaViewer']",
  "[class*='viewer']"
].join(",");

function videoSource(video: HTMLVideoElement): string {
  return mediaElementUrl(video) || video.querySelector<HTMLSourceElement>("source")?.src || "";
}

function videoTrigger(media: MediaDescriptor): HTMLElement {
  return media.host.querySelector<HTMLElement>(".video-play,[class*='video-play']") ?? media.element;
}

export function revealVideoSource(
  media: MediaDescriptor,
  signal?: AbortSignal,
  timeoutMs = 12_000
): Promise<string> {
  if (!media.requiresViewer) return Promise.resolve(media.url);
  if (signal?.aborted) return Promise.reject(new DOMException("下载已取消", "AbortError"));

  const existingVideos = new Set(document.querySelectorAll<HTMLVideoElement>("video"));
  const existingSources = new Map([...existingVideos].map((video) => [video, videoSource(video)]));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;

    const cleanup = (): void => {
      observer.disconnect();
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      document.removeEventListener("loadedmetadata", onMediaReady, true);
    };
    const finish = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const findSource = (): string | null => {
      for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        const url = videoSource(video);
        if (!url) continue;
        const isNewVideo = !existingVideos.has(video);
        const sourceChanged = existingSources.get(video) !== url;
        const isOriginalMedia = media.host.contains(video);
        const isViewerMedia = Boolean(video.closest(VIEWER_SELECTOR));
        if (isOriginalMedia || (isViewerMedia && (isNewVideo || sourceChanged))) return url;
      }
      return null;
    };
    const inspect = (): void => {
      const url = findSource();
      if (url) finish(url);
    };
    const onAbort = (): void => fail(new DOMException("下载已取消", "AbortError"));
    const onMediaReady = (): void => inspect();
    const observer = new MutationObserver(inspect);

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"]
    });
    document.addEventListener("loadedmetadata", onMediaReady, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => fail(new Error("视频加载超时，请确认 Telegram 中的视频可以正常播放后重试")), timeoutMs);

    videoTrigger(media).click();
    inspect();
  });
}
