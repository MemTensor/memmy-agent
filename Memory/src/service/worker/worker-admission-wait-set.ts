import type { SchedulingCandidate } from "../../storage/queue-scheduling-store.js";
import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";

type Entry = { candidate: SchedulingCandidate; group: { ready: boolean } };
type BlockedGroup = { ready: boolean; root?: Node };
type Node = { entry: Entry; child?: Node; sibling?: Node };
const keyOf = (candidate: SchedulingCandidate) => `${candidate.queue}:${candidate.id}:${candidate.enqueueSeq}`;
function before(a: Node, b: Node): boolean {
  const x = a.entry.candidate, y = b.entry.candidate;
  return x.enqueueSeq < y.enqueueSeq || (x.enqueueSeq === y.enqueueSeq &&
    (x.queue.localeCompare(y.queue) || x.id.localeCompare(y.id)) < 0);
}
/** A meldable min-heap: releasing a resource moves its waiters in O(1),
 * without walking a large backlog in the resource-release callback. */
function meld(a: Node | undefined, b: Node | undefined): Node | undefined {
  if (!a) return b;
  if (!b) return a;
  if (before(b, a)) [a, b] = [b, a];
  b.sibling = a.child; a.child = b;
  return a;
}
function pop(root: Node): Node | undefined {
  const pairs: Node[] = [];
  let child = root.child;
  while (child) {
    const a = child, b = a.sibling;
    child = b?.sibling;
    a.sibling = undefined;
    if (b) b.sibling = undefined;
    pairs.push(meld(a, b)!);
  }
  let next: Node | undefined;
  for (let i = pairs.length - 1; i >= 0; i--) next = meld(pairs[i], next);
  return next;
}

/** Drain-local references only; SQLite remains authoritative for eligibility and
 * lease CAS. Waiting never changes the persisted enqueue sequence or owns permits. */
export class WorkerAdmissionWaitSet {
  private readonly entries = new Map<string, Entry>();
  private readonly blocked = new Map<string, Map<QueueLane, BlockedGroup>>();
  private readonly ready = new Map<QueueLane, Node | undefined>();

  private pruning?: Generator<{ resource: string; lane: QueueLane; lanes: Map<QueueLane, BlockedGroup>; group: BlockedGroup }>;
  private *pruneGroups() {
    for (const [resource, lanes] of this.blocked) for (const [lane, group] of lanes) yield { resource, lanes, lane, group };
  }

  get size(): number { return this.entries.size; }
  /** Finish this bounded sweep before sleeping; a completed sweep stays idle
   * until the next refill/wake initiates another one. */
  get hasPendingPrune(): boolean { return this.pruning !== undefined; }
  clear(): void { this.entries.clear(); this.blocked.clear(); this.ready.clear(); this.pruning = undefined; }
  isBlocked(candidate: SchedulingCandidate): boolean {
    const entry = this.entries.get(keyOf(candidate));
    return entry !== undefined && !entry.group.ready;
  }
  park(candidate: SchedulingCandidate, resource: string): void {
    if (this.entries.has(keyOf(candidate))) return;
    let lanes = this.blocked.get(resource);
    if (!lanes) { lanes = new Map(); this.blocked.set(resource, lanes); }
    let group = lanes.get(candidate.lane);
    if (!group) { group = { ready: false }; lanes.set(candidate.lane, group); }
    const entry = { candidate, group };
    this.entries.set(keyOf(candidate), entry);
    group.root = meld(group.root, { entry });
  }
  release(resources: readonly string[]): Set<QueueLane> {
    const lanes = new Set<QueueLane>();
    for (const resource of resources) {
      const groups = this.blocked.get(resource);
      if (!groups) continue;
      this.blocked.delete(resource);
      for (const [lane, group] of groups) {
        group.ready = true;
        this.ready.set(lane, meld(this.ready.get(lane), group.root));
        group.root = undefined;
        lanes.add(lane);
      }
    }
    return lanes;
  }
  /** Probe only heap heads, never walk the stable blocked backlog on a refill.
   * Terminal/deleted entries are removed in bounded slices. */
  pruneHeads(isPending: (candidate: SchedulingCandidate) => boolean, limit: number,
    isReady?: (candidate: SchedulingCandidate, resource: string) => boolean): number {
    let removed = 0, checked = 0;
    this.pruning ??= this.pruneGroups();
    while (checked < limit) {
      const next = this.pruning.next();
      if (next.done) { this.pruning = undefined; break; }
      const { resource, lane, lanes, group } = next.value;
      if (group.ready || !group.root) continue;
      while (group.root && checked < limit) {
        checked++;
        if (isPending(group.root.entry.candidate)) {
          if (isReady?.(group.root.entry.candidate, resource)) this.release([resource]);
          break;
        }
        const root = group.root;
        this.entries.delete(keyOf(root.entry.candidate));
        group.root = pop(root); removed++;
      }
      if (!group.root) lanes.delete(lane);
      if (!lanes.size) this.blocked.delete(resource);
      // Restart at this resource next slice after a full batch of removals.
      if (removed === limit) { this.pruning = undefined; break; }
    }
    return removed;
  }
  heads(): SchedulingCandidate[] {
    return QUEUE_LANES.flatMap(lane => {
      const root = this.ready.get(lane);
      return root ? [root.entry.candidate] : [];
    });
  }
  take(candidate: SchedulingCandidate): void {
    const root = this.ready.get(candidate.lane);
    if (!root || keyOf(root.entry.candidate) !== keyOf(candidate)) return;
    this.ready.set(candidate.lane, pop(root));
    this.entries.delete(keyOf(candidate));
  }
}
