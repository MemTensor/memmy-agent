import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANE_WEIGHTS, ShadowQueueSelector, type ShadowQueueCandidate
} from "../../../src/service/worker/shadow-queue-selector.js";
import { QUEUE_LANES, type QueueLane } from "../../../src/service/worker/job-policy-registry.js";

function candidate(lane: QueueLane, enqueueSeq: number, queue: ShadowQueueCandidate["queue"] = "main"): ShadowQueueCandidate {
  return { queue, lane, enqueueSeq, basePriority: 0, id: `${lane}-${enqueueSeq}` };
}

describe("read-only shadow WRR and runnable FIFO", () => {
  it("gives every runnable lane its weighted opportunities across repeated small drains", () => {
    const selector = new ShadowQueueSelector();
    let pending = QUEUE_LANES.flatMap((lane) => Array.from({ length: 100 }, (_, i) => candidate(lane, i + 1)));
    const totals = Object.fromEntries(QUEUE_LANES.map((lane) => [lane, 0])) as Record<QueueLane, number>;
    for (let drain = 0; drain < 9; drain += 1) {
      const { selected } = selector.select(pending, 4);
      expect(selected).toHaveLength(4);
      for (const item of selected) totals[item.lane] += 1;
      const identities = new Set(selected.map((item) => `${item.queue}:${item.id}`));
      pending = pending.filter((item) => !identities.has(`${item.queue}:${item.id}`));
    }
    // 36 selections span exactly three 12-slot weighted rounds.
    for (const lane of QUEUE_LANES) expect(totals[lane]).toBe(DEFAULT_LANE_WEIGHTS[lane] * 3);
  });

  it("uses stable enqueue order within a lane regardless of priority or source table", () => {
    const selector = new ShadowQueueSelector();
    const newer = { ...candidate("repair_retry", 30), basePriority: -100 };
    const oldRetry = candidate("repair_retry", 10, "embedding_retry");
    const middle = candidate("repair_retry", 20);
    expect(selector.select([newer, middle, oldRetry], 3).selected).toEqual([oldRetry, middle, newer]);
  });

  it("keeps evolution and retry progressing under a ten-thousand import backlog", () => {
    const selector = new ShadowQueueSelector();
    const imports = Array.from({ length: 10_000 }, (_, i) => candidate("import", i + 1));
    const retry = candidate("repair_retry", 10_001, "embedding_retry");
    const reflection = candidate("evolution", 10_002);
    const maintenance = candidate("maintenance", 10_003);
    const firstRound = selector.select([...imports, retry, reflection, maintenance], 12).selected;
    expect(firstRound).toEqual(expect.arrayContaining([retry, reflection, maintenance]));
    expect(firstRound).toHaveLength(12);
  });

  it("fills available slots by skipping empty lanes and accepts an already-filtered blocked head", () => {
    const selector = new ShadowQueueSelector();
    // The store omitted blocked seq 1; it can reappear later with its original sequence.
    const newer = candidate("maintenance", 2);
    expect(selector.select([newer], 4).selected).toEqual([newer]);
    const previouslyBlocked = candidate("maintenance", 1);
    expect(selector.select([candidate("maintenance", 3), previouslyBlocked], 4).selected[0]).toEqual(previouslyBlocked);
  });

  it("does not modify candidates, invoke jobs, or move the cursor for a zero-sized/empty preview", () => {
    const selector = new ShadowQueueSelector();
    const input = Object.freeze([
      Object.freeze(candidate("interactive", 2)), Object.freeze(candidate("interactive", 1))
    ]);
    expect(selector.select(input, 0).selected).toEqual([]);
    expect(selector.select([], 4).selected).toEqual([]);
    expect(selector.getCursor()).toBe(0);
    expect(selector.select(input, 2).selected.map((item) => item.enqueueSeq)).toEqual([1, 2]);
    expect(input.map((item) => item.enqueueSeq)).toEqual([2, 1]);
  });

  it("validates configuration and sequence identities instead of silently corrupting fairness", () => {
    expect(() => new ShadowQueueSelector({ ...DEFAULT_LANE_WEIGHTS, import: 0 })).toThrow(RangeError);
    expect(() => new ShadowQueueSelector({ ...DEFAULT_LANE_WEIGHTS, import: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    const selector = new ShadowQueueSelector();
    expect(() => selector.select([], -1)).toThrow(RangeError);
    expect(() => selector.select([candidate("import", 0)], 1)).toThrow(RangeError);
    const duplicate = candidate("import", 1);
    expect(() => selector.select([duplicate, duplicate], 2)).toThrow("Duplicate queue candidate");
  });
});
