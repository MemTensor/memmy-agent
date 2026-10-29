import { describe, expect, it } from "vitest";
import { AdmissionLaneQueueSelector } from "../../../src/service/worker/admission-lane-queue-selector.js";
import { DEFAULT_LANE_WEIGHTS, type LaneQueueCandidate } from "../../../src/service/worker/lane-queue-selector.js";
import { QUEUE_LANES, type QueueLane } from "../../../src/service/worker/job-policy-registry.js";

function candidate(lane: QueueLane, enqueueSeq = 1): LaneQueueCandidate {
  return { queue: "main", id: `${lane}-${enqueueSeq}`, lane, enqueueSeq, basePriority: 0 };
}
function claim(selector: AdmissionLaneQueueSelector, available: QueueLane[], blocked: QueueLane[] = [], interactive = false): QueueLane | undefined {
  const pool = available.map((lane, i) => candidate(lane, i + 1));
  selector.dropEmpty(new Set(QUEUE_LANES.filter(lane => !available.includes(lane))));
  while (pool.length) {
    const item = (interactive ? selector.chooseInteractive(pool) : undefined) ?? selector.choose(pool)!;
    pool.splice(pool.indexOf(item), 1);
    if (blocked.includes(item.lane)) continue;
    selector.commit(item.lane);
    return item.lane;
  }
  return undefined;
}

