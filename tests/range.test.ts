import { describe, expect, it } from "vitest";
import { parseContentRange, validateRangeResponse } from "../src/core/range";

describe("range response validation", () => {
  it("parses a valid partial response", () => {
    expect(parseContentRange("bytes 256-511/1024")).toEqual({ start: 256, end: 511, total: 1024 });
    expect(validateRangeResponse(256, 206, "bytes 256-511/1024")).toEqual({ start: 256, end: 511, total: 1024 });
  });

  it("accepts a full response only for the first request", () => {
    expect(validateRangeResponse(0, 200, null)).toBeNull();
    expect(() => validateRangeResponse(256, 200, null)).toThrow("防文件损坏");
  });

  it("rejects incomplete or mismatched 206 responses", () => {
    expect(() => validateRangeResponse(0, 206, null)).toThrow("缺少 Content-Range");
    expect(() => validateRangeResponse(256, 206, "bytes 0-255/1024")).toThrow("分块起点");
  });

  it("classifies HTTP client and server failures", () => {
    expect(() => validateRangeResponse(0, 404, null)).toThrow(expect.objectContaining({ code: "HTTP_CLIENT" }));
    expect(() => validateRangeResponse(0, 503, null)).toThrow(expect.objectContaining({ code: "HTTP_SERVER" }));
  });
});
