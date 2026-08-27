import { MediaDescriptor } from "./media";

type TelegramMessage = {
  media?: {
    document?: TelegramMedia;
    photo?: TelegramMedia;
  };
};

type TelegramMedia = {
  _?: string;
  id?: string | number;
  fileName?: string;
  mime_type?: string;
  size?: number;
  sizes?: Array<{ w?: number; h?: number }>;
  attributes?: Array<{
    _?: string;
    file_name?: string;
  }>;
};

type TelegramDownloadResult = PromiseLike<unknown> & {
  addNotifyListener?: (listener: (progress: { done?: number; total?: number }) => void) => void;
  cancel?: () => void;
};

type TelegramWindow = Window & typeof globalThis & {
  mtprotoMessagePort?: {
    getMessageByPeer?: (peerId: string, mid: number) => TelegramMessage | undefined;
  };
  appDownloadManager?: {
    downloadMedia?: (options: { media: TelegramMedia; thumb?: { w?: number; h?: number } }) => TelegramDownloadResult;
    download?: (options: { media: TelegramMedia; thumb?: { w?: number; h?: number } }) => TelegramDownloadResult;
  };
};

export type TelegramBlob = {
  blob: Blob;
  fileName?: string;
  mimeType?: string;
  size: number;
};

let telegramDownloadTail: Promise<void> = Promise.resolve();

function abortError(): DOMException {
  return new DOMException("下载已取消", "AbortError");
}

async function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const cancel = (): void => {
      signal.removeEventListener("abort", cancel);
      reject(abortError());
    };
    signal.addEventListener("abort", cancel, { once: true });
    void turn.then(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    });
  });
}

async function inTelegramDownloadSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const previous = telegramDownloadTail;
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  telegramDownloadTail = previous.then(() => current);

  try {
    await waitForTurn(previous, signal);
    if (signal.aborted) throw abortError();
    return await operation();
  } finally {
    release();
  }
}

function mediaFileName(media: TelegramMedia): string | undefined {
  if (media.fileName) return media.fileName;
  return media.attributes?.find((attribute) => attribute._ === "documentAttributeFilename")?.file_name;
}

function largestPhotoSize(media: TelegramMedia): { w?: number; h?: number } | undefined {
  return media.sizes?.filter((size) => size.w && size.h).at(-1);
}

async function resultBlob(result: unknown, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
  if (result instanceof Blob) return result;
  if (result && typeof result === "object" && "blob" in result && (result as { blob?: unknown }).blob instanceof Blob) {
    return (result as { blob: Blob }).blob;
  }
  if (typeof result === "string") {
    const response = await fetch(result, { signal });
    if (!response.ok) throw new Error(`Telegram 原始媒体请求失败：HTTP ${response.status}`);
    return response.blob();
  }
  throw new Error("Telegram 内部下载接口没有返回媒体数据");
}

export async function downloadTelegramBlob(
  descriptor: MediaDescriptor,
  signal: AbortSignal,
  onProgress?: (written: number, total: number) => void
): Promise<TelegramBlob | null> {
  const bubble = descriptor.element.closest<HTMLElement>("[data-mid][data-peer-id]");
  const peerId = bubble?.dataset.peerId;
  const mid = Number(bubble?.dataset.mid);
  const page = window as TelegramWindow;
  const message = peerId && Number.isFinite(mid) ? page.mtprotoMessagePort?.getMessageByPeer?.(peerId, mid) : undefined;
  const media = message?.media?.document ?? message?.media?.photo;
  const manager = page.appDownloadManager;
  const download = manager?.downloadMedia ?? manager?.download;
  if (!media || !manager || !download) return null;

  return inTelegramDownloadSlot(signal, async () => {
    const options = { media, thumb: media.mime_type ? undefined : largestPhotoSize(media) };
    const task = download.call(manager, options);
    const cancel = (): void => task.cancel?.();
    signal.addEventListener("abort", cancel, { once: true });
    task.addNotifyListener?.((progress) => {
      const written = Number(progress?.done ?? 0);
      const total = Number(progress?.total ?? media.size ?? 0);
      if (written >= 0 && total >= 0) onProgress?.(written, total);
    });

    try {
      const blob = await resultBlob(await task, signal);
      const declaredSize = Number(media.size ?? 0);
      return {
        blob,
        fileName: mediaFileName(media),
        mimeType: media.mime_type || blob.type || undefined,
        size: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : blob.size
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  });
}