describe("admission-aware weighted lane turns", () => {
  it("keeps the original weighted sequence without resource contention", () => {
    const selector = new AdmissionLaneQueueSelector();
    const sequence = Array.from({ length: 24 }, () => claim(selector, [...QUEUE_LANES]));
    const round = QUEUE_LANES.flatMap(lane => Array<QueueLane>(DEFAULT_LANE_WEIGHTS[lane]).fill(lane));
    expect(sequence).toEqual([...round, ...round]);
    expect(selector.getCursor()).toBe(0);
  });

  it.each([false, true])("preserves model opportunities across fast DB work with another permanently blocked Provider: %s", hasBlockedProvider => {
    const selector = new AdmissionLaneQueueSelector();
    const available: QueueLane[] = [...(hasBlockedProvider ? ["interactive"] as const : []), "import", "evolution", "maintenance"];
    const permanentlyBlocked: QueueLane[] = hasBlockedProvider ? ["interactive"] : [];
    const sequence: QueueLane[] = [];
    for (let done = 0; done < 100; done++) {
      const served = claim(selector, available, permanentlyBlocked)!;
      if (served !== "maintenance") sequence.push(served);
      for (let tick = 0; tick < 10; tick++) expect(claim(selector, available,
        [...permanentlyBlocked, "import", "evolution"])).toBe("maintenance");
    }
    expect(sequence).toHaveLength(100);
    expect(sequence.filter(lane => lane === "import")).toHaveLength(50);
    expect(sequence.filter(lane => lane === "evolution")).toHaveLength(50);
  });

  it("restores remaining turns and consumes no opportunity for preview or a failed CAS", () => {
    const selector = new AdmissionLaneQueueSelector();
    claim(selector, [...QUEUE_LANES]);
    const saved = selector.snapshot();
    const restored = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, selector.getCursor(), saved);
    const before = restored.snapshot();
    expect(restored.choose([candidate("interactive")])?.lane).toBe("interactive");
    expect(restored.snapshot()).toEqual(before);
    expect(Array.from({ length: 4 }, () => claim(restored, [...QUEUE_LANES]))).toEqual([
      "interactive", "interactive", "interactive", "repair_retry"
    ]);
    expect(saved.lanes[0]?.remaining).toBe(3);
  });

  it("gives a previously empty interactive lane a bounded turn without accumulating historical debt", () => {
    const selector = new AdmissionLaneQueueSelector();
    for (let i = 0; i < 1000; i++) claim(selector, ["import", "evolution", "maintenance"]);
    const sequence = Array.from({ length: 24 }, () => claim(selector, [...QUEUE_LANES]));
    expect(sequence.slice(0, 12)).toContain("interactive");
    expect(sequence.filter(lane => lane === "interactive")).toHaveLength(8);
    expect(selector.snapshot().lanes.every(turn => turn.remaining <= DEFAULT_LANE_WEIGHTS[turn.lane])).toBe(true);
  });

  it("keeps an empty lane skip tentative until a successful claim confirms it", () => {
    const selector = new AdmissionLaneQueueSelector();
    const before = selector.snapshot();
    selector.dropEmpty(new Set(["interactive", "repair_retry"]));
    expect(selector.choose([candidate("import")])?.lane).toBe("import");
    expect(selector.snapshot()).toEqual(before);
    selector.dropEmpty(new Set(["repair_retry"]));
    expect(selector.choose([candidate("interactive"), candidate("import")])?.lane).toBe("interactive");
    selector.commit("interactive");
    expect(selector.getCursor()).toBe(1);
  });

  it("sanitizes old or malformed optional state using the old cursor", () => {
    for (const state of [undefined, null, {}, { version: 2, lanes: [] }, { version: 1, lanes: [] },
      { version: 1, lanes: QUEUE_LANES.map(lane => ({ lane, remaining: 0 })) },
      { version: 1, lanes: QUEUE_LANES.map(() => ({ lane: "import", remaining: 1 })) }]) {
      const selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 8, state);
      expect(Array.from({ length: 3 }, () => claim(selector, [...QUEUE_LANES]))).toEqual(["import", "evolution", "evolution"]);
    }
  });

  it("keeps FIFO across backing tables, validates duplicates and leaves input untouched", () => {
    const selector = new AdmissionLaneQueueSelector();
    const old = Object.freeze({ ...candidate("repair_retry", 1), queue: "embedding_retry" as const });
    const newer = Object.freeze(candidate("repair_retry", 2));
    const input = Object.freeze([newer, old]);
    expect(selector.choose(input)).toBe(old);
    expect(input).toEqual([newer, old]);
    expect(() => selector.choose([old, old])).toThrow(/Duplicate/);
  });

  it("restores the bounded aging round and sanitizes malformed optional aging state", () => {
    const selector = new AdmissionLaneQueueSelector();
    selector.commit("evolution", true);
    const saved = selector.snapshot();
    const aged = { ...candidate("maintenance"), firstQueuedAt: "2026-10-22T00:00:00.000Z" };
    const now = Date.parse("2026-10-23T00:00:00.000Z");
    expect(new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 0, saved).chooseAged([aged], now, 300_000)).toBeUndefined();
    for (const aging of [undefined, null, [], {}, { servedMask: -1, used: true },
      { servedMask: 32, used: true }, { servedMask: 0, used: "true" }]) {
      const restored = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 0, { ...saved, aging });
      expect(restored.chooseAged([aged], now, 300_000)).toBe(aged);
      expect(restored.snapshot().lanes).toEqual(saved.lanes);
    }
    saved.aging!.used = false;
    expect(selector.snapshot().aging?.used).toBe(true);
  });

  it("does not advance a lane that already consumed its complete turn this round", () => {
    const selector = new AdmissionLaneQueueSelector();
    selector.commit("maintenance");
    const aged = { ...candidate("maintenance"), firstQueuedAt: "2026-10-22T00:00:00.000Z" };
    expect(selector.chooseAged([aged], Date.parse("2026-10-23T00:00:00.000Z"), 300_000)).toBeUndefined();
    expect(() => selector.commit("maintenance", true)).toThrow(/unspent/);
  });

  it("applies the same metadata validation to aging and ordinary selection", () => {
    const selector = new AdmissionLaneQueueSelector();
    const old = { ...candidate("evolution"), firstQueuedAt: "2026-10-22T00:00:00.000Z" };
    const now = Date.parse("2026-10-23T00:00:00.000Z");
    expect(() => selector.chooseAged([old, old], now, 300_000)).toThrow(/Duplicate/);
    expect(() => selector.chooseAged([{ ...old, enqueueSeq: 0 }], now, 300_000)).toThrow(/Invalid enqueue/);
  });

  it("prefers unspent interactive tickets after an empty skip while retaining complete weighted rounds", () => {
    const selector = new AdmissionLaneQueueSelector();
    expect(claim(selector, ["import", "evolution", "maintenance"], [], true)).toBe("import");
    expect(selector.snapshot().aging!.servedMask & 1).toBe(1);
    expect(claim(selector, [...QUEUE_LANES], [], true)).toBe("interactive");
    const steady = new AdmissionLaneQueueSelector();
    const sequence = Array.from({ length: 36 }, () => claim(steady, [...QUEUE_LANES], [], true));
    const expected = QUEUE_LANES.flatMap(lane => Array<QueueLane>(DEFAULT_LANE_WEIGHTS[lane]).fill(lane));
    expect(sequence).toEqual([...expected, ...expected, ...expected]);
  });

  it("does not refresh spent interactive tickets on restart, repeated previews or fast unrelated work", () => {
    let selector = new AdmissionLaneQueueSelector();
    for (let i = 0; i < 4; i++) expect(claim(selector, [...QUEUE_LANES], [], true)).toBe("interactive");
    expect(selector.snapshot().interactive?.spent).toBe(true);
    selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, selector.getCursor(), selector.snapshot());
    const before = selector.snapshot();
    for (let i = 0; i < 20; i++) expect(selector.chooseInteractive([candidate("interactive")])).toBeUndefined();
    expect(selector.snapshot()).toEqual(before);
    for (let i = 0; i < 100; i++) expect(claim(selector, [...QUEUE_LANES],
      ["interactive", "repair_retry", "import", "evolution"], true)).toBe("maintenance");
    expect(selector.chooseInteractive([candidate("interactive")])).toBeUndefined();
    // Ordinary WRR must also honor the older unfulfilled model opportunities.
    expect(claim(selector, [...QUEUE_LANES], [], true)).toBe("repair_retry");
  });

  it.each([4, 5, 6, 7, 8, 9, 10, 11])("advances exactly one existing ticket when upgrading old cursor %s", cursor => {
    let selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, cursor);
    const item = candidate("interactive");
    expect(selector.chooseInteractive([item])).toBe(item);
    const preview = selector.snapshot();
    // A lost CAS or aborted transaction discards the selector without commit.
    selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, cursor);
    expect(selector.snapshot()).toEqual(preview);
    selector.commit("interactive");
    expect(selector.snapshot().lanes.find(turn => turn.lane === "interactive")?.remaining).toBe(3);
    const restored = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, selector.getCursor(), selector.snapshot());
    expect(restored.chooseInteractive([item])).toBeUndefined();
    expect(restored.choose([...QUEUE_LANES].map(lane => candidate(lane)))?.lane).not.toBe("interactive");
  });

  it.each([0, 1, 2, 3])("uses only the current remaining quota in old interactive cursor segment %s", cursor => {
    const selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, cursor), item = candidate("interactive");
    expect(selector.snapshot().interactive?.upgradeAdvance).toBe(false);
    for (let i = 0; i < 4 - cursor; i++) { expect(selector.chooseInteractive([item])).toBe(item); selector.commit("interactive"); }
    expect(selector.chooseInteractive([item])).toBeUndefined();
  });

  it("distinguishes old turns from explicit new state and never regenerates a consumed upgrade advance", () => {
    const lanes = ["import", "evolution", "maintenance", "interactive", "repair_retry"] as QueueLane[];
    const old = { version: 1, lanes: lanes.map(lane => ({ lane, remaining: DEFAULT_LANE_WEIGHTS[lane] })),
      aging: { servedMask: 3, used: false } };
    const item = candidate("interactive");
    const selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 7, old);
    expect(selector.chooseInteractive([item])).toBe(item);
    selector.commit("interactive");
    const spent = selector.snapshot();
    for (let restart = 0; restart < 20; restart++) {
      const restored = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, selector.getCursor(), spent);
      expect(restored.chooseInteractive([item])).toBeUndefined();
    }
    expect(new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 7,
      { ...old, interactive: { spent: true } }).chooseInteractive([item])).toBeUndefined();
    const empty = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, 7,
      { ...old, interactive: { spent: false } });
    for (let i = 0; i < 4; i++) { expect(empty.chooseInteractive([item])).toBe(item); empty.commit("interactive"); }
    expect(empty.chooseInteractive([item])).toBeUndefined();
  });

  it.each([4, 7, 9, 11])("retains every lane's long-term weighted share after one upgrade advance at cursor %s", cursor => {
    const selector = new AdmissionLaneQueueSelector(DEFAULT_LANE_WEIGHTS, cursor);
    const sequence = Array.from({ length: 144 }, () => claim(selector, [...QUEUE_LANES], [], true));
    const steady = sequence.slice(-120);
    for (const lane of QUEUE_LANES) expect(steady.filter(value => value === lane)).toHaveLength(DEFAULT_LANE_WEIGHTS[lane] * 10);
  });
});
