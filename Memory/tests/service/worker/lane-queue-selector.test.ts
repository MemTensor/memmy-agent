import { describe, expect, it } from "vitest";
import { QUEUE_LANES, type QueueLane } from "../../../src/service/worker/job-policy-registry.js";
import {
  LaneQueueSelector, DEFAULT_LANE_WEIGHTS, validateLaneWeights, type LaneQueueCandidate
} from "../../../src/service/worker/lane-queue-selector.js";

function pool() {
  return QUEUE_LANES.flatMap((lane, laneIndex) => Array.from({ length: 20 }, (_, index) => ({
    queue: "main" as const, lane, enqueueSeq: laneIndex * 20 + index + 1,
    id: `${lane}-${index}`, basePriority: 0, extra: `business-${lane}`
  })));
}
function remove<T extends LaneQueueCandidate>(pending: readonly T[], selected: readonly T[]): T[] {
  const ids = new Set(selected.map(item => `${item.queue}:${item.id}`));
  return pending.filter(item => !ids.has(`${item.queue}:${item.id}`));
}

describe("production lane selection", () => {
  it("preserves a weighted round across single-choice drains and a restored cursor", () => {
    const first = new LaneQueueSelector();
    let pending = pool();
    const totals = Object.fromEntries(QUEUE_LANES.map(lane => [lane, 0])) as Record<QueueLane, number>;
    for (let round = 0; round < 12; round++) {
      const selector = new LaneQueueSelector(DEFAULT_LANE_WEIGHTS, first.getCursor());
      const selected = selector.select(pending, 1);
      first.setCursor(selected.nextCursor);
      totals[selected.selected[0]!.lane]++;
      pending = remove(pending, selected.selected);
    }
    expect(totals).toEqual(DEFAULT_LANE_WEIGHTS);
    expect(first.getCursor()).toBe(0);
  });

  it("allows a transaction preview without consuming the durable cursor position", () => {
    const selector = new LaneQueueSelector();
    const input = pool();
    const preview = selector.preview(input, 5);
    expect(preview.nextCursor).toBe(5);
    expect(selector.getCursor()).toBe(0);
    expect(selector.preview(input, 5)).toEqual(preview);
    const committed = selector.select(input, 5);
    expect(committed).toEqual(preview);
    expect(selector.getCursor()).toBe(5);
    expect(committed.selected[0]!.extra).toBe("business-interactive");
  });

  it("keeps an explicit non-advancing selection isolated from a later committed selection", () => {
    const selector = new LaneQueueSelector(DEFAULT_LANE_WEIGHTS, 4);
    expect(selector.select(pool(), 3, { advanceCursor: false }).selected.every(item => item.lane === "repair_retry")).toBe(true);
    expect(selector.getCursor()).toBe(4);
    selector.select(pool(), 1);
    expect(selector.getCursor()).toBe(5);
  });

  it("uses runnable FIFO across backing tables and skips absent lanes without reserving slots", () => {
    const selector = new LaneQueueSelector();
    const oldest = Object.freeze({ queue: "embedding_retry" as const, id: "old", lane: "repair_retry" as const, enqueueSeq: 1, basePriority: 100 });
    const newest = Object.freeze({ queue: "main" as const, id: "new", lane: "repair_retry" as const, enqueueSeq: 20, basePriority: -100 });
    const input = Object.freeze([newest, oldest]);
    expect(selector.select(input, 4).selected).toEqual([oldest, newest]);
    expect(input).toEqual([newest, oldest]);
    expect(selector.select([], 4).selected).toEqual([]);
  });

  it("normalizes persisted offsets after a weight change and rejects corrupt cursors", () => {
    const selector = new LaneQueueSelector(DEFAULT_LANE_WEIGHTS, 14);
    expect(selector.getCursor()).toBe(2);
    selector.setCursor(12);
    expect(selector.getCursor()).toBe(0);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => selector.setCursor(bad)).toThrow(RangeError);
  });

  it("detaches weights and requires exactly five positive integer weights", () => {
    const weights = { ...DEFAULT_LANE_WEIGHTS };
    const selector = new LaneQueueSelector(weights);
    weights.interactive = 1;
    expect(selector.select(pool(), 4).selected.every(item => item.lane === "interactive")).toBe(true);
    expect(Object.isFrozen(validateLaneWeights(DEFAULT_LANE_WEIGHTS))).toBe(true);
    for (const bad of [null, [], {}, { ...DEFAULT_LANE_WEIGHTS, extra: 1 },
      { ...DEFAULT_LANE_WEIGHTS, import: "2" }, { ...DEFAULT_LANE_WEIGHTS, import: 0 },
      { ...DEFAULT_LANE_WEIGHTS, import: 1025 }, { ...DEFAULT_LANE_WEIGHTS, import: Number.NaN }]) {
      expect(() => validateLaneWeights(bad)).toThrow();
    }
  });
});
