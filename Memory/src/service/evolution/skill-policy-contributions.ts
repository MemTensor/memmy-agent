import { skillEtaFromPolicy } from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";
import { policyGainSourceStages, replayPolicyContributions, type PolicyGainContributions } from "./episode-contributions.js";
import { initialSkillEtaContributions, reviseSkillEtaBaseline, reviseSkillEtaSource,
  type SkillEtaContributions, type SkillEtaStats } from "./skill-eta-contributions.js";

export interface SkillPolicyBaseline {
  schemaVersion: 1;
  policyId: string;
  policyRevision: number;
  through: number;
  minEta: number;
  minSupport: number;
}

function prefixStats(policy: PolicyGainContributions, through: number) {
  const prefix = { ...policy, order: policy.order.slice(0, through) };
  const ids = new Set(prefix.order.flatMap(event => event.kind === "sources" ? event.ids : []));
  return { gain: replayPolicyContributions(prefix).lastGain,
    support: [...ids].filter(id => policy.sources[id]!.supportValues.length > 0).length };
}

/** Seed only when the observed source ledger accounts for the actual crystallization inputs. */
export function seedPolicySkillEta(input: { bodyRevision: string; policyId: string; policyRevision: number;
  policy: PolicyGainContributions; gain: number; support: number; eta: number; minEta: number; minSupport: number }) {
  const stats = prefixStats(input.policy, input.policy.order.length);
  if (stats.support !== input.support || Math.abs(stats.gain - input.gain) > 1e-12 ||
    Math.abs(skillEtaFromPolicy({ ...stats, minEta: input.minEta, minSupport: input.minSupport }) - input.eta) > 1e-12) return undefined;
  const baseline: SkillPolicyBaseline = { schemaVersion: 1, policyId: input.policyId,
    policyRevision: input.policyRevision, through: input.policy.order.length, minEta: input.minEta, minSupport: input.minSupport };
  return { baseline, contributions: initialSkillEtaContributions(input.bodyRevision, { eta: input.eta, attempts: 0, passes: 0 }) };
}

/** Recompute the absorbed prefix; only later source events cause reward drift. */
export function revisePolicySkillEta(input: { state: SkillEtaContributions; baseline: SkillPolicyBaseline;
  bodyRevision: string; policyId: string; policyRevision: number; policy: PolicyGainContributions; current: SkillEtaStats }): SkillEtaContributions {
  const { baseline, policy } = input;
  if (baseline.policyId !== input.policyId || baseline.policyRevision !== input.policyRevision || baseline.through > policy.order.length) {
    throw new Error("Skill policy contribution boundary changed; preserve for review");
  }
  const stats = prefixStats(policy, baseline.through);
  let state = reviseSkillEtaBaseline(input.state, input.bodyRevision,
    { eta: skillEtaFromPolicy({ ...stats, minEta: baseline.minEta, minSupport: baseline.minSupport }), attempts: 0, passes: 0 }, input.current);
  for (const stage of policyGainSourceStages(policy)) {
    if (stage.position < baseline.through) continue;
    state = reviseSkillEtaSource(state, input.bodyRevision,
      JSON.stringify([input.policyId, input.policyRevision, stage.position]), stage.active ? stage.gain : null);
  }
  return state;
}

export function readSkillPolicyBaseline(value: unknown): SkillPolicyBaseline | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.policyId !== "string" || !value.policyId ||
    typeof value.policyRevision !== "number" || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1 ||
    typeof value.through !== "number" || !Number.isSafeInteger(value.through) || value.through < 0 ||
    typeof value.minEta !== "number" || !Number.isFinite(value.minEta) || value.minEta < 0 || value.minEta > 1 ||
    typeof value.minSupport !== "number" || !Number.isFinite(value.minSupport) || value.minSupport < 0) {
    throw new Error("Unsupported skill policy baseline; preserve for review");
  }
  return value as unknown as SkillPolicyBaseline;
}

/** The first observed update is one aggregate operation, not a replay of unobserved history. */
export interface SkillPolicyObservation {
  schemaVersion: 1;
  policyId: string;
  policyRevision: number;
  through: number;
}

export function reviseObservedPolicySkillEta(input: { state: SkillEtaContributions; observation?: SkillPolicyObservation;
  bodyRevision: string; policyId: string; policyRevision: number; policy: PolicyGainContributions; current: SkillEtaStats }) {
  const observation: SkillPolicyObservation = input.observation ?? { schemaVersion: 1, policyId: input.policyId,
    policyRevision: input.policyRevision, through: input.policy.order.length };
  if (observation.policyId !== input.policyId || observation.policyRevision !== input.policyRevision || observation.through > input.policy.order.length) {
    throw new Error("Observed skill policy boundary changed; preserve for review");
  }
  const prefix = prefixStats(input.policy, observation.through);
  let state = reviseSkillEtaSource(input.state, input.bodyRevision,
    JSON.stringify([input.policyId, input.policyRevision, "observed", observation.through]),
    prefix.support > 0 ? prefix.gain : null, input.current);
  for (const stage of policyGainSourceStages(input.policy)) {
    if (stage.position < observation.through) continue;
    state = reviseSkillEtaSource(state, input.bodyRevision,
      JSON.stringify([input.policyId, input.policyRevision, stage.position]), stage.active ? stage.gain : null);
  }
  return { state, observation };
}

export function readSkillPolicyObservations(value: unknown): Record<string, SkillPolicyObservation> {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.entries(value).every(([id, item]) => isRecord(item) && item.schemaVersion === 1 && item.policyId === id &&
    typeof item.policyRevision === "number" && Number.isSafeInteger(item.policyRevision) && item.policyRevision > 0 &&
    typeof item.through === "number" && Number.isSafeInteger(item.through) && item.through >= 0)) {
    throw new Error("Unsupported skill policy observations; preserve for review");
  }
  return value as unknown as Record<string, SkillPolicyObservation>;
}
