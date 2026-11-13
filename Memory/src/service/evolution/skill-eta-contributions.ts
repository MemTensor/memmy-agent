import type { MemoryRow } from "../../types.js";
import { revisionInputHash } from "./episode-revision.js";
import { skillEtaAfterRewardDrift, skillEtaAfterTrial } from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";

export interface SkillEtaStats {
  eta: number;
  attempts: number;
  passes: number;
}

type EtaEvent =
  | { kind: "source"; id: string; magnitude: number | null }
  | { kind: "trial"; id: string; outcome: "success" | "failure" | null }
  | { kind: "checkpoint"; stats: SkillEtaStats; preserveCounts: boolean };

/** Current contributions only; revisions keep the original event position. */
export interface SkillEtaContributions {
  schemaVersion: 1;
  bodyRevision: string;
  baseline: SkillEtaStats;
  order: EtaEvent[];
  last: SkillEtaStats;
}

export function initialSkillEtaContributions(bodyRevision: string, baseline: SkillEtaStats): SkillEtaContributions {
  assertStats(baseline);
  return { schemaVersion: 1, bodyRevision, baseline: { ...baseline }, order: [], last: { ...baseline } };
}

/** Callers must identify a source operation, not merely the containing Policy. */
export function reviseSkillEtaSource(state: SkillEtaContributions, bodyRevision: string,
  id: string, magnitude: number | null, current: SkillEtaStats = state.last): SkillEtaContributions {
  if (magnitude !== null && !Number.isFinite(magnitude)) throw new Error("Invalid skill source magnitude");
  return reviseEvent(state, bodyRevision, { kind: "source", id, magnitude }, current);
}

/** Null withdraws a result without deleting its identity or original position. */
export function reviseSkillEtaTrial(state: SkillEtaContributions, bodyRevision: string,
  id: string, outcome: "success" | "failure" | null, current: SkillEtaStats = state.last): SkillEtaContributions {
  return reviseEvent(state, bodyRevision, { kind: "trial", id, outcome }, current);
}

/** Only use when the original crystallization baseline can be recomputed from recorded inputs. */
export function reviseSkillEtaBaseline(state: SkillEtaContributions, bodyRevision: string,
  baseline: SkillEtaStats, current: SkillEtaStats = state.last): SkillEtaContributions {
  assertStats(baseline);
  return replay({ ...captureCheckpoint(state, bodyRevision, current), baseline: { ...baseline } });
}

function reviseEvent(state: SkillEtaContributions, bodyRevision: string,
  event: Exclude<EtaEvent, { kind: "checkpoint" }>, current: SkillEtaStats): SkillEtaContributions {
  if (!event.id) throw new Error("Skill contribution requires a stable identity");
  const next = captureCheckpoint(state, bodyRevision, current);
  const index = next.order.findIndex(item => item.kind === event.kind && item.id === event.id);
  if (index < 0) next.order.push(event);
  else next.order[index] = event;
  return replay(next);
}

function captureCheckpoint(state: SkillEtaContributions, bodyRevision: string, current: SkillEtaStats): SkillEtaContributions {
  if (state.bodyRevision !== bodyRevision) throw new Error("Skill content changed; initialize a new contribution baseline");
  assertStats(current);
  const order = [...state.order];
  if (Math.abs(state.last.eta - current.eta) > 1e-12 || state.last.attempts !== current.attempts || state.last.passes !== current.passes) {
    // Preserve an unexplained/manual write exactly. Never reverse-engineer a trial or reward delta.
    order.push({ kind: "checkpoint", stats: { ...current },
      preserveCounts: state.last.attempts !== current.attempts || state.last.passes !== current.passes });
  }
  return { ...state, order };
}

function replay(state: SkillEtaContributions): SkillEtaContributions {
  let { eta, attempts, passes } = state.baseline;
  for (const event of state.order) {
    if (event.kind === "checkpoint") {
      eta = event.stats.eta;
      if (event.preserveCounts) ({ attempts, passes } = event.stats);
    } else if (event.kind === "source") {
      if (event.magnitude !== null) eta = skillEtaAfterRewardDrift({ currentEta: eta, magnitude: event.magnitude });
    } else if (event.outcome !== null) {
      const nextPasses = passes + (event.outcome === "success" ? 1 : 0);
      eta = skillEtaAfterTrial({ currentEta: eta, previousAttempts: attempts, previousPasses: passes,
        nextAttempts: attempts + 1, nextPasses });
      attempts++;
      passes = nextPasses;
    }
  }
  return { ...state, last: { eta, attempts, passes } };
}

function validStats(value: unknown): value is SkillEtaStats {
  return isRecord(value) && typeof value.eta === "number" && Number.isFinite(value.eta) && value.eta >= 0 && value.eta <= 1 &&
    typeof value.attempts === "number" && Number.isSafeInteger(value.attempts) && value.attempts >= 0 &&
    typeof value.passes === "number" && Number.isSafeInteger(value.passes) && value.passes >= 0 && value.passes <= value.attempts;
}
function assertStats(value: unknown): asserts value is SkillEtaStats {
  if (!validStats(value)) throw new Error("Invalid skill contribution statistics; preserve for review");
}

/** Unknown old experiments must not be silently treated as an empty ledger. */
export function readSkillEtaContributions(value: unknown): SkillEtaContributions | undefined {
  if (value === undefined) return undefined;
  const fail = () => { throw new Error("Unsupported skill contribution data; preserve for review"); };
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.bodyRevision !== "string" ||
    !validStats(value.baseline) || !validStats(value.last) || !Array.isArray(value.order)) return fail();
  const identities = new Set<string>();
  for (const event of value.order) {
    if (!isRecord(event)) return fail();
    if (event.kind === "checkpoint") { if (!validStats(event.stats) || typeof event.preserveCounts !== "boolean") return fail(); continue; }
    if (typeof event.id !== "string" || !event.id) return fail();
    const identity = JSON.stringify([event.kind, event.id]);
    if (identities.has(identity)) return fail();
    identities.add(identity);
    if (event.kind === "source") {
      if (event.magnitude !== null && (typeof event.magnitude !== "number" || !Number.isFinite(event.magnitude))) return fail();
    } else if (event.kind !== "trial" || !["success", "failure", null].includes(event.outcome as string | null)) return fail();
  }
  const result = value as unknown as SkillEtaContributions;
  const expected = replay(result).last;
  if (Math.abs(expected.eta - result.last.eta) > 1e-12 || expected.attempts !== result.last.attempts || expected.passes !== result.last.passes) return fail();
  return result;
}

/** A Policy-derived guide is versioned by its actual content; direct guides have an explicit revision. */
export function skillEtaBodyRevision(memory: MemoryRow): string {
  const data = memory.properties.internal_info.skill;
  return isRecord(data) && data.eta_policy_baseline !== undefined
    ? `policy:${revisionInputHash(memory.memoryValue)}` : `direct:${isRecord(data) ? data.content_revision : 1}`;
}
