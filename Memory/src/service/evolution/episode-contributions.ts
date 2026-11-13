import { isRecord } from "../../utils/json.js";
import { computePolicyGainFromValues, smoothPolicyGain } from "../../algorithm/plugin-algorithms.js";

export interface PolicySourceValues {
  id: string;
  supportValues: number[];
  referenceValues: number[];
}

type GainEvent =
  | { kind: "sources"; ids: string[]; supportingIds: string[] }
  | { kind: "feedback"; id: string }
  | { kind: "checkpoint"; value: number };

/** One current value set per source, and one introduction per source in the ordered stream. */
export interface PolicyGainContributions {
  schemaVersion: 1;
  baselineGain: number;
  baselineSupport: number;
  sources: Record<string, PolicySourceValues>;
  feedback: Record<string, number>;
  order: GainEvent[];
  alpha: number;
  tau: number;
  lastGain: number;
  lastRawGain: number;
}

export function initialPolicyContributions(gain: number, support: number, alpha: number, tau: number): PolicyGainContributions {
  return { schemaVersion: 1, baselineGain: gain, baselineSupport: support, sources: {}, feedback: {},
    order: [], alpha, tau, lastGain: gain, lastRawGain: gain };
}

/** Revisions retain their original position. Absent sources are withdrawn, not re-introduced. */
export function revisePolicySources(state: PolicyGainContributions, sources: PolicySourceValues[],
  currentGain: number, alpha = state.alpha, tau = state.tau): PolicyGainContributions {
  const order = [...state.order];
  // An unrecorded write is a manual/legacy checkpoint; never guess that it was a feedback delta.
  if (Math.abs(currentGain - state.lastGain) > 1e-12) order.push({ kind: "checkpoint", value: currentGain });
  const additions = sources.filter(source => !Object.hasOwn(state.sources, source.id));
  if (additions.length) order.push({ kind: "sources", ids: additions.map(source => source.id),
    supportingIds: additions.filter(source => source.supportValues.length > 0).map(source => source.id) });
  const nextSources = Object.fromEntries([
    ...Object.keys(state.sources).map((id): [string, PolicySourceValues] => [id, { id, supportValues: [], referenceValues: [] }]),
    ...sources.map((source): [string, PolicySourceValues] => [source.id, { id: source.id,
      supportValues: [...source.supportValues], referenceValues: [...source.referenceValues] }])
  ]);
  return replayPolicyContributions({ ...state, sources: nextSources, order, alpha, tau });
}

/** The caller must supply the real feedback identity; retries replace that event's delta. */
export function revisePolicyFeedback(state: PolicyGainContributions, id: string, delta: number, currentGain = state.lastGain): PolicyGainContributions {
  const order = [...state.order];
  if (Math.abs(currentGain - state.lastGain) > 1e-12) order.push({ kind: "checkpoint", value: currentGain });
  if (!Object.hasOwn(state.feedback, id)) order.push({ kind: "feedback", id });
  return replayPolicyContributions({ ...state, feedback: { ...state.feedback, [id]: delta }, order });
}

export interface PolicyGainSourceStage {
  position: number;
  gain: number;
  support: number;
  active: boolean;
}

/** Ephemeral projections for downstream consumers; never persist cumulative source snapshots. */
export function policyGainSourceStages(state: PolicyGainContributions): PolicyGainSourceStage[] {
  const stages: PolicyGainSourceStage[] = [];
  evaluatePolicyContributions(state, stages);
  return stages;
}

export function replayPolicyContributions(state: PolicyGainContributions): PolicyGainContributions {
  return evaluatePolicyContributions(state);
}

function evaluatePolicyContributions(state: PolicyGainContributions, stages?: PolicyGainSourceStage[]): PolicyGainContributions {
  let gain = state.baselineGain;
  let rawGain = state.baselineGain;
  let support = state.baselineSupport;
  const introduced = new Set<string>();
  for (const [position, event] of state.order.entries()) {
    if (event.kind === "checkpoint") { gain = event.value; continue; }
    if (event.kind === "feedback") {
      gain = Math.min(1, Math.max(-1, gain + state.feedback[event.id]!));
      continue;
    }
    for (const id of event.ids) introduced.add(id);
    const activeEvent = event.ids.some(id => {
      const source = state.sources[id];
      return source && (event.supportingIds.includes(id)
        ? source.supportValues.length > 0 : source.referenceValues.length > 0);
    });
    if (!activeEvent) { stages?.push({ position, gain, support, active: false }); continue; }
    const eligible = [...introduced].map(id => state.sources[id]!).filter(source =>
      source.supportValues.length > 0 || event.ids.includes(source.id));
    const withValues = eligible.flatMap(source => source.supportValues);
    if (withValues.length === 0) { stages?.push({ position, gain, support, active: false }); continue; }
    rawGain = computePolicyGainFromValues({ withValues,
      withoutValues: eligible.flatMap(source => source.referenceValues), tauSoftmax: state.tau }).gain;
    gain = smoothPolicyGain({ newGain: rawGain, currentGain: gain, alpha: state.alpha, isFirst: support === 0 });
    support = eligible.filter(source => source.supportValues.length > 0).length;
    stages?.push({ position, gain, support, active: true });
  }
  return { ...state, lastGain: gain, lastRawGain: rawGain };
}

/** Unknown schemas are not silently interpreted as an empty history. */
export function readPolicyContributions(value: unknown): PolicyGainContributions | undefined {
  if (value === undefined) return undefined;
  const finite = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every(id => typeof id === "string");
  if (!isRecord(value) || value.schemaVersion !== 1 || !finite(value.baselineGain) || !finite(value.baselineSupport) ||
      !finite(value.alpha) || !finite(value.tau) || !finite(value.lastGain) || !finite(value.lastRawGain) ||
      !isRecord(value.sources) || !isRecord(value.feedback) || !Array.isArray(value.order) ||
      !Object.entries(value.sources).every(([id, item]) => isRecord(item) && item.id === id &&
        Array.isArray(item.supportValues) && item.supportValues.every(finite) &&
        Array.isArray(item.referenceValues) && item.referenceValues.every(finite)) ||
      !Object.values(value.feedback).every(finite) || !value.order.every(event => isRecord(event) && (
        event.kind === "checkpoint" ? finite(event.value) : event.kind === "feedback" ?
          typeof event.id === "string" && Object.hasOwn(value.feedback as object, event.id) :
          event.kind === "sources" && strings(event.ids) && strings(event.supportingIds) &&
          event.ids.every(id => Object.hasOwn(value.sources as object, id))))) {
    throw new Error("Unsupported policy contribution data; preserve for review");
  }
  return value as unknown as PolicyGainContributions;
}
