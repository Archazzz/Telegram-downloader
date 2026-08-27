import { describe, expect, it } from "vitest";
import { BatchProgress } from "../src/core/batch";

describe("message batch progress", () => {
  it("reports mixed terminal states instead of claiming full success", () => {
    const progress = new BatchProgress();
    for (let index = 0; index < 3; index += 1) progress.accept();
    progress.record("success");
    progress.record("error");
    progress.record("cancelled");

    expect(progress.summary()).toEqual({
      state: "error",
      label: "成功 1 · 失败 1 · 取消 1",
      done: true
    });
  });

  it("keeps a batch running until every accepted item is terminal", () => {
    const progress = new BatchProgress();
    progress.accept();
    progress.accept();
    progress.record("success");
    expect(progress.summary()).toEqual({ state: "running", label: "下载中 1/2", done: false });
  });
});
