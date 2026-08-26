import { describe, expect, it } from "vitest";
import { discoverMessageMedia } from "../src/core/discovery";

describe("large message discovery", () => {
  it("finds 3,000 media attachments in a 10,000-message fixture without duplicate ids", () => {
    const fragment = document.createDocumentFragment();
    const mediaMessages: HTMLElement[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const message = document.createElement("article");
      message.dataset.messageId = `stress-${index}`;
      if (index % 10 < 3) {
        const image = document.createElement("img");
        image.width = 320;
        image.height = 180;
        image.src = `https://cdn.example/stress-${index}.jpg`;
        message.appendChild(image);
        mediaMessages.push(message);
      } else {
        message.textContent = `message ${index}`;
      }
      fragment.appendChild(message);
    }
    document.body.appendChild(fragment);

    const ids = mediaMessages.flatMap((message) => discoverMessageMedia(message).map((media) => media.id));
    expect(ids).toHaveLength(3_000);
    expect(new Set(ids).size).toBe(3_000);
  }, 15_000);
});

