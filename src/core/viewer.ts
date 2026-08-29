import { MediaDescriptor, mediaElementUrl } from "./media";

const VIEWER_SELECTOR = [
  ".media-viewer",
  ".MediaViewer",
  "[data-testid='media-viewer']"
].join(",");
const ATTACHMENT_SELECTOR = ".attachment.media-container,.attachment,[class*='bubble-video']";

function videoSource(video: HTMLVideoElement): string {
  return mediaElementUrl(video) || video.querySelector<HTMLSourceElement>("source")?.src || "";
}

function interactionRoot(media: MediaDescriptor): HTMLElement {
  return media.element.closest<HTMLElement>(ATTACHMENT_SELECTOR) ?? media.host;
}

function videoTrigger(media: MediaDescriptor, root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(".video-play,[class*='video-play']")
    ?? media.host.querySelector<HTMLElement>(".video-play,[class*='video-play']")
    ?? media.element;
}

function domDistance(from: Node, to: Node): number {
  const ancestors = new Map<Node, number>();
  let current: Node | null = from;
  let distance = 0;
  while (current) {
    ancestors.set(current, distance);
    current = current.parentNode;
    distance += 1;
  }
  current = to;
  distance = 0;
  while (current) {
    const sharedDistance = ancestors.get(current);
    if (sharedDistance !== undefined) return sharedDistance + distance;
    current = current.parentNode;
    distance += 1;
  }
  return Number.POSITIVE_INFINITY;
}

export type RevealedVideoSource = {
  url: string;
  dismiss: () => void;
};

function dismissViewer(video: HTMLVideoElement, viewer: HTMLElement | null, shouldClose: boolean): void {
  video.pause();
  if (!viewer || !shouldClose) return;
  const close = viewer.querySelector<HTMLElement>(
    "[aria-label='Close'],[aria-label='关闭'],.tgico-close,[class~='close']"
  );
  if (close) close.click();
  else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

export function revealVideoSource(
  media: MediaDescriptor,
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<RevealedVideoSource> {
  if (!media.requiresViewer) return Promise.resolve({ url: media.url, dismiss: () => undefined });
  if (signal?.aborted) return Promise.reject(new DOMException("下载已取消", "AbortError"));

  const existingVideos = new Set(document.querySelectorAll<HTMLVideoElement>("video"));
  const existingViewers = new Set(document.querySelectorAll<HTMLElement>(VIEWER_SELECTOR));
  const existingSources = new Map([...existingVideos].map((video) => [video, videoSource(video)]));
  const root = interactionRoot(media);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;

    const cleanup = (): void => {
      observer.disconnect();
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      document.removeEventListener("loadedmetadata", onMediaReady, true);
    };
    const finish = (url: string, video: HTMLVideoElement): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const viewer = video.closest<HTMLElement>(VIEWER_SELECTOR);
      resolve({
        url,
        dismiss: () => dismissViewer(video, viewer, Boolean(viewer && !existingViewers.has(viewer)))
      });
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const findSource = (): { url: string; video: HTMLVideoElement } | null => {
      const changedVideos: Array<{ url: string; video: HTMLVideoElement }> = [];
      for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
        const url = videoSource(video);
        if (!url) continue;
        const isNewVideo = !existingVideos.has(video);
        const sourceChanged = existingSources.get(video) !== url;
        const isOriginalMedia = root.contains(video);
        const isViewerMedia = Boolean(video.closest(VIEWER_SELECTOR));
        if (isOriginalMedia || (isViewerMedia && (isNewVideo || sourceChanged))) return { url, video };
        if (isNewVideo || sourceChanged) changedVideos.push({ url, video });
      }
      if (changedVideos.length === 0) return null;
      changedVideos.sort((left, right) => domDistance(root, left.video) - domDistance(root, right.video));
      return changedVideos[0]!;
    };
    const inspect = (): void => {
      const url = findSource();
      if (url) finish(url.url, url.video);
    };
    const onAbort = (): void => fail(new DOMException("下载已取消", "AbortError"));
    const onMediaReady = (): void => inspect();
    const observer = new MutationObserver(inspect);

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "data-src"]
    });
    document.addEventListener("loadedmetadata", onMediaReady, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => fail(new Error("视频加载超时，请确认 Telegram 中的视频可以正常播放后重试")), timeoutMs);

    videoTrigger(media, root).click();
    inspect();
  });
}
