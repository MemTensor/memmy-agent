import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingRetryBackoffMs } from "../../../src/service/embedding/embedding-pipeline.js";

afterEach(() => vi.restoreAllMocks());

describe("Embedding retry exponential backoff", () => {
  it.each([[1, 60_000], [2, 120_000], [6, 1_920_000], [7, 3_600_000], [100, 3_600_000]])(
    "keeps the existing baseline and one-hour ceiling at attempt %s", (attempt, expected) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      expect(embeddingRetryBackoffMs(attempt)).toBe(expected);
    }
  );

  it("spreads equal-attempt retries around the unchanged baseline", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(1);
    expect(embeddingRetryBackoffMs(1)).toBe(48_000);
    expect(embeddingRetryBackoffMs(1)).toBe(72_000);
  });

  it("keeps jitter below the existing cap even after the exponential baseline reaches it", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(1);
    expect(embeddingRetryBackoffMs(100)).toBe(2_880_000);
    expect(embeddingRetryBackoffMs(100)).toBe(3_600_000);
  });
});
