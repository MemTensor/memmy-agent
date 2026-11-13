// Contribution identity/replay adapted from yxyi123, PR #740 (660b3b9c).
import {
  buildPolicyDraft, policyMetaFromMemory, policyStatusAfterGain, skillMetaFromMemory,
  skillEtaAfterRewardDrift, skillEtaAfterTrial, skillStatusAfterRewardDrift, skillStatusAfterTrial,
  type TraceMemoryMeta
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { ChangeLogRecord } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../utils/json.js";
import { l2ContentRevision } from "./l2-content-revision.js";

/** Only the inputs used by the numerical estimator; no conversation or embeddings. */
export type NumericTrace = Pick<TraceMemoryMeta, "id" | "episodeId" | "value">;
type PolicyStatus = NonNullable<ReturnType<typeof policyMetaFromMemory>>["status"];
type PolicyState = { gain: number; support: number; status: PolicyStatus; successfulSupport?: number };
export type PolicyInput = { evidence: NumericTrace[]; reference: NumericTrace[];
  /** Stable owners of this content's support links, including temporarily withdrawn sources. */
  sourceGroups?: string[];
  /** Full evidence can include valid negative lessons; only evidence above updates numeric success gain. */
  supportingEvidence?: NumericTrace[]; schemaVersion?: number; ruleFallback?: boolean;
  parameters: {
  minSupport: number; minGain: number; archiveGain: number; tauSoftmax: number; gainEmaAlpha: number;
} };
type PolicyUpdate = { type?: "update"; id: string; sources?: string[]; dependencies?: string[]; input: PolicyInput; gain: number; support?: number;
  /** A proven old maintenance-only update. Keep its ID for downstream historical references. */
  duplicateOf?: string };
type PolicyCheckpoint = { type: "checkpoint"; id: string; state: PolicyState; rawGain: number; gain: number; support: number;
  /** Audited automatic support prewrite, not an independent numerical intervention. */
  automaticSupport?: { supportChangeSeq: number; statisticsChangeSeq: number } };
export interface PolicyFeedbackInput { id: string; delta: number; minSupport: number; minGain: number; archiveGain: number }
type PolicyFeedback = { type: "feedback"; id: string; delta: number; minSupport: number; minGain: number; archiveGain: number; gain: number; support: number };
type PolicyEvent = PolicyUpdate | PolicyCheckpoint | PolicyFeedback;
export interface PolicyRevisionHistory {
  version: 1; contentRevision?: number; base: PolicyState; events: PolicyEvent[]; inputHash: string; lastEventId: string; revising?: boolean; latestInput?: PolicyInput; last?: PolicyState; externallyArchived?: boolean;
}

export function numericTraces(traces: TraceMemoryMeta[]): NumericTrace[] {
  return traces.map(({ id, episodeId, value }) => ({ id, episodeId, value })).sort((a, b) => a.id.localeCompare(b.id));
}

export function policyRevisionHistory(memory: MemoryRow): PolicyRevisionHistory | undefined {
  const history = memory.properties.internal_info.policy_revision_history as PolicyRevisionHistory | undefined;
  return history?.version === 1 && (history.contentRevision ?? 1) === l2ContentRevision(memory) ? history : undefined;
}

function inputRows(input: PolicyInput): NumericTrace[] {
  return [...input.evidence, ...input.reference, ...(input.supportingEvidence ?? [])];
}

function isPolicyUpdate(event: PolicyEvent): event is PolicyUpdate {
  return event.type === undefined || event.type === "update";
}

const traceGroup = (trace: NumericTrace) => trace.episodeId ?? `trace:${trace.id}`;
const unique = (values: string[]) => [...new Set(values)].sort();
const rawEventKey = (id: string) => id.replace(/^r\d+:/, "");
const isDerivedKey = (id: string) => /^(?:governance|evidence|checkpoint):/.test(rawEventKey(id));
const inputSources = (input: PolicyInput) => unique(input.sourceGroups
  ?? (input.supportingEvidence ?? input.evidence).map(traceGroup));
const inputDependencies = (input: PolicyInput) => unique([...inputRows(input).map(traceGroup), ...inputSources(input)]);

function recordedSources(event: PolicyUpdate): string[] {
  // New records distinguish ownership from reference-only dependencies. Old v1
  // records did not: conservatively retain their durable aliases when upgrading.
  return unique([...(event.sources ?? []).filter(id => !isDerivedKey(id)), ...inputSources(event.input),
    ...(event.input.sourceGroups === undefined ? event.dependencies ?? [] : []),
    ...(!isDerivedKey(event.id) ? [rawEventKey(event.id)] : [])]);
}

function markProvenGovernanceDuplicates(history: PolicyRevisionHistory): boolean {
  let changed = false;
  const known = new Set<string>();
  const knownOwners = new Set<string>();
  let previous: PolicyUpdate | undefined;
  for (const event of history.events) {
    if (!isPolicyUpdate(event)) {
      // A fixed external intervention is not evidence that an old maintenance
      // write was redundant. Leave ambiguous histories intact.
      if (event.type === "checkpoint" && !event.automaticSupport) previous = undefined;
      continue;
    }
    const key = rawEventKey(event.id);
    const dependencies = event.dependencies ?? inputDependencies(event.input);
    const selfOnly = event.sources?.length === 1 && event.sources[0] === key;
    if (!event.duplicateOf && previous && /^governance:[a-f0-9]{64}$/.test(key)
      && selfOnly && dependencies.length > 0 && dependencies.every(id => known.has(id))
      // Old addedGroups also included reference rows: dependency provenance alone
      // does not prove that a newly supporting task was already a contribution.
      && inputSources(event.input).every(id => knownOwners.has(id))
      && isDeepStrictEqual(event.input.parameters, previous.input.parameters)
      && event.input.schemaVersion === previous.input.schemaVersion
      && event.input.ruleFallback === previous.input.ruleFallback) {
      event.duplicateOf = previous.duplicateOf ?? previous.id;
      changed = true;
    }
    for (const id of [...recordedSources(event), ...dependencies]) known.add(id);
    for (const id of inputSources(event.input)) knownOwners.add(id);
    if (!event.duplicateOf) previous = event;
  }
  return changed;
}

function currentPolicyState(memory: MemoryRow, withSuccessfulSupport: boolean): PolicyState {
  const policy = policyMetaFromMemory(memory)!;
  const stored = memory.properties.internal_info.policy;
  return { gain: policy.gain, support: policy.support, status: policy.status,
    ...(withSuccessfulSupport ? { successfulSupport: isRecord(stored) && typeof stored.successful_episode_count === "number"
      ? stored.successful_episode_count : 0 } : {}) };
}

function replayPolicy(memory: MemoryRow, history: PolicyRevisionHistory) {
  const policy = policyMetaFromMemory(memory)!;
  let state = { ...history.base };
  let rawGain = state.gain;
  const toTraces = (rows: NumericTrace[]): TraceMemoryMeta[] => rows.map(row => ({
    ...row, memory, ts: 0, userId: memory.userId, summary: "", userText: "", agentText: "", toolCalls: [],
    reflection: null, alpha: 0, priority: 0, tags: [], errorSignatures: [], spanIds: [], vecSummary: null, vecAction: null, signature: ""
  }));
  for (const event of history.events) {
    if (event.type === "checkpoint") {
      if (!event.automaticSupport) {
        state = { ...event.state };
        rawGain = event.rawGain;
      }
    } else if (event.type === "feedback") {
      const gain = Math.max(-1, Math.min(1, state.gain + event.delta));
      const status = policyStatusAfterGain({ currentStatus: state.status === "active" ? "active"
        : state.status === "candidate" ? "candidate" : "archived", support: state.support, gain,
        minSupport: event.minSupport, minGain: event.minGain, archiveGain: event.archiveGain });
      state = { ...state, gain, status };
      rawGain = gain;
    } else if (event.duplicateOf) {
      // Preserve the aggregate at this exact position (including intervening
      // feedback), rather than copying the earlier event's possibly stale gain.
    } else if (!event.input.evidence.length) {
      const support = new Set((event.input.supportingEvidence ?? []).map(traceGroup)).size;
      const status = support === 0 ? "quarantined"
        : event.input.schemaVersion !== 2 && state.status === "active" ? "active" : "candidate";
      state = { ...state, support, status, ...(event.input.supportingEvidence ? { successfulSupport: 0 } : {}) };
    } else {
      const result = buildPolicyDraft({ signature: policy.signature, ...event.input.parameters,
        evidenceTraces: toTraces(event.input.evidence), allTraces: toTraces(event.input.reference),
        currentGain: state.gain, currentSupport: event.input.supportingEvidence ? state.successfulSupport ?? 0 : state.support,
        currentStatus: state.status === "active" ? "active" : state.status === "archived" ? "archived" : "candidate"
      });
      rawGain = result.rawGain;
      const successfulSupport = new Set(event.input.evidence.map(traceGroup)).size;
      let status: PolicyStatus = result.status;
      if (event.input.schemaVersion === 2 && (event.input.ruleFallback || successfulSupport < Math.min(2, event.input.parameters.minSupport)) && status === "active") status = "candidate";
      if (state.status === "active" && status !== "active") status = "verification_required";
      state = { gain: result.gain,
        support: event.input.supportingEvidence ? new Set(event.input.supportingEvidence.map(traceGroup)).size : result.support,
        status, ...(event.input.supportingEvidence ? { successfulSupport } : {}) };
    }
    event.gain = state.gain;
    event.support = state.support;
  }
  if (history.externallyArchived) state = { ...state, status: "archived" };
  history.last = { ...state };
  return { ...state, rawGain, history };
}

/**
 * Recover only a checkpoint proven to come from the old unified support prewrite.
 * The caller supplies this memory's retained changelog. Missing snapshots, gaps,
 * manual writes, and changed content are insufficient evidence and remain fixed.
 */
export function reconcilePolicyHistory(memory: MemoryRow, changes: ChangeLogRecord[]): PolicyRevisionHistory | undefined {
  const old = policyRevisionHistory(memory);
  if (!old?.events.some(event => event.type === "checkpoint" && !event.automaticSupport)) return undefined;
  const history = structuredClone(old);
  const revision = l2ContentRevision(memory);
  const snapshot = (value: unknown): MemoryRow | undefined => {
    if (!isRecord(value) || value.id !== memory.id || value.userId !== memory.userId || value.memoryLayer !== "L2"
      || !Number.isInteger(value.version) || typeof value.memoryValue !== "string" || !isRecord(value.info)
      || !isRecord(value.properties) || !isRecord(value.properties.internal_info)
      || !isRecord(value.properties.internal_info.policy)) return undefined;
    const row = value as unknown as MemoryRow;
    return row.memoryValue === memory.memoryValue && l2ContentRevision(row) === revision ? row : undefined;
  };
  const supportFields = ["support", "source_memory_ids", "source_l1_memory_ids", "source_trace_ids", "source_episode_ids",
    "special_source_trace_ids", "successful_source_trace_ids"];
  const withoutSupportWrite = (row: MemoryRow) => {
    const result = structuredClone(row) as unknown as Record<string, unknown>;
    delete result.version; delete result.updatedAt;
    const props = result.properties as MemoryRow["properties"];
    const internal = props.internal_info;
    for (const record of [result.info, props.info, internal, internal.policy]) {
      if (isRecord(record)) for (const key of supportFields) delete record[key];
    }
    return result;
  };
  const rawGain = (row: MemoryRow) => {
    const stored = row.properties.internal_info.policy;
    return isRecord(stored) && typeof stored.raw_gain === "number" && Number.isFinite(stored.raw_gain)
      ? stored.raw_gain : policyMetaFromMemory(row)!.gain;
  };
  const keys = (events: PolicyEvent[]) => events.map(event => ({ id: event.id, type: event.type ?? "update" }));
  const ordered = changes.filter(change => change.memoryId === memory.id && change.userId === memory.userId)
    .sort((a, b) => a.seq - b.seq);
  let changed = false;
  for (let index = 0; index + 1 < ordered.length; index++) {
    const support = ordered[index]!;
    const statistics = ordered[index + 1]!;
    if (support.changeType !== "unified_l2_supported" || support.source !== "worker.l2_extraction.v2"
      || statistics.changeType !== "policy_stats_update" || statistics.source !== "worker.l2_association.v7"
      || support.entityId !== memory.id || statistics.entityId !== memory.id || statistics.seq <= support.seq) continue;
    const before = snapshot(support.before), after = snapshot(support.after);
    const statsBefore = snapshot(statistics.before), statsAfter = snapshot(statistics.after);
    if (!before || !after || !statsBefore || !statsAfter || after.version !== before.version + 1
      || statsAfter.version !== after.version + 1 || !isDeepStrictEqual(after, statsBefore)
      || !isDeepStrictEqual(withoutSupportWrite(before), withoutSupportWrite(after))) continue;
    const beforeHistory = policyRevisionHistory(before), afterHistory = policyRevisionHistory(statsAfter);
    if (!beforeHistory?.last || !afterHistory || !isDeepStrictEqual(beforeHistory.base, history.base)
      || !isDeepStrictEqual(beforeHistory.base, afterHistory.base)
      || !isDeepStrictEqual(beforeHistory, policyRevisionHistory(after))) continue;
    const beforeState = currentPolicyState(before, beforeHistory.last.successfulSupport !== undefined);
    const afterState = currentPolicyState(after, beforeHistory.last.successfulSupport !== undefined);
    if (!isDeepStrictEqual(beforeState, beforeHistory.last) || beforeState.support === afterState.support
      || !isDeepStrictEqual({ ...beforeState, support: afterState.support }, afterState)) continue;
    const position = beforeHistory.events.length;
    const recorded = afterHistory.events[position];
    const candidate = history.events[position];
    if (afterHistory.events.length < position + 1 || afterHistory.events.length > position + 2
      || !isDeepStrictEqual(keys(beforeHistory.events), keys(afterHistory.events.slice(0, position)))
      || !isDeepStrictEqual(keys(afterHistory.events), keys(history.events.slice(0, afterHistory.events.length)))
      || recorded?.type !== "checkpoint" || candidate?.type !== "checkpoint" || candidate.automaticSupport
      || recorded.id !== `checkpoint:${position}` || candidate.id !== recorded.id
      || !isDeepStrictEqual(recorded.state, afterState) || recorded.rawGain !== rawGain(after)
      || !isDeepStrictEqual(candidate.state, recorded.state) || candidate.rawGain !== recorded.rawGain) continue;
    candidate.automaticSupport = { supportChangeSeq: support.seq, statisticsChangeSeq: statistics.seq };
    changed = true;
  }
  return changed ? history : undefined;
}

export function revisePolicyStatistics(memory: MemoryRow, input: PolicyInput, sourceId?: string,
  auditChanges?: ChangeLogRecord[]) {
  const policy = policyMetaFromMemory(memory)!;
  const storedPolicy = memory.properties.internal_info.policy;
  const storedRawGain = isRecord(storedPolicy) ? storedPolicy.raw_gain : undefined;
  const currentRawGain = typeof storedRawGain === "number" && Number.isFinite(storedRawGain) ? storedRawGain : policy.gain;
  const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const old = policyRevisionHistory(memory);
  const current = currentPolicyState(memory, Boolean(input.supportingEvidence) || old?.last?.successfulSupport !== undefined);
  // Legacy feedback histories may omit this count; replay already treats it as
  // zero. Compare the same default without inventing an external intervention.
  const previous = old?.last && current.successfulSupport !== undefined
    ? { ...old.last, successfulSupport: old.last.successfulSupport ?? 0 } : old?.last;
  const intervention = previous && !isDeepStrictEqual(previous, current);
  const sameInput = old?.latestInput ? isDeepStrictEqual(old.latestInput, input) : old?.inputHash === inputHash;
  const reconciled = auditChanges && reconcilePolicyHistory(memory, auditChanges);
  const history: PolicyRevisionHistory = reconciled ?? (old?.version === 1 ? structuredClone(old) : {
    version: 1, contentRevision: l2ContentRevision(memory), base: current, events: [], inputHash: "", lastEventId: ""
  });
  const repairedGovernance = markProvenGovernanceDuplicates(history);
  const repairedHistory = Boolean(reconciled) || repairedGovernance;
  if (sameInput && !intervention && !repairedHistory) return undefined;
  if (history.last && policy.status !== history.last.status) history.externallyArchived = policy.status === "archived";
  const checkpoint: PolicyCheckpoint | undefined = intervention ? {
    type: "checkpoint", id: `checkpoint:${history.events.length}`, state: current,
    rawGain: currentRawGain, gain: policy.gain, support: policy.support
  } : undefined;
  if (checkpoint) history.events.push(checkpoint);
  const updates = history.events.filter(isPolicyUpdate);
  // Detect interventions even on a duplicate input, without adding another evidence update.
  if (sameInput && checkpoint && !repairedHistory) {
    history.last = { ...current };
    history.lastEventId = checkpoint.id;
    history.revising = false;
    return { ...current, rawGain: currentRawGain, history };
  }
  const latest = history.latestInput ?? updates.at(-1)?.input;
  const knownGroups = new Set(updates.flatMap(recordedSources));
  const addedGroups = inputSources(input).filter(id => !knownGroups.has(id));
  const eventKey = (source: string) => l2ContentRevision(memory) === 1 ? source : `r${l2ContentRevision(memory)}:${source}`;
  const stableSource = sourceId && !isDerivedKey(sourceId) ? sourceId : undefined;
  const prior = stableSource ? updates.find(event => event.id === eventKey(stableSource)
    || event.sources?.includes(stableSource)) : undefined;
  const changedGroups = new Set<string>();
  if (latest) {
    for (const id of new Set([...inputRows(latest), ...inputRows(input)].map(traceGroup))) {
      const subset = (value: PolicyInput) => ({ evidence: value.evidence.filter(trace => traceGroup(trace) === id),
        reference: value.reference.filter(trace => traceGroup(trace) === id), supportingEvidence: value.supportingEvidence?.filter(trace => traceGroup(trace) === id) });
      if (!isDeepStrictEqual(subset(latest), subset(input))) changedGroups.add(id);
    }
  }
  // Correct changed evidence wherever an earlier aggregate actually used that source.
  // Do not silently mark a snapshot as handled while ignoring another member's revision.
  for (const event of updates) {
    event.dependencies ??= inputDependencies(event.input);
    for (const id of changedGroups) {
      // New owners belong to a later aggregate; corrections to registered owners
      // replace their contribution wherever an earlier aggregate depended on it.
      if (addedGroups.includes(id)) continue;
      const present = inputRows(event.input).some(trace => traceGroup(trace) === id);
      if (!present && !event.dependencies.includes(id) && !recordedSources(event).includes(id)) continue;
      const replace = (before: NumericTrace[], current: NumericTrace[]) => [
        ...before.filter(trace => traceGroup(trace) !== id), ...current.filter(trace => traceGroup(trace) === id)
      ].sort((a,b) => a.id.localeCompare(b.id));
      event.input.evidence = replace(event.input.evidence, input.evidence);
      event.input.reference = replace(event.input.reference, input.reference);
      if (event.input.supportingEvidence) event.input.supportingEvidence = replace(event.input.supportingEvidence, input.supportingEvidence ?? input.evidence);
    }
  }
  let revisingEvent = prior ?? [...updates].reverse().find(event => !event.duplicateOf);
  const visited = new Set<string>();
  while (revisingEvent?.duplicateOf && !visited.has(revisingEvent.id)) {
    visited.add(revisingEvent.id);
    revisingEvent = updates.find(event => event.id === revisingEvent!.duplicateOf);
  }
  if (revisingEvent && !revisingEvent.duplicateOf) {
    revisingEvent.input.parameters = { ...input.parameters };
    // Confirmation changes eligibility, not the ownership of its earlier evidence.
    revisingEvent.input.ruleFallback = input.ruleFallback;
    revisingEvent.input.schemaVersion = input.schemaVersion;
  }
  let appended: PolicyUpdate | undefined;
  if (addedGroups.length || updates.length === 0) {
    const owner = stableSource && addedGroups.includes(stableSource) ? stableSource
      : addedGroups.length === 1 ? addedGroups[0]!
        : addedGroups.length ? `evidence:${createHash("sha256").update(JSON.stringify(addedGroups)).digest("hex")}`
          : stableSource ?? "evidence:empty";
    appended = { id: eventKey(owner), sources: addedGroups, dependencies: inputDependencies(input), input: structuredClone(input), gain: 0 };
    history.events.push(appended);
  }
  history.revising = !appended && !checkpoint;
  history.latestInput = structuredClone(input);
  history.inputHash = inputHash;
  history.lastEventId = appended?.id ?? checkpoint?.id ?? revisingEvent?.id ?? history.lastEventId;
  return replayPolicy(memory, history);
}

/** Independent recall feedback is a delta in history, not an absolute manual override. */
export function revisePolicyFeedback(memory: MemoryRow, adjustment: PolicyFeedbackInput) {
  const old = policyRevisionHistory(memory);
  const stored = memory.properties.internal_info.policy;
  const current = currentPolicyState(memory, old?.last?.successfulSupport !== undefined
    || isRecord(stored) && typeof stored.successful_episode_count === "number");
  const history: PolicyRevisionHistory = old ? structuredClone(old) : {
    version: 1, contentRevision: l2ContentRevision(memory), base: current, events: [], inputHash: "", lastEventId: ""
  };
  if (old?.last && !isDeepStrictEqual(old.last, current)) {
    if (old.last.status !== current.status) history.externallyArchived = current.status === "archived";
    const raw = isRecord(stored) && typeof stored.raw_gain === "number" && Number.isFinite(stored.raw_gain)
      ? stored.raw_gain : current.gain;
    history.events.push({ type: "checkpoint", id: `checkpoint:${history.events.length}`, state: current,
      rawGain: raw, gain: current.gain, support: current.support });
  }
  markProvenGovernanceDuplicates(history);
  const id = `${l2ContentRevision(memory) === 1 ? "" : `r${l2ContentRevision(memory)}:`}feedback:${adjustment.id}`;
  const previous = history.events.findIndex(event => event.type === "feedback" && event.id === id);
  const event: PolicyFeedback = { ...adjustment, id, type: "feedback", gain: 0, support: current.support };
  if (previous < 0) history.events.push(event); else history.events[previous] = event;
  history.lastEventId = id;
  history.revising = previous >= 0;
  return replayPolicy(memory, history);
}

type SkillStatus = "candidate" | "active" | "archived";
type SkillState = { eta: number; status: SkillStatus; trialsAttempted: number; trialsPassed: number };
type SkillOptions = Pick<MemmyConfig["algorithm"]["skill"], "candidateTrials" | "minEtaForRetrieval" | "repairCandidateMinEta" | "archiveEta">;
type SkillEvent = { id: string; type: "checkpoint"; state: SkillState }
  | { id: string; type: "policy"; policyId: string; policyEventId: string; gain: number; disabled?: boolean; archiveEta: number }
  | { id: string; type: "crystallization"; policyId: string; policyEventId: string; gain: number; disabled?: boolean; support: number; minEta: number; minSupport: number; status: SkillStatus }
  | { id: string; type: "trial"; attempted: number; passed: number; options: SkillOptions; repairOrigin: boolean };
interface SkillHistory { version: 1; base: SkillState; events: SkillEvent[]; last?: SkillState; externallyArchived?: boolean }

function skillHistory(memory: MemoryRow): SkillHistory {
  const saved = memory.properties.internal_info.skill_revision_history as SkillHistory | undefined;
  const skill = skillMetaFromMemory(memory)!;
  // Public archive used to change only the outer memory status. Keep that intent
  // independent of numerical replay, including archives made before the marker existed.
  const externallyArchived = memory.status === "archived" && (saved?.externallyArchived === true
    || memory.properties.internal_info.skill_manually_archived === true || skill.status !== "archived");
  if (saved?.version === 1) {
    const history = structuredClone(saved);
    if (externallyArchived || saved.externallyArchived !== undefined) history.externallyArchived = externallyArchived;
    const current = { eta: skill.eta, status: skill.status, trialsAttempted: skill.trialsAttempted, trialsPassed: skill.trialsPassed };
    if (saved.last && !isDeepStrictEqual(saved.last, current)) {
      // An explicit intervention or a legacy writer establishes a fixed checkpoint.
      // Keep it in order instead of undoing it when earlier evidence is revised.
      history.events.push({ id: `checkpoint:${history.events.length}`, type: "checkpoint", state: current });
    }
    return history;
  }
  return { version: 1, base: { eta: skill.eta, status: skill.status, trialsAttempted: skill.trialsAttempted, trialsPassed: skill.trialsPassed }, events: [],
    ...(externallyArchived ? { externallyArchived: true } : {}) };
}

function replaySkill(history: SkillHistory) {
  let state = { ...history.base };
  for (const event of history.events) {
    if (event.type === "checkpoint") {
      state = { ...event.state };
    } else if ((event.type === "policy" || event.type === "crystallization") && event.disabled) {
      continue;
    } else if (event.type === "policy") {
      const eta = skillEtaAfterRewardDrift({ currentEta: state.eta, magnitude: event.gain });
      state = { ...state, eta, status: skillStatusAfterRewardDrift({ currentStatus: state.status, eta, archiveEta: event.archiveEta }) };
    } else if (event.type === "crystallization") {
      const clamp = (value: number) => Math.max(0, Math.min(1, value));
      const eta = state.trialsAttempted > 0 ? clamp(state.eta)
        : clamp(Math.max(event.minEta, 0.5 * clamp(event.gain) + 0.5 * Math.min(1, event.support / Math.max(1, event.minSupport))));
      state = { ...state, eta, status: event.status };
    } else {
      const eta = event.attempted > 0 ? skillEtaAfterTrial({ currentEta: state.eta,
        previousAttempts: state.trialsAttempted, previousPasses: state.trialsPassed,
        nextAttempts: event.attempted, nextPasses: event.passed }) : state.eta;
      state = { eta, trialsAttempted: event.attempted, trialsPassed: event.passed,
        status: skillStatusAfterTrial({ currentStatus: state.status, eta, trialsAttempted: event.attempted,
          ...event.options, repairOrigin: event.repairOrigin }) };
    }
  }
  if (history.externallyArchived) state.status = "archived";
  history.last = { ...state };
  return { ...state, history };
}

export function hasSkillTrialHistory(memory: MemoryRow, trialId: string): boolean {
  const history = memory.properties.internal_info.skill_revision_history as SkillHistory | undefined;
  return history?.version === 1 && history.events.some(event => event.id === `trial:${trialId}`);
}

/** Recover a pre-history trial from recorded writes, never by inverting a mixed eta. */
export function recoverLegacySkillTrialHistory(memory: MemoryRow, trialId: string,
  changes: ChangeLogRecord[], options: SkillOptions): MemoryRow | undefined {
  const history = skillHistory(memory);
  const ordered = [...changes].sort((a, b) => a.seq - b.seq);
  const start = ordered.findIndex(change => change.changeType === "skill_trial_resolved"
    && change.entityId === trialId && isRecord(change.before) && change.before.status === "pending");
  if (start < 0) return undefined;
  const known = new Set(history.events.filter(event => event.type !== "checkpoint").map(event => event.id));
  let pendingTrial: string | undefined;
  let pendingPassed = 0;
  let recovered: SkillHistory | undefined;
  let state: SkillState | undefined;
  const snapshot = (value: unknown): { memory: MemoryRow; state: SkillState } | undefined => {
    if (!isRecord(value) || value.memoryLayer !== "Skill" || !isRecord(value.properties)
      || !isRecord(value.properties.internal_info) || !isRecord(value.properties.internal_info.skill)) return undefined;
    const row = value as unknown as MemoryRow;
    const skill = skillMetaFromMemory(row);
    return skill ? { memory: row, state: { eta: skill.eta, status: skill.status,
      trialsAttempted: skill.trialsAttempted, trialsPassed: skill.trialsPassed } } : undefined;
  };
  const equal = (a: SkillState, b: SkillState) => Math.abs(a.eta - b.eta) < 1e-10
    && a.status === b.status && a.trialsAttempted === b.trialsAttempted && a.trialsPassed === b.trialsPassed;
  for (const change of ordered.slice(start)) {
    if (change.changeType === "skill_trial_resolved") {
      // Feedback attribution updates share this log type but do not change statistics.
      // Skip only when the same trial is unchanged apart from attribution and its timestamp.
      if (isRecord(change.before) && isRecord(change.after)) {
        const { feedbackId: _beforeFeedback, resolvedAt: _beforeAt, ...before } = change.before;
        const { feedbackId: _afterFeedback, resolvedAt: _afterAt, ...after } = change.after;
        if (typeof change.entityId === "string" && before.id === change.entityId && before.skillMemoryId === memory.id
          && isDeepStrictEqual(before, after)) continue;
      }
      if (known.has(`trial:${change.entityId}`)) break;
      // A retained outcome revision cannot be mistaken for an original settlement.
      if (pendingTrial || !isRecord(change.before) || change.before.status !== "pending"
        || change.before.outcome !== "unknown" || !isRecord(change.after)) return undefined;
      pendingTrial = change.after.outcome === "unknown" ? undefined : change.entityId;
      pendingPassed = change.after.outcome === "success" ? 1 : 0;
      continue;
    }
    const before = snapshot(change.before);
    const after = snapshot(change.after);
    if (!before || !after) continue;
    const recorded = after.memory.properties.internal_info.skill_revision_history as SkillHistory | undefined;
    // The current history already models these writes. Recover only its base prefix.
    if (recorded?.version === 1 && recorded.events.some(event => known.has(event.id))) break;
    if (!recovered) {
      if (change.changeType !== "skill_trial_update" || pendingTrial !== trialId) return undefined;
      recovered = { version: 1, base: before.state, events: [] };
      state = before.state;
    }
    // Any unexplained gap may hide an automatic write whose inputs are needed for replay.
    if (!equal(state!, before.state)) return undefined;
    if (change.changeType === "skill_trial_update") {
      if (!pendingTrial || after.state.trialsAttempted !== before.state.trialsAttempted + 1
        || after.state.trialsPassed !== before.state.trialsPassed + pendingPassed) return undefined;
      const recordedEvent = recorded?.events.find(event => event.id === `trial:${pendingTrial}`);
      const event: SkillEvent = { type: "trial", id: `trial:${pendingTrial}`,
        attempted: after.state.trialsAttempted, passed: after.state.trialsPassed,
        options: recordedEvent?.type === "trial" ? recordedEvent.options : options,
        repairOrigin: skillMetaFromMemory(before.memory)?.repairOrigin ?? false };
      // Validate the snapshot pair before trusting it as a replayable trial write.
      if (!equal(replaySkill({ version: 1, base: before.state, events: [event] }), after.state)) return undefined;
      recovered.events.push(event);
      pendingTrial = undefined;
    } else {
      // Only audited human writes establish fixed checkpoints. An automatic write
      // can depend on an earlier eta even when its original snapshots are equal.
      const manual = change.changeType === "update" && ["panel.update", "evidence.skill_edit"].includes(change.source)
        || change.changeType === "archive" && change.source === "panel.archive";
      if (!manual) return undefined;
      if (before.state.trialsAttempted !== after.state.trialsAttempted || before.state.trialsPassed !== after.state.trialsPassed) return undefined;
      if (!equal(before.state, after.state)) recovered.events.push({ type: "checkpoint", id: `legacy-after:${change.seq}`, state: after.state });
    }
    state = after.state;
  }
  if (!recovered || !state || pendingTrial || !equal(state, history.base)) return undefined;
  history.base = recovered.base;
  history.events.unshift(...recovered.events);
  return withRevisionHistory(memory, "skill_revision_history", history);
}

export function reviseSkillPolicy(memory: MemoryRow, policyMemory: MemoryRow, archiveEta: number) {
  const policy = policyMetaFromMemory(policyMemory)!;
  const policyHistory = policyRevisionHistory(policyMemory);
  const history = skillHistory(memory);
  // Legacy callers also get a stable effective-input key, not a new job-based event.
  const eventId = policyHistory?.lastEventId ?? (l2ContentRevision(policyMemory) === 1 ? "legacy" : `revision:${l2ContentRevision(policyMemory)}:legacy`);
  const id = `policy:${policy.id}:${eventId}`;
  for (const event of history.events) {
    if (event.type === "trial" || event.type === "checkpoint" || event.policyId !== policy.id) continue;
    // The pre-history writer recorded one replaceable aggregate as "legacy". Adopt
    // that recorded slot into the first history event instead of adding another drift.
    if (event.policyEventId === "legacy" && l2ContentRevision(policyMemory) === 1 && policyHistory?.events.length
      && isPolicyUpdate(policyHistory.events[0]!)
      && !history.events.slice(history.events.indexOf(event) + 1).some(later => later.type === "checkpoint")) {
      event.policyEventId = policyHistory.events[0]!.id;
      if (event.type === "policy") event.id = `policy:${policy.id}:${event.policyEventId}`;
    }
    const replacement = policyHistory?.events.find(item => item.id === event.policyEventId);
    if (replacement) {
      event.gain = replacement.gain;
      if (isPolicyUpdate(replacement) && (replacement.input.evidence.length === 0
        || event.type === "policy" && Boolean(replacement.duplicateOf))
        || event.type === "policy" && replacement.type === "checkpoint" && Boolean(replacement.automaticSupport)) event.disabled = true;
      else delete event.disabled;
      if (event.type === "crystallization") event.support = replacement.support ?? event.support;
    } else if ((!policyHistory && event.policyEventId === eventId) || (event.policyEventId === "legacy" && l2ContentRevision(policyMemory) === 1 && policy.support === 0)) {
      event.gain = policy.gain;
      if (policy.support === 0) event.disabled = true; else delete event.disabled;
      if (event.type === "crystallization") event.support = policy.support;
    }
  }
  // A newly discovered intervention can precede a new independent update in the
  // same transaction. Preserve both in Skill order; never reapply a checkpoint.
  const knownPolicyEvents = new Set(history.events.flatMap(event =>
    event.type === "policy" || event.type === "crystallization"
      ? event.policyId === policy.id ? [event.policyEventId] : [] : []));
  const lastKnownIndex = policyHistory?.events.reduce((last, event, index) =>
    knownPolicyEvents.has(event.id) ? index : last, -1) ?? -1;
  if (lastKnownIndex >= 0) {
    for (const checkpoint of policyHistory!.events.slice(lastKnownIndex + 1)) {
      if (checkpoint.type !== "checkpoint" && checkpoint.type !== "feedback") continue;
      history.events.push({ id: `policy:${policy.id}:${checkpoint.id}`, type: "policy", policyId: policy.id,
        policyEventId: checkpoint.id, gain: checkpoint.gain, archiveEta,
        ...(checkpoint.type === "checkpoint" && checkpoint.automaticSupport ? { disabled: true } : {}) });
    }
  }
  const gain = policyHistory?.events.find(event => event.id === eventId)?.gain ?? policy.gain;
  const existing = history.events.find(event => event.id === id);
  const currentEvent = policyHistory?.events.find(event => event.id === eventId);
  const disabled = currentEvent && isPolicyUpdate(currentEvent)
    ? currentEvent.input.evidence.length === 0 || Boolean(currentEvent.duplicateOf)
    : Boolean(currentEvent?.type === "checkpoint" && currentEvent.automaticSupport) || policy.support === 0;
  if (existing?.type === "policy") { existing.gain = gain; if (disabled) existing.disabled = true; else delete existing.disabled; }
  // Crystallization already used this Policy contribution, including revisions
  // of earlier inputs represented by its later aggregate. Only a new source
  // adds another drift; correcting an existing contribution just replays it.
  else if (!knownPolicyEvents.has(eventId) && (!policyHistory?.revising || knownPolicyEvents.size === 0)) {
    history.events.push({ id, type: "policy", policyId: policy.id, policyEventId: eventId, gain, archiveEta, ...(disabled ? { disabled: true } : {}) });
  }
  return replaySkill(history);
}

export function reviseSkillTrial(memory: MemoryRow, trialId: string, attempted: number, passed: number, options: SkillOptions) {
  const history = skillHistory(memory);
  const event: SkillEvent = { id: `trial:${trialId}`, type: "trial", attempted, passed, options,
    repairOrigin: skillMetaFromMemory(memory)?.repairOrigin ?? false };
  const index = history.events.findIndex(item => item.id === event.id);
  if (index < 0) {
    history.events.push(event);
  } else {
    // A trial event stores the cumulative counts at its original position, not
    // today's total. Correct its contribution wherever later snapshots used it.
    const skill = skillMetaFromMemory(memory)!;
    const attemptedDelta = attempted - skill.trialsAttempted;
    const passedDelta = passed - skill.trialsPassed;
    for (const later of history.events.slice(index)) {
      if (later.type === "trial") {
        later.attempted += attemptedDelta;
        later.passed += passedDelta;
      } else if (later.type === "checkpoint") {
        // Evidence counts follow verdict corrections; the intervened eta and
        // status remain fixed when replay reaches this checkpoint.
        later.state.trialsAttempted += attemptedDelta;
        later.state.trialsPassed += passedDelta;
      }
    }
    const previous = history.events[index];
    if (previous?.type === "trial") {
      previous.options = options;
      previous.repairOrigin = event.repairOrigin;
    }
  }
  return replaySkill(history);
}

export function withRevisionHistory(memory: MemoryRow, key: "policy_revision_history" | "skill_revision_history", history: unknown): MemoryRow {
  return { ...memory, properties: { ...memory.properties, internal_info: { ...memory.properties.internal_info, [key]: history } } };
}

/** Skill text rebuilding is another numerical writer; keep it in the same ordered history. */
export function reviseSkillCrystallization(previous: MemoryRow | undefined, next: MemoryRow, policyMemory: MemoryRow, options: { minEtaForRetrieval: number; minSupport: number }) {
  const history = skillHistory(previous ?? next);
  const policy = policyMetaFromMemory(policyMemory)!;
  const policyHistory = policyRevisionHistory(policyMemory);
  // The draft uses today's aggregate gain. A revision may have been triggered
  // by an earlier source, so bind it to the final aggregate rather than that
  // source's historical intermediate value.
  const eventId = policyHistory?.events.at(-1)?.id ?? policyHistory?.lastEventId ?? (l2ContentRevision(policyMemory) === 1 ? "legacy" : `revision:${l2ContentRevision(policyMemory)}:legacy`);
  const nextSkill = skillMetaFromMemory(next)!;
  const event: SkillEvent = { id: `crystallization:${policy.id}:${eventId}`, type: "crystallization", policyId: policy.id,
    policyEventId: eventId, gain: policy.gain, support: policy.support, minEta: options.minEtaForRetrieval,
    minSupport: options.minSupport, status: nextSkill.status };
  let index = history.events.reduce((last, item, position) => item.type === "crystallization"
    && item.policyId === policy.id && item.policyEventId === eventId ? position : last, -1);
  const contentChanged = previous !== undefined && previous.memoryValue !== next.memoryValue;
  if (previous && !contentChanged && policyHistory && policyHistory.lastEventId !== eventId) {
    const legacyIndex = history.events.reduce((last, item, position) => item.type === "crystallization"
      && item.policyId === policy.id ? position : last, -1);
    const legacy = history.events[legacyIndex];
    // Older writers bound the current aggregate to the triggering source. Upgrade
    // the latest unchanged content in place so its later trials keep their order.
    // Only a different source makes this an earlier aggregate. Old writers can
    // also leave a policy event for this same source; preserve its value and order.
    if (legacy?.type === "crystallization" && legacy.policyEventId === policyHistory.lastEventId
      && legacy.id === `crystallization:${policy.id}:${policyHistory.lastEventId}`
      && !history.events.slice(legacyIndex + 1).some(item => (item.type === "policy" || item.type === "crystallization")
        && item.policyId === policy.id && item.policyEventId !== legacy.policyEventId)) {
      index = legacyIndex;
    }
  }
  if (index < 0 || contentChanged) {
    // A new procedure must follow earlier trials. Reverting to old text is
    // still a new rebuild; it cannot reuse verification from before this write.
    if (index >= 0) event.id += `:rebuild:${history.events.length}`;
    history.events.push(event);
  } else {
    // Identical content is a numerical refresh, not another lifecycle reset.
    event.id = history.events[index]!.id;
    history.events[index] = event;
  }
  return replaySkill(history);
}
