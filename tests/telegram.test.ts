import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDescriptor } from "../src/core/media";
import { downloadTelegramBlob } from "../src/core/telegram";

function descriptor(): MediaDescriptor {
  const bubble = document.createElement("article");
  bubble.dataset.peerId = "-1001";
  bubble.dataset.mid = "42";
  const poster = document.createElement("img");
  bubble.appendChild(poster);
  document.body.appendChild(bubble);
  return {
    id: "video",
    messageId: "telegram:42",
    attachmentIndex: 0,
    kind: "video",
    url: "blob:https://web.telegram.org/poster",
    requiresViewer: true,
    fingerprint: "video",
    element: poster,
    host: bubble
  };
}

afterEach(() => {
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).mtprotoMessagePort;
  delete (window as unknown as Record<string, unknown>).appDownloadManager;
});

describe("Telegram native media download", () => {
  it("resolves the original document from the message ids", async () => {
    const downloadMedia = vi.fn().mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));
    Object.assign(window, {
      mtprotoMessagePort: {
        getMessageByPeer: vi.fn().mockReturnValue({
          media: {
            document: {
              mime_type: "video/mp4",
              size: 5,
              attributes: [{ _: "documentAttributeFilename", file_name: "original.mp4" }]
            }
          }
        })
      },
      appDownloadManager: { downloadMedia }
    });

    const result = await downloadTelegramBlob(descriptor(), new AbortController().signal);
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ fileName: "original.mp4", mimeType: "video/mp4", size: 5 });
    expect(await result?.blob.text()).toBe("video");
  });

  it("returns null when Telegram internals are unavailable", async () => {
    await expect(downloadTelegramBlob(descriptor(), new AbortController().signal)).resolves.toBeNull();
  });

  it("serializes concurrent calls to Telegram's internal download manager", async () => {
    let active = 0;
    let maximumActive = 0;
    const resolvers: Array<() => void> = [];
    const downloadMedia = vi.fn(() => new Promise<Blob>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      resolvers.push(() => {
        active -= 1;
        resolve(new Blob(["video"], { type: "video/mp4" }));
      });
    }));
    Object.assign(window, {
      mtprotoMessagePort: {
        getMessageByPeer: vi.fn().mockReturnValue({ media: { document: { mime_type: "video/mp4", size: 5 } } })
      },
      appDownloadManager: { downloadMedia }
    });

    const first = downloadTelegramBlob(descriptor(), new AbortController().signal);
    const second = downloadTelegramBlob(descriptor(), new AbortController().signal);
    await vi.waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(2));
    resolvers.shift()?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maximumActive).toBe(1);
  });
});
