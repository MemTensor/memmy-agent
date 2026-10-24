import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";
import { DEFAULT_LANE_WEIGHTS, LaneQueueSelector, validateLaneWeights, type LaneQueueCandidate } from "./lane-queue-selector.js";

export interface LaneQueueTurns {
  version: 1;
  aging?: { servedMask: number; used: boolean };
  interactive?: { spent: boolean; upgradeAdvance?: boolean };
  lanes: ReadonlyArray<{ lane: QueueLane; remaining: number }>;
}

/**
 * WRR turns survive admission refusals. Only an exhausted successful lane moves
 * to the tail: unrelated fast work cannot reset an older blocked lane's turn.
 * There is one bounded turn per lane, never a credit per rejected job.
 */
export class AdmissionLaneQueueSelector {
  private readonly weights: Readonly<Record<QueueLane, number>>;
  private turns: Array<{ lane: QueueLane; remaining: number }>;
  private cursor: number;
  private empty = new Set<QueueLane>();
  private aging = { servedMask: 0, used: false };
  private interactiveSpent = false;
  private upgradeAdvance = false;

  constructor(weights = DEFAULT_LANE_WEIGHTS, initialCursor = 0, savedTurns?: unknown) {
    this.weights = validateLaneWeights(weights);
    this.cursor = new LaneQueueSelector(this.weights, initialCursor).getCursor();
    let offset = this.cursor, first = 0;
    while (offset >= this.weights[QUEUE_LANES[first]!]) {
      offset -= this.weights[QUEUE_LANES[first]!]!;
      first++;
    }
    // Old cursor-only state past the interactive segment cannot mint a fresh
    // quota. It may advance one existing ticket once during upgrade. New state
    // distinguishes an empty skip from four actually consumed tickets.
    this.interactiveSpent = first !== 0;
    this.upgradeAdvance = this.interactiveSpent && savedTurns === undefined;
    this.turns = QUEUE_LANES.map((_, i) => {
      const lane = QUEUE_LANES[(first + i) % QUEUE_LANES.length]!;
      return { lane, remaining: this.weights[lane] - (i === 0 ? offset : 0) };
    });
    // The extension is optional under the existing KV key. Old releases and
    // malformed/unknown versions safely resume from the compatible cursor.
    if (savedTurns === null || typeof savedTurns !== "object" || Array.isArray(savedTurns)) return;
    const saved = savedTurns as { version?: unknown; lanes?: unknown; aging?: unknown; interactive?: unknown };
    if (saved.version !== 1 || !Array.isArray(saved.lanes) || saved.lanes.length !== QUEUE_LANES.length) return;
    const restored: typeof this.turns = [], seen = new Set<string>();
    for (const value of saved.lanes) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const { lane, remaining } = value as { lane?: unknown; remaining?: unknown };
      if (typeof lane !== "string" || !(QUEUE_LANES as readonly string[]).includes(lane) || seen.has(lane) ||
        typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > this.weights[lane as QueueLane]) return;
      seen.add(lane); restored.push({ lane: lane as QueueLane, remaining });
    }
    this.turns = restored;
    this.upgradeAdvance = this.interactiveSpent && saved.interactive === undefined;
    if (saved.interactive && typeof saved.interactive === "object" && !Array.isArray(saved.interactive) &&
      typeof (saved.interactive as { spent?: unknown }).spent === "boolean") {
      this.interactiveSpent = (saved.interactive as { spent: boolean }).spent;
      this.upgradeAdvance = (saved.interactive as { upgradeAdvance?: unknown }).upgradeAdvance === true;
    }
    if (saved.aging && typeof saved.aging === "object" && !Array.isArray(saved.aging)) {
      const state = saved.aging as { servedMask?: unknown; used?: unknown };
      if (typeof state.servedMask === "number" && Number.isSafeInteger(state.servedMask) && state.servedMask >= 0 &&
        state.servedMask < (1 << QUEUE_LANES.length) && typeof state.used === "boolean") {
        this.aging = { servedMask: state.servedMask, used: state.used };
      }
    }
  }

  getCursor(): number { return this.cursor; }

  snapshot(): LaneQueueTurns {
    return { version: 1, lanes: this.turns.map(turn => ({ ...turn })), aging: { ...this.aging },
      interactive: { spent: this.interactiveSpent, upgradeAdvance: this.upgradeAdvance } };
  }

  /** Only lanes proven to have no eligible row, not resource-denied lanes. */
  dropEmpty(empty: ReadonlySet<QueueLane>): void {
    // Skipping an empty lane is tentative until some other lane really claims
    // a job. A later slice may receive new interactive work before any CAS wins.
    this.empty = new Set(empty);
  }

  choose<T extends LaneQueueCandidate>(candidates: readonly T[]): T | undefined {
    const heads = this.heads(candidates);
    for (const turn of this.turns) {
      const head = heads.get(turn.lane);
      if (head) return head;
    }
    return undefined;
  }

  /** Prefer already assigned interactive tickets. Old ambiguous state may
   * advance one ticket from the next turn once, never a newly minted quota. */
  chooseInteractive<T extends LaneQueueCandidate>(candidates: readonly T[]): T | undefined {
    return this.interactiveSpent && !this.upgradeAdvance ? undefined : this.heads(candidates).get("interactive");
  }

  private heads<T extends LaneQueueCandidate>(candidates: readonly T[]): Map<QueueLane, T> {
    const heads = new Map<QueueLane, T>(), seen = new Set<string>();
    for (const candidate of candidates) {
      if (!(QUEUE_LANES as readonly string[]).includes(candidate.lane)) throw new Error(`Unknown queue candidate lane: ${candidate.lane}`);
      if (!Number.isSafeInteger(candidate.enqueueSeq) || candidate.enqueueSeq < 1) throw new RangeError(`Invalid enqueue sequence for queue candidate: ${candidate.id}`);
      const key = `${candidate.queue}:${candidate.id}`;
      if (seen.has(key)) throw new Error(`Duplicate queue candidate: ${key}`);
      seen.add(key);
      const head = heads.get(candidate.lane);
      if (!head || candidate.enqueueSeq < head.enqueueSeq || (candidate.enqueueSeq === head.enqueueSeq &&
        (candidate.queue.localeCompare(head.queue) || candidate.id.localeCompare(head.id)) < 0)) heads.set(candidate.lane, candidate);
    }
    return heads;
  }

  /** One FIFO head may spend an already assigned ticket earlier in this round. */
  chooseAged<T extends LaneQueueCandidate & { firstQueuedAt?: string | null }>(
    candidates: readonly T[], nowMs: number, thresholdMs: number, excluded: ReadonlySet<QueueLane> = new Set()
  ): T | undefined {
    if (this.aging.used || !Number.isFinite(nowMs)) return undefined;
    const heads = this.heads(candidates);
    return [...heads.values()].filter(candidate => !excluded.has(candidate.lane) &&
      !(this.aging.servedMask & (1 << QUEUE_LANES.indexOf(candidate.lane))) &&
      candidate.firstQueuedAt && Date.parse(candidate.firstQueuedAt) <= nowMs - thresholdMs)
      .sort((a, b) => Date.parse(a.firstQueuedAt!) - Date.parse(b.firstQueuedAt!) || a.enqueueSeq - b.enqueueSeq)[0];
  }

  /** Call only after a successful lease CAS; a rejection/rollback consumes nothing. */
  commit(lane: QueueLane, promoted = false): void {
    const index = this.turns.findIndex(turn => turn.lane === lane);
    if (index < 0) throw new Error(`Unknown queue lane: ${lane}`);
    if (promoted && (this.aging.used || this.aging.servedMask & (1 << QUEUE_LANES.indexOf(lane)))) {
      throw new Error("Aging may only advance one unspent lane ticket per round");
    }
    if (promoted) this.aging.used = true;
    if (lane === "interactive" && this.upgradeAdvance) {
      // Old releases did not distinguish an empty skip from a spent quota.
      // Advance one ticket from the existing turn, not a fresh four-ticket
      // quota. Persist the consumed flag with the successful lease CAS.
      this.upgradeAdvance = false;
      if (this.interactiveSpent) this.aging.servedMask |= 1;
    }
    for (const empty of this.empty) this.aging.servedMask |= 1 << QUEUE_LANES.indexOf(empty);
    const skipped = this.turns.slice(0, index).filter(turn => this.empty.has(turn.lane));
    this.turns = [...this.turns.filter(turn => !skipped.includes(turn)),
      ...skipped.map(turn => ({ lane: turn.lane, remaining: this.weights[turn.lane] }))];
    const turn = this.turns.find(item => item.lane === lane)!;
    const start = QUEUE_LANES.slice(0, QUEUE_LANES.indexOf(lane)).reduce((sum, item) => sum + this.weights[item], 0);
    const size = QUEUE_LANES.reduce((sum, item) => sum + this.weights[item], 0);
    turn.remaining--;
    this.cursor = (start + this.weights[lane] - turn.remaining) % size;
    if (turn.remaining === 0) {
      if (lane === "interactive") this.interactiveSpent = true;
      this.aging.servedMask |= 1 << QUEUE_LANES.indexOf(lane);
      this.turns.splice(this.turns.indexOf(turn), 1);
      this.turns.push({ lane, remaining: this.weights[lane] });
    }
    if (this.aging.servedMask === (1 << QUEUE_LANES.length) - 1) {
      this.aging = { servedMask: 0, used: false };
      this.interactiveSpent = false;
      this.upgradeAdvance = false;
    }
  }
}
