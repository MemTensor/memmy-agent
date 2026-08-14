import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "../../../src/algorithm/plugin-algorithms.js";
import { mergeRetrievalResults } from "../../../src/service/retrieval/query-rewrite.js";

describe("query rewrite retrieval", () => {
  it("preserves the best final recall score when merging rewritten queries", () => {
    const first = retrievalResult(0.25);
    const second = retrievalResult(0.6);

    const merged = mergeRetrievalResults([first, second], 5, 8, 1);

    expect(merged.hits).toEqual([expect.objectContaining({ id: "trace-1", score: 0.6 })]);
    expect(merged.debug.topRelevance).toBe(0.6);
  });
});

function retrievalResult(score: number): RetrievalResult {
  return {
    hits: [{
      id: "trace-1",
      kind: "trace",
      memoryLayer: "L1",
      status: "activated",
      snippet: "relevant trace",
      score,
      tags: [],
      source: "search"
    }],
    debug: {
      tierSizes: { tier1: 0, tier2: 1, tier3: 0 },
      kept: { tier1: 0, tier2: 1, tier3: 0 },
      topRelevance: score,
      droppedByThreshold: 0
    }
  };
}
