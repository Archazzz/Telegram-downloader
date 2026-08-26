import { describe, expect, it } from "vitest";
import { buildFileName, parseStreamMetadata, sanitizeFileName } from "../src/core/media";

describe("stream metadata", () => {
  it("parses Telegram stream descriptors", () => {
    const descriptor = encodeURIComponent(JSON.stringify({ fileName: "lesson.mp4", mimeType: "video/mp4", size: 42 }));
    expect(parseStreamMetadata(`https://web.telegram.org/k/stream/${descriptor}`)).toEqual({
      fileName: "lesson.mp4",
      mimeType: "video/mp4",
      size: 42
    });
  });

  it("returns null for unrelated or malformed URLs", () => {
    expect(parseStreamMetadata("blob:https://web.telegram.org/abc")).toBeNull();
    expect(parseStreamMetadata("https://web.telegram.org/k/stream/not-json")).toBeNull();
  });
});

describe("file names", () => {
  it("removes cross-platform unsafe characters and reserved names", () => {
    expect(sanitizeFileName("a<b>:c?.mp4 ")).toBe("a_b__c_.mp4");
    expect(sanitizeFileName("CON")).toBe("_CON");
  });

  it("adds an extension from the MIME type", () => {
    expect(buildFileName({ id: "abc", kind: "image", fileName: "photo", mimeType: "image/webp" })).toBe("photo.webp");
    expect(buildFileName({ id: "abc", kind: "video", fileName: "clip.mp4" })).toBe("clip.mp4");
  });
});

