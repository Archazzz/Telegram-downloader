import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaDescriptor } from "../src/core/media";
import { revealVideoSource } from "../src/core/viewer";

function unloadedVideo(): { media: MediaDescriptor; play: HTMLButtonElement } {
  const host = document.createElement("div");
  host.className = "attachment media-container";
  const poster = document.createElement("img");
  poster.src = "blob:https://web.telegram.org/poster";
  const play = document.createElement("button");
  play.className = "video-play";
  host.append(poster, play);
  document.body.appendChild(host);
  return {
    play,
    media: {
      id: "video-poster",
      messageId: "telegram:1",
      attachmentIndex: 0,
      kind: "video",
      url: poster.src,
      requiresViewer: true,
      fingerprint: "poster",
      element: poster,
      host
    }
  };
}

describe("Telegram video viewer resolver", () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => vi.useRealTimers());

  it("clicks the play control and returns the newly loaded video stream", async () => {
    const { media, play } = unloadedVideo();
    play.addEventListener("click", () => {
      const viewer = document.createElement("div");
      viewer.className = "media-viewer";
      const video = document.createElement("video");
      video.src = "https://web.telegram.org/k/stream/%7B%22mimeType%22%3A%22video%2Fmp4%22%7D";
      viewer.appendChild(video);
      document.body.appendChild(viewer);
    });

    await expect(revealVideoSource(media, undefined, 100)).resolves.toContain("/stream/");
  });

  it("does not return the poster URL when Telegram never loads a video", async () => {
    vi.useFakeTimers();
    const { media } = unloadedVideo();
    const result = revealVideoSource(media, undefined, 100);
    const expectation = expect(result).rejects.toThrow("视频加载超时");
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });

  it("stops waiting when the queued download is cancelled", async () => {
    const { media } = unloadedVideo();
    const controller = new AbortController();
    const result = revealVideoSource(media, controller.signal, 1_000);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
