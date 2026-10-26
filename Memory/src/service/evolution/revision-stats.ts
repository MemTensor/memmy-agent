import {
  buildPolicyDraft, policyMetaFromMemory, skillMetaFromMemory,
  skillEtaAfterRewardDrift, skillEtaAfterTrial, skillStatusAfterRewardDrift, skillStatusAfterTrial,
  type TraceMemoryMeta
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { ChangeLogRecord } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";

/** Only the inputs used by the numerical estimator; no conversation or embeddings. */
export type NumericTrace = Pick<TraceMemoryMeta, "id" | "episodeId" | "value">;
type PolicyStatus = NonNullable<ReturnType<typeof policyMetaFromMemory>>["status"];
type PolicyState = { gain: number; support: number; status: PolicyStatus };
type PolicyInput = { evidence: NumericTrace[]; reference: NumericTrace[]; parameters: {
  minSupport: number; minGain: number; archiveGain: number; tauSoftmax: number; gainEmaAlpha: number;
} };
type PolicyUpdate = { type?: "update"; id: string; sources?: string[]; input: PolicyInput; gain: number; support?: number };
type PolicyCheckpoint = { type: "checkpoint"; id: string; state: PolicyState; rawGain: number; gain: number; support: number };
type PolicyEvent = PolicyUpdate | PolicyCheckpoint;
export interface PolicyRevisionHistory {
  version: 1; base: PolicyState; events: PolicyEvent[]; inputHash: string; lastEventId: string; revising?: boolean; latestInput?: PolicyInput; last?: PolicyState; externallyArchived?: boolean;
}

export function numericTraces(traces: TraceMemoryMeta[]): NumericTrace[] {
  return traces.map(({ id, episodeId, value }) => ({ id, episodeId, value })).sort((a, b) => a.id.localeCompare(b.id));
}

export function revisePolicyStatistics(memory: MemoryRow, input: PolicyInput, sourceId: string) {
  const policy = policyMetaFromMemory(memory)!;
  const storedPolicy = memory.properties.internal_info.policy;
  const storedRawGain = isRecord(storedPolicy) ? storedPolicy.raw_gain : undefined;
  const currentRawGain = typeof storedRawGain === "number" && Number.isFinite(storedRawGain) ? storedRawGain : policy.gain;
  const inputHash = stableHash(stableStringify(input));
  const old = memory.properties.internal_info.policy_revision_history as PolicyRevisionHistory | undefined;
  const current = { gain: policy.gain, support: policy.support, status: policy.status };
  const intervention = old?.version === 1 && old.last && stableStringify(old.last) !== stableStringify(current);
  if (old?.version === 1 && old.inputHash === inputHash && !intervention) return undefined;
  const history: PolicyRevisionHistory = old?.version === 1 ? structuredClone(old) : {
    version: 1, base: { gain: policy.gain, support: policy.support, status: policy.status }, events: [], inputHash: "", lastEventId: sourceId
  };
  if (history.last && policy.status !== history.last.status) history.externallyArchived = policy.status === "archived";
  const checkpoint: PolicyCheckpoint | undefined = intervention ? {
    type: "checkpoint", id: `checkpoint:${history.events.length}`, state: current,
    rawGain: currentRawGain, gain: policy.gain, support: policy.support
  } : undefined;
  if (checkpoint) history.events.push(checkpoint);
  const updates = history.events.filter((event): event is PolicyUpdate => event.type !== "checkpoint");
  // Detect interventions even on a duplicate input, without adding another evidence update.
  if (history.inputHash === inputHash && checkpoint) {
    history.last = { ...current };
    history.lastEventId = checkpoint.id;
    history.revising = false;
    return { ...current, rawGain: currentRawGain, history };
  }
  const latest = history.latestInput ?? updates.at(-1)?.input;
  const group = (trace: NumericTrace) => trace.episodeId ?? `trace:${trace.id}`;
  const knownGroups = new Set(latest ? [...latest.evidence, ...latest.reference].map(group) : []);
  const addedGroups = latest ? [...new Set([...input.evidence, ...input.reference].map(group))].filter(id => !knownGroups.has(id)) : [];
  let prior = updates.find(event => event.id === sourceId || event.sources?.includes(sourceId));
  if (prior && addedGroups.some(id => id !== sourceId)) {
    sourceId = addedGroups.length === 1 ? addedGroups[0]! : `evidence:${stableHash(stableStringify(addedGroups.sort()))}`;
    prior = undefined;
  }
  const changedGroups = new Set<string>();
  if (latest) {
    for (const id of new Set([...latest.evidence, ...latest.reference, ...input.evidence, ...input.reference].map(group))) {
      const subset = (value: PolicyInput) => ({ evidence: value.evidence.filter(trace => group(trace) === id),
        reference: value.reference.filter(trace => group(trace) === id) });
      if (stableStringify(subset(latest)) !== stableStringify(subset(input))) changedGroups.add(id);
    }
  }
  // Correct changed evidence wherever an earlier aggregate actually used that source.
  // Do not silently mark a snapshot as handled while ignoring another member's revision.
  for (const event of updates) {
    for (const id of changedGroups) {
      // The first update attributed to B keeps the preceding A checkpoint intact.
      // Revisions of an already recorded update replace its historical dependency.
      if (id === sourceId && !prior) continue;
      const present = [...event.input.evidence, ...event.input.reference].some(trace => group(trace) === id);
      if (!present && !(event === prior && id === sourceId)) continue;
      const replace = (before: NumericTrace[], current: NumericTrace[]) => [
        ...before.filter(trace => group(trace) !== id), ...current.filter(trace => group(trace) === id)
      ].sort((a,b) => a.id.localeCompare(b.id));
      event.input.evidence = replace(event.input.evidence, input.evidence);
      event.input.reference = replace(event.input.reference, input.reference);
    }
  }
  if (prior) {
    if (sourceId.startsWith("governance:")) prior.input = input;
    else prior.input.parameters = input.parameters;
  } else {
    history.events.push({ id: sourceId, sources: [sourceId, ...addedGroups], input, gain: 0 });
  }
  let state = history.base;
  let rawGain = state.gain;
  const toTraces = (rows: NumericTrace[]): TraceMemoryMeta[] => rows.map(row => ({
    ...row, memory, ts: 0, userId: memory.userId, summary: "", userText: "", agentText: "", toolCalls: [],
    reflection: null, alpha: 0, priority: 0, tags: [], errorSignatures: [], spanIds: [], vecSummary: null, vecAction: null, signature: ""
  }));
  for (const event of history.events) {
    if (event.type === "checkpoint") {
      state = { ...event.state };
      rawGain = event.rawGain;
    } else if (!event.input.evidence.length) {
      state = { ...state, support: 0, status: "quarantined" };
    } else {
      const result = buildPolicyDraft({ signature: policy.signature, ...event.input.parameters,
        evidenceTraces: toTraces(event.input.evidence), allTraces: toTraces(event.input.reference),
        currentGain: state.gain, currentSupport: state.support,
        currentStatus: state.status === "active" ? "active" : state.status === "archived" ? "archived" : "candidate"
      });
      rawGain = result.rawGain;
      state = { gain: result.gain, support: result.support,
        status: state.status === "active" && result.status !== "active" ? "verification_required" : result.status };
    }
    event.gain = state.gain;
    event.support = state.support;
  }
  if (history.externallyArchived) state = { ...state, status: "archived" };
  history.last = { ...state };
  history.revising = Boolean(prior) && !checkpoint;
  history.latestInput = input;
  history.inputHash = inputHash;
  history.lastEventId = prior ? checkpoint?.id ?? prior.id : sourceId;
  return { ...state, rawGain, history };
}

type SkillStatus = "candidate" | "active" | "archived";
type SkillState = { eta: number; status: SkillStatus; trialsAttempted: number; trialsPassed: number };
type SkillOptions = Pick<MemmyConfig["algorithm"]["skill"], "candidateTrials" | "minEtaForRetrieval" | "repairCandidateMinEta" | "archiveEta">;
type SkillEvent = { id: string; type: "checkpoint"; state: SkillState }
  | { id: string; type: "policy"; policyId: string; policyEventId: string; gain: number; archiveEta: number }
  | { id: string; type: "crystallization"; policyId: string; policyEventId: string; gain: number; support: number; minEta: number; minSupport: number; status: SkillStatus }
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
    if (saved.last && stableStringify(saved.last) !== stableStringify(current)) {
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
          && stableStringify(before) === stableStringify(after)) continue;
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
  const policyHistory = policyMemory.properties.internal_info.policy_revision_history as PolicyRevisionHistory | undefined;
  const history = skillHistory(memory);
  // Legacy callers also get a stable effective-input key, not a new job-based event.
  const eventId = policyHistory?.lastEventId ?? "legacy";
  const id = `policy:${policy.id}:${eventId}`;
  for (const event of history.events) {
    if (event.type === "trial" || event.type === "checkpoint" || event.policyId !== policy.id) continue;
    const replacement = policyHistory?.events.find(item => item.id === event.policyEventId);
    if (replacement) {
      event.gain = replacement.gain;
      if (event.type === "crystallization") event.support = replacement.support ?? event.support;
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
      if (checkpoint.type !== "checkpoint") continue;
      history.events.push({ id: `policy:${policy.id}:${checkpoint.id}`, type: "policy", policyId: policy.id,
        policyEventId: checkpoint.id, gain: checkpoint.gain, archiveEta });
    }
  }
  const gain = policyHistory?.events.find(event => event.id === eventId)?.gain ?? policy.gain;
  const existing = history.events.find(event => event.id === id);
  if (existing?.type === "policy") existing.gain = gain;
  // Crystallization already used this Policy contribution, including revisions
  // of earlier inputs represented by its later aggregate. Only a new source
  // adds another drift; correcting an existing contribution just replays it.
  else if (!knownPolicyEvents.has(eventId) && (!policyHistory?.revising || knownPolicyEvents.size === 0)) {
    history.events.push({ id, type: "policy", policyId: policy.id, policyEventId: eventId, gain, archiveEta });
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
  const policyHistory = policyMemory.properties.internal_info.policy_revision_history as PolicyRevisionHistory | undefined;
  // The draft uses today's aggregate gain. A revision may have been triggered
  // by an earlier source, so bind it to the final aggregate rather than that
  // source's historical intermediate value.
  const eventId = policyHistory?.events.at(-1)?.id ?? policyHistory?.lastEventId ?? "legacy";
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
