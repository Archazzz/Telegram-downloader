import { describe, expect, it } from "vitest";
import { discoverMessageMedia, stableMessageId } from "../src/core/discovery";

function messageWithMedia(id: string, count: number): HTMLElement {
  const message = document.createElement("article");
  message.dataset.messageId = id;
  for (let index = 0; index < count; index += 1) {
    const host = document.createElement("div");
    host.className = "album-item";
    const image = document.createElement("img");
    image.width = 320;
    image.height = 180;
    image.src = `https://cdn.example/${id}-${index}.jpg`;
    host.appendChild(image);
    message.appendChild(host);
  }
  return message;
}

describe("media discovery", () => {
  it("groups every attachment under the Telegram message id", () => {
    const message = messageWithMedia("42", 3);
    document.body.appendChild(message);
    const media = discoverMessageMedia(message);
    expect(media).toHaveLength(3);
    expect(new Set(media.map((item) => item.messageId))).toEqual(new Set(["telegram:42"]));
    expect(media.map((item) => item.attachmentIndex)).toEqual([0, 1, 2]);
    expect(new Set(media.map((item) => item.id)).size).toBe(3);
  });

  it("produces stable ids across repeated scans", () => {
    const message = messageWithMedia("repeat", 2);
    document.body.appendChild(message);
    const first = discoverMessageMedia(message).map((item) => item.id);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      expect(discoverMessageMedia(message).map((item) => item.id)).toEqual(first);
    }
  });

  it("uses deterministic fallback ids", () => {
    const root = document.createElement("article");
    root.textContent = "fallback message";
    expect(stableMessageId(root, ["a", "b"])).toBe(stableMessageId(root, ["a", "b"]));
  });
});

