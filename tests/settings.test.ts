import { describe, expect, it } from "vitest";
import { DEFAULT_CONCURRENCY, normalizeConcurrency } from "../src/shared/settings";

describe("normalizeConcurrency", () => {
  it("defaults to two downloads", () => {
    expect(DEFAULT_CONCURRENCY).toBe(2);
    expect(normalizeConcurrency(undefined)).toBe(2);
  });

  it("clamps the configurable range to one through five", () => {
    expect(normalizeConcurrency(-10)).toBe(1);
    expect(normalizeConcurrency(1)).toBe(1);
    expect(normalizeConcurrency(4.6)).toBe(5);
    expect(normalizeConcurrency(99)).toBe(5);
  });
});

