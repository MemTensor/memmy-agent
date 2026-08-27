import { describe,expect,it } from "vitest";
import {
  filterL1TraceSpanRecallHits
} from "../../../src/service/retrieval/l1-trace-span-filter.js";
import type { MemoryRow,RecallHit } from "../../../src/types.js";

describe("L1 Trace/Span recall filtering", () => {
  it("replaces a recalled parent Trace with at most its first two recalled Spans", () => {
    const parent = hit("trace-parent", "trace", "L1");
    const first = hit("span-first", "span", "L1");
    const second = hit("span-second", "span", "L1");
    const third = hit("span-third", "span", "L1");
    const unrelated = hit("trace-unrelated", "trace", "L1");
    const policy = hit("policy-1", "policy", "L2");

    expect(filterL1TraceSpanRecallHits(
      [parent, first, unrelated, second, third, policy],
      [
        memory("trace-parent", "trace"),
        memory("span-first", "span", "trace-parent"),
        memory("span-second", "span", "trace-parent"),
        memory("span-third", "span", "trace-parent"),
        memory("trace-unrelated", "trace"),
        memory("policy-1", "policy", undefined, "L2")
      ]
    )).toEqual([first, unrelated, second, policy]);
  });

  it("keeps the parent Trace when none of its Spans reached the final recall", () => {
    const parent = hit("trace-parent", "trace", "L1");

    expect(filterL1TraceSpanRecallHits(
      [parent],
      [
        memory("trace-parent", "trace"),
        memory("span-not-recalled", "span", "trace-parent")
      ]
    )).toEqual([parent]);
  });

  it("keeps a Span whose source metadata is missing", () => {
    const span = hit("span-orphan", "span", "L1");

    expect(filterL1TraceSpanRecallHits(
      [span],
      [memory("span-orphan", "span")]
    )).toEqual([span]);
  });
});

function hit(
  id: string,
  kind: RecallHit["kind"],
  memoryLayer: RecallHit["memoryLayer"]
): RecallHit {
  return {
    id,
    kind,
    memoryLayer,
    status: "activated",
    title: id,
    snippet: id,
    score: 1,
    tags: [],
    source: kind === "policy" ? "rule" : "search"
  };
}

function memory(
  id: string,
  kind: RecallHit["kind"],
  sourceTraceId?: string,
  memoryLayer: MemoryRow["memoryLayer"] = "L1"
): MemoryRow {
  const at = "2026-07-24T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "recall-filter-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: id,
    memoryValue: id,
    tags: [],
    info: sourceTraceId ? { source_trace_id: sourceTraceId } : {},
    properties: {
      internal_info: {
        memory_layer: memoryLayer,
        memory_kind: kind,
        ...(kind === "span"
          ? {
              span: {
                ...(sourceTraceId ? { source_trace_id: sourceTraceId } : {})
              }
            }
          : {})
      }
    },
    memoryLayer,
    version: 1,
    createdAt: at,
    updatedAt: at
  };
}
