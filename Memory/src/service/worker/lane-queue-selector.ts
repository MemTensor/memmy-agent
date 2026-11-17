import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";

/** User-confirmed starting weights, shared by production and shadow selection. */
export const DEFAULT_LANE_WEIGHTS: Readonly<Record<QueueLane, number>> = Object.freeze({
  interactive: 4,
  repair_retry: 3,
  import: 2,
  evolution: 2,
  maintenance: 1
});

export interface LaneQueueCandidate {
  queue: "main" | "embedding_retry";
  id: string;
  lane: QueueLane;
  enqueueSeq: number;
  basePriority: number;
}

export interface LaneQueueSelection<T extends LaneQueueCandidate = LaneQueueCandidate> {
  selected: readonly T[];
  nextCursor: number;
  algorithm: "wrr_runnable_fifo";
  weights: Readonly<Record<QueueLane, number>>;
}

/** Validate all five lanes, returning a detached immutable configuration. */
export function validateLaneWeights(weights: unknown): Readonly<Record<QueueLane, number>> {
  if (weights === null || typeof weights !== "object" || Array.isArray(weights)) {
    throw new TypeError("Lane weights must be an object containing every registered lane");
  }
  for (const key of Object.keys(weights)) {
    if (!(QUEUE_LANES as readonly string[]).includes(key)) throw new RangeError(`Unknown lane weight: ${key}`);
  }
  const normalized = {} as Record<QueueLane, number>;
  for (const lane of QUEUE_LANES) {
    const weight = (weights as Record<string, unknown>)[lane];
    if (!Object.hasOwn(weights, lane) || typeof weight !== "number" ||
      !Number.isSafeInteger(weight) || weight < 1 || weight > 1_024) {
      throw new RangeError(`Invalid lane weight for ${lane}`);
    }
    normalized[lane] = weight;
  }
  return Object.freeze(normalized);
}

/**
 * Pure selection shared by production and shadow execution. Candidates must
 * already pass readiness checks; claims and durable cursor commits belong to
 * the caller's transaction. No input records are modified.
 */
export class LaneQueueSelector {
  private readonly schedule: readonly QueueLane[];
  private readonly weights: Readonly<Record<QueueLane, number>>;
  private cursor = 0;

  constructor(weights: Readonly<Record<QueueLane, number>> = DEFAULT_LANE_WEIGHTS, initialCursor = 0) {
    this.weights = validateLaneWeights(weights);
    const schedule: QueueLane[] = [];
    for (const lane of QUEUE_LANES) {
      const weight = this.weights[lane];
      schedule.push(...Array<QueueLane>(weight).fill(lane));
    }
    this.schedule = Object.freeze(schedule);
    this.setCursor(initialCursor);
  }

  getCursor(): number {
    return this.cursor;
  }

  /** Accept persisted cursors after a weight change by normalizing the offset. */
  setCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError(`Invalid queue cursor: ${cursor}`);
    this.cursor = cursor % this.schedule.length;
  }

  preview<T extends LaneQueueCandidate>(candidates: readonly T[], limit: number): LaneQueueSelection<T> {
    return this.select(candidates, limit, { advanceCursor: false });
  }

  select<T extends LaneQueueCandidate>(
    candidates: readonly T[], limit: number, options: { advanceCursor?: boolean } = {}
  ): LaneQueueSelection<T> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`Invalid queue selection limit: ${limit}`);
    const buckets = new Map<QueueLane, T[]>(QUEUE_LANES.map((lane) => [lane, []]));
    const identities = new Set<string>();
    for (const candidate of candidates) {
      const bucket = buckets.get(candidate.lane);
      if (!bucket) throw new Error(`Unknown queue candidate lane: ${candidate.lane}`);
      if (!Number.isSafeInteger(candidate.enqueueSeq) || candidate.enqueueSeq < 1) {
        throw new RangeError(`Invalid enqueue sequence for queue candidate: ${candidate.id}`);
      }
      const identity = `${candidate.queue}:${candidate.id}`;
      if (identities.has(identity)) throw new Error(`Duplicate queue candidate: ${identity}`);
      identities.add(identity);
      bucket.push(candidate);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.enqueueSeq - b.enqueueSeq ||
        a.queue.localeCompare(b.queue) || a.id.localeCompare(b.id));
    }

    const offsets = new Map<QueueLane, number>();
    const selected: T[] = [];
    let nextCursor = this.cursor;
    while (selected.length < Math.min(limit, candidates.length)) {
      let found = false;
      // Empty/blocked lanes never consume execution capacity. A full schedule
      // traversal without a candidate means the available input is exhausted.
      for (let scanned = 0; scanned < this.schedule.length; scanned += 1) {
        const lane = this.schedule[nextCursor]!;
        nextCursor = (nextCursor + 1) % this.schedule.length;
        const offset = offsets.get(lane) ?? 0;
        const candidate = buckets.get(lane)![offset];
        if (!candidate) continue;
        selected.push(candidate);
        offsets.set(lane, offset + 1);
        found = true;
        break;
      }
      if (!found) break;
    }
    if (options.advanceCursor !== false) this.cursor = nextCursor;
    return Object.freeze({
      selected: Object.freeze(selected), nextCursor,
      algorithm: "wrr_runnable_fifo", weights: this.weights
    });
  }
}
