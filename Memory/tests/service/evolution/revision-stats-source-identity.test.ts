import { describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import type { MemoryRow } from "../../../src/types.js";
import type { ChangeLogRecord } from "../../../src/storage/repositories.js";
import {
  policyRevisionHistory, reconcilePolicyHistory, revisePolicyFeedback, revisePolicyStatistics, reviseSkillCrystallization,
  reviseSkillPolicy, reviseSkillTrial, withRevisionHistory, type PolicyInput, type PolicyRevisionHistory
} from "../../../src/service/evolution/revision-stats.js";

const parameters = { minSupport: 1, minGain: 0.02, archiveGain: -0.05, tauSoftmax: 0.5, gainEmaAlpha: 0.4 };
const options = DEFAULT_MEMMY_CONFIG.algorithm.skill;
function policy(): MemoryRow {
  return { id: "p", userId: "u", memoryLayer: "L2", memoryValue: "policy", status: "activated", tags: [], info: {},
    properties: { internal_info: { policy: { status: "active", support: 1, gain: 0.8 } } } } as unknown as MemoryRow;
}
function skill(): MemoryRow {
  return { id: "s", userId: "u", memoryLayer: "Skill", memoryValue: "Procedure A", status: "activated", tags: [], info: {},
    properties: { internal_info: { skill: { status: "active", eta: 0.8, support: 1, trials_attempted: 0, trials_passed: 0 } } } } as unknown as MemoryRow;
}
function input(values: Record<string, number>, sources = Object.keys(values)): PolicyInput {
  const rows = Object.entries(values).map(([episodeId, value]) => ({ id: `trace-${episodeId}`, episodeId, value }));
  return { evidence: rows.filter(row => row.value > 0), reference: rows, sourceGroups: sources, parameters };
}
function savePolicy(memory: MemoryRow, result: NonNullable<ReturnType<typeof revisePolicyStatistics>>) {
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.policy as object, { gain: result.gain, raw_gain: result.rawGain,
    support: result.support, status: result.status,
    ...(result.successfulSupport !== undefined ? { successful_episode_count: result.successfulSupport } : {}) });
  return withRevisionHistory(next, "policy_revision_history", result.history);
}
function update(memory: MemoryRow, next: PolicyInput, source?: string) {
  const result = revisePolicyStatistics(memory, next, source);
  return result ? savePolicy(memory, result) : memory;
}
function saveSkill(memory: MemoryRow, result: ReturnType<typeof reviseSkillPolicy>) {
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.skill as object, { eta: result.eta, status: result.status,
    trials_attempted: result.trialsAttempted, trials_passed: result.trialsPassed });
  next.status = result.status === "active" ? "activated" : result.status === "candidate" ? "resolving" : "archived";
  return withRevisionHistory(next, "skill_revision_history", result.history);
}
const drift = (s: MemoryRow, p: MemoryRow) => saveSkill(s, reviseSkillPolicy(s, p, options.archiveEta));
const trial = (s: MemoryRow) => saveSkill(s, reviseSkillTrial(s, "trial-1", 1, 1, options));
function crystallize(s: MemoryRow, p: MemoryRow, text = s.memoryValue) {
  const next = structuredClone(s); next.memoryValue = text;
  Object.assign(next.properties.internal_info.skill as object, { status: "candidate" });
  return saveSkill(next, reviseSkillCrystallization(s, next, p, options));
}
function feedback(p: MemoryRow, id: string, delta: number) {
  return savePolicy(p, revisePolicyFeedback(p, { id, delta, minSupport: 1, minGain: 0.02, archiveGain: -0.05 }));
}
const gain = (p: MemoryRow) => policyMetaFromMemory(p)!.gain;
const eta = (s: MemoryRow) => skillMetaFromMemory(s)!.eta;
type PolicyUpdateEvent = Extract<PolicyRevisionHistory["events"][number], { input: PolicyInput }>;
const updates = (p: MemoryRow) => policyRevisionHistory(p)!.events.filter((event): event is PolicyUpdateEvent =>
  event.type === undefined || event.type === "update");

describe("source identity independently of numeric snapshots and execution entry points", () => {
  it("restores an implicit source repeatedly without another Policy or Skill contribution", () => {
    let p = update(policy(), input({ A: 1 })); let s = drift(skill(), p);
    const once = { gain: gain(p), eta: eta(s), events: updates(p).length };
    for (const value of [-1, 1, -1, 1]) {
      p = update(p, input({ A: value }, ["A"])); s = drift(s, p);
      expect(updates(p)).toHaveLength(once.events);
      if (value > 0) { expect(gain(p)).toBeCloseTo(once.gain, 12); expect(eta(s)).toBeCloseTo(once.eta, 12); }
      else expect(eta(s)).toBeCloseTo(0.8, 12);
    }
    expect(update(p, input({ A: 1 }))).toBe(p);
  });

  it("uses one first-batch identity and revises an extra trace belonging to an existing task", () => {
    let p = update(policy(), input({ A: 1, B: 0.8 }));
    const id = updates(p)[0]!.id;
    const changed = input({ A: 1, B: 0.8 });
    changed.evidence.push({ id: "trace-A-2", episodeId: "A", value: 0.6 });
    changed.reference.push({ id: "trace-A-2", episodeId: "A", value: 0.6 });
    p = update(p, changed, "A");
    expect(updates(p)).toHaveLength(1); expect(updates(p)[0]!.id).toBe(id);
    expect(policyMetaFromMemory(p)!.support).toBe(2);
    expect(gain(p)).toBeCloseTo(gain(update(policy(), changed)), 12);
  });

  it("corrects known A while adding independent B without altering A's original position", () => {
    let p = update(policy(), input({ A: 1 }), "A"); let s = trial(drift(skill(), p));
    p = update(p, input({ A: 0.4, B: 0.8 }), "A"); s = drift(s, p);
    let control = update(policy(), input({ A: 0.4 }), "A"); let controlSkill = trial(drift(skill(), control));
    control = update(control, input({ A: 0.4, B: 0.8 }), "B"); controlSkill = drift(controlSkill, control);
    expect(updates(p).map(event => event.id)).toEqual(["A", "B"]);
    expect(gain(p)).toBeCloseTo(gain(control), 12); expect(eta(s)).toBeCloseTo(eta(controlSkill), 12);
    expect(skillMetaFromMemory(s)!.trialsPassed).toBe(1);
  });

  it("restores A inside a later B aggregate even after A disappeared from the latest input", () => {
    let p = update(policy(), input({ A: 1 }), "A");
    p = update(p, input({ A: 1, B: 0.8 }), "B"); const once = gain(p);
    p = update(p, input({ B: 0.8 }, ["A", "B"]));
    p = update(p, input({ A: 1, B: 0.8 }));
    expect(updates(p)).toHaveLength(2); expect(gain(p)).toBeCloseTo(once, 12);
  });

  it("does not treat a reference-only group as a registered supporting owner", () => {
    const first = input({ A: 1, C: 0.5 }, ["A"]);
    first.evidence = first.evidence.filter(row => row.episodeId === "A");
    let p = update(policy(), first);
    p = update(p, input({ A: 1, C: 0.5 }, ["A", "C"]));
    expect(updates(p)).toHaveLength(2);
    expect(updates(p)[1]).toMatchObject({ id: "C", sources: ["C"] });
  });

  it("replays independent recall feedback as a delta when old task evidence changes", () => {
    let p = update(policy(), input({ A: 1 }), "A"); let s = trial(drift(skill(), p));
    p = feedback(p, "recall-1:feedback-1", 0.02); s = drift(s, p);
    p = update(p, input({ A: 0.4 }), "A"); s = drift(s, p);
    let control = update(policy(), input({ A: 0.4 }), "A"); let controlSkill = trial(drift(skill(), control));
    control = feedback(control, "recall-1:feedback-1", 0.02); controlSkill = drift(controlSkill, control);
    expect(gain(p)).toBeCloseTo(gain(control), 12); expect(eta(s)).toBeCloseTo(eta(controlSkill), 12);
    expect(policyRevisionHistory(p)!.events.some(event => event.type === "checkpoint")).toBe(false);
    const once = gain(p); p = feedback(p, "recall-1:feedback-1", 0.02);
    expect(gain(p)).toBe(once); expect(policyRevisionHistory(p)!.events.filter(event => event.type === "feedback")).toHaveLength(1);
    p = feedback(p, "recall-1:feedback-2", -0.02);
    expect(gain(p)).toBeCloseTo(once - 0.02, 12);
  });

  it("keeps an unknown external checkpoint and a user archive during replay", () => {
    let p = update(policy(), input({ A: 1 }));
    Object.assign(p.properties.internal_info.policy as object, { gain: 0.73 });
    p = update(p, input({ A: 0.4 }));
    expect(gain(p)).toBe(0.73);
    expect(policyRevisionHistory(p)!.events.at(-1)).toMatchObject({ type: "checkpoint", gain: 0.73 });
    let s = drift(skill(), p);
    s.status = "archived"; s.properties.internal_info.skill_manually_archived = true;
    s = drift(s, update(p, input({ A: -1 }, ["A"])));
    expect(skillMetaFromMemory(s)!.status).toBe("archived");
  });
});

function frozenDuplicateHistory() {
  const first = `governance:${"a".repeat(64)}`, duplicate = `governance:${"b".repeat(64)}`;
  const snapshot = input({ A: 1 }); delete snapshot.sourceGroups;
  const history: PolicyRevisionHistory = { version: 1, contentRevision: 1,
    base: { gain: 0.8, support: 1, status: "active" },
    events: [
      { id: first, sources: [first, "A"], dependencies: ["A"], input: structuredClone(snapshot), gain: 0.68, support: 1 },
      { id: duplicate, sources: [duplicate], dependencies: ["A"], input: structuredClone(snapshot), gain: 0.608, support: 1 }
    ], latestInput: snapshot, inputHash: "old-hash", lastEventId: duplicate,
    last: { gain: 0.608, support: 1, status: "active" } };
  const p = policy(); Object.assign(p.properties.internal_info.policy as object, { gain: 0.608, raw_gain: 0.5 });
  const s = skill(); Object.assign(s.properties.internal_info.skill as object, { eta: 0.7172 });
  const skillHistory = { version: 1, base: { eta: 0.8, status: "active", trialsAttempted: 0, trialsPassed: 0 },
    events: [
      { type: "policy", id: `policy:p:${first}`, policyId: "p", policyEventId: first, gain: 0.68, archiveEta: 0.1 },
      { type: "policy", id: `policy:p:${duplicate}`, policyId: "p", policyEventId: duplicate, gain: 0.608, archiveEta: 0.1 }
    ], last: { eta: 0.7172, status: "active", trialsAttempted: 0, trialsPassed: 0 } };
  return { p: withRevisionHistory(p, "policy_revision_history", history),
    s: withRevisionHistory(s, "skill_revision_history", skillHistory), history, first, duplicate, snapshot };
}

describe("proof-limited repair of old governance duplicates", () => {
  it("does not infer a duplicate when an old reference-only task first becomes supporting evidence", () => {
    const old = frozenDuplicateHistory();
    const first = input({ A: 1, B: 0.5 }); delete first.sourceGroups;
    first.evidence = first.evidence.filter(trace => trace.episodeId === "A");
    const next = input({ A: 1, B: 0.5 }); delete next.sourceGroups;
    const firstEvent = updates(old.p)[0]!, nextEvent = updates(old.p)[1]!;
    // The old writer included B in addedGroups merely because it was a reference.
    firstEvent.input = first; firstEvent.sources = [old.first, "A", "B"]; firstEvent.dependencies = ["A", "B"];
    nextEvent.input = next; nextEvent.dependencies = ["A", "B"]; nextEvent.support = 2; nextEvent.gain = 0.508;
    old.history.latestInput = next; old.history.last = { gain: 0.508, support: 2, status: "active" };
    Object.assign(old.p.properties.internal_info.policy as object, { gain: 0.508, raw_gain: 0.25, support: 2 });
    const p = update(old.p, next);
    expect(p).toBe(old.p);
    expect(updates(p)[1]!.duplicateOf).toBeUndefined();
    expect(gain(p)).toBeCloseTo(0.4 * 0.25 + 0.6 * 0.68, 12);
  });

  it("applies current estimator parameters to the live event behind an old duplicate alias", () => {
    const old = frozenDuplicateHistory();
    const corrected = { ...old.snapshot, parameters: { ...parameters, gainEmaAlpha: 0.2 } };
    const p = update(old.p, corrected, old.duplicate);
    expect(updates(p)[0]!.input.parameters.gainEmaAlpha).toBe(0.2);
    expect(gain(p)).toBeCloseTo(gain(update(policy(), corrected, "A")), 12);
  });

  it("retains old IDs but removes a proven duplicate EMA and Skill drift", () => {
    const old = frozenDuplicateHistory(); const p = update(old.p, old.snapshot);
    const s = drift(old.s, p);
    expect(updates(p).map(event => event.id)).toEqual([old.first, old.duplicate]);
    expect(updates(p)[1]).toMatchObject({ duplicateOf: old.first });
    expect(updates(p)[1]!.gain).toBeCloseTo(0.68, 12);
    expect(gain(p)).toBeCloseTo(0.68, 12); expect(eta(s)).toBeCloseTo(0.764, 12);
    expect(update(p, old.snapshot)).toBe(p);
  });

  it("keeps a crystallization bound to the old duplicate and preserves later trial order", () => {
    const old = frozenDuplicateHistory();
    let s = crystallize(skill(), old.p); s = trial(s);
    const eventIds = (s.properties.internal_info.skill_revision_history as { events: Array<{ id: string }> }).events.map(event => event.id);
    const p = update(old.p, old.snapshot); s = drift(s, p);
    const controlPolicy = update(policy(), input({ A: 1 }));
    const control = trial(crystallize(skill(), controlPolicy));
    expect(eta(s)).toBeCloseTo(eta(control), 12);
    expect(skillMetaFromMemory(s)!.trialsPassed).toBe(1);
    expect((s.properties.internal_info.skill_revision_history as { events: Array<{ id: string }> }).events.map(event => event.id)).toEqual(eventIds);
  });

  it.each(["missing sources", "new source", "different parameters", "checkpoint"])("does not guess when old history has %s", boundary => {
    const old = frozenDuplicateHistory();
    const event = old.history.events[1]!;
    if (event.type !== undefined && event.type !== "update") throw new Error("fixture update missing");
    if (boundary === "missing sources") delete event.sources;
    if (boundary === "new source") event.sources = [old.duplicate, "B"];
    if (boundary === "different parameters") event.input.parameters.gainEmaAlpha = 0.3;
    if (boundary === "checkpoint") old.history.events.splice(1, 0,
      { type: "checkpoint", id: "checkpoint:1", state: { gain: 0.73, support: 1, status: "active" }, rawGain: 0.5, gain: 0.73, support: 1 });
    const changed = input({ A: 0.9 }); delete changed.sourceGroups;
    const p = update(withRevisionHistory(old.p, "policy_revision_history", old.history), changed);
    expect(policyRevisionHistory(p)!.events.find(item => item.id === old.duplicate)).not.toHaveProperty("duplicateOf");
  });
});

function frozenAutomaticSupportCheckpoint(withNewSource = true) {
  const before = update(policy(), input({ A: 1 }), "A");
  before.version = 10;
  const after = structuredClone(before);
  after.version = 11;
  (after.properties.internal_info.policy as Record<string, unknown>).support = 2;
  const snapshot = withNewSource ? input({ A: 1, B: 0.8 }) : input({ A: 1 });
  const statsAfter = update(after, snapshot, withNewSource ? "B" : "A");
  statsAfter.version = 12;
  const changes: ChangeLogRecord[] = [
    { seq: 100, memoryId: "p", entityId: "p", userId: "u", changeType: "unified_l2_supported",
      source: "worker.l2_extraction.v2", before, after, createdAt: "2026-11-10T00:00:00Z" },
    { seq: 103, memoryId: "p", entityId: "p", userId: "u", changeType: "policy_stats_update",
      source: "worker.l2_association.v7", before: after, after: statsAfter, createdAt: "2026-11-10T00:00:00Z" }
  ];
  return { before, after, p: statsAfter, snapshot, changes };
}

describe("proof-limited repair of old automatic support checkpoints", () => {
  it("unfreezes the original gain and disables only the automatic Skill drift", () => {
    const old = frozenAutomaticSupportCheckpoint();
    let s = trial(drift(skill(), old.before)); s = drift(s, old.p);
    const oldIds = policyRevisionHistory(old.p)!.events.map(event => event.id);
    const corrected = input({ A: 0.4, B: 0.8 });
    const p = savePolicy(old.p, revisePolicyStatistics(old.p, corrected, "A", old.changes)!);
    s = drift(s, p);
    let control = update(policy(), input({ A: 0.4 }), "A"); let controlSkill = trial(drift(skill(), control));
    control = update(control, corrected, "B"); controlSkill = drift(controlSkill, control);
    expect(policyRevisionHistory(p)!.events.map(event => event.id)).toEqual(oldIds);
    expect(policyRevisionHistory(p)!.events[1]).toMatchObject({ type: "checkpoint",
      automaticSupport: { supportChangeSeq: 100, statisticsChangeSeq: 103 } });
    expect(gain(p)).toBeCloseTo(gain(control), 12); expect(eta(s)).toBeCloseTo(eta(controlSkill), 12);
    expect(skillMetaFromMemory(s)!.trialsPassed).toBe(1);
    expect(revisePolicyStatistics(p, corrected, "A", old.changes)).toBeUndefined();
  });

  it("repairs a same-input checkpoint without removing a bound crystallization or its trial", () => {
    const old = frozenAutomaticSupportCheckpoint(false);
    let s = crystallize(skill(), old.p); s = trial(s);
    const p = savePolicy(old.p, revisePolicyStatistics(old.p, old.snapshot, undefined, old.changes)!);
    s = drift(s, p);
    const control = trial(crystallize(skill(), old.before));
    const events = (s.properties.internal_info.skill_revision_history as { events: Array<{ type: string; disabled?: boolean }> }).events;
    expect(events.filter(event => event.type === "crystallization")).toHaveLength(1);
    expect(events.find(event => event.type === "crystallization")?.disabled).not.toBe(true);
    expect(gain(p)).toBeCloseTo(gain(old.before), 12); expect(eta(s)).toBeCloseTo(eta(control), 12);
  });

  it.each(["missing-snapshot", "version-gap", "intervening-writer", "wrong-source", "changed-gain", "changed-content", "changed-checkpoint"])(
    "leaves an unproven checkpoint fixed: %s", reason => {
      const old = frozenAutomaticSupportCheckpoint();
      if (reason === "missing-snapshot") old.changes[0]!.before = undefined;
      if (reason === "version-gap") (old.changes[1]!.after as MemoryRow).version = 14;
      if (reason === "intervening-writer") old.changes.splice(1, 0, { seq: 102, memoryId: "p", entityId: "p", userId: "u",
        changeType: "update", source: "panel.update", createdAt: "2026-11-10T00:00:00Z" });
      if (reason === "wrong-source") old.changes[0]!.source = "panel.update";
      if (reason === "changed-gain") (old.changes[0]!.after as MemoryRow).properties.internal_info.policy = {
        ...((old.changes[0]!.after as MemoryRow).properties.internal_info.policy as object), gain: 0.7 };
      if (reason === "changed-content") old.p.memoryValue = "new content";
      if (reason === "changed-checkpoint") {
        const event = policyRevisionHistory(old.p)!.events[1]!;
        if (event.type === "checkpoint") event.state.gain = 0.7;
      }
      expect(reconcilePolicyHistory(old.p, old.changes)).toBeUndefined();
    });
});

describe("recall feedback backlog and existing Skill writer order", () => {
  const skillEvents = (memory: MemoryRow) => (memory.properties.internal_info.skill_revision_history as {
    events: Array<{ id: string; type: string; policyEventId?: string }>
  }).events;
  it("propagates two pending feedback deltas once and preserves a later trial on source revision", () => {
    let p = update(policy(), input({ A: 1 }), "A"); let s = drift(skill(), p);
    p = feedback(p, "first", 0.02); p = feedback(p, "second", -0.01);
    s = drift(s, p); s = trial(s);
    const ids = skillEvents(s).map(event => event.id);
    expect(skillEvents(s).map(event => event.type)).toEqual(["policy", "policy", "policy", "trial"]);
    const originalEta = eta(s);
    p = update(p, input({ A: 0.4 }), "A"); s = drift(s, p);
    // A alone has raw gain .4 - .4 = 0, smoothed against the .8 baseline.
    const correctedGain = 0.6 * 0.8;
    const correctedDrift = 0.7 * 0.8 + 0.3 * correctedGain;
    const afterFirst = 0.7 * correctedDrift + 0.3 * (correctedGain + 0.02);
    const afterSecond = 0.7 * afterFirst + 0.3 * (correctedGain + 0.01);
    expect(gain(p)).toBeCloseTo(correctedGain + 0.01, 12);
    expect(eta(s)).toBeCloseTo((afterSecond + 1) / 2, 12);
    expect(skillEvents(s).map(event => event.id)).toEqual(ids);
    expect(skillMetaFromMemory(s)).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });
    p = update(p, input({ A: 1 }), "A"); s = drift(s, p);
    expect(eta(s)).toBeCloseTo(originalEta, 12);
    s = drift(s, p); expect(skillEvents(s).map(event => event.id)).toEqual(ids);
  });

  it("does not move an already recorded trial behind feedback that reaches Skill later", () => {
    let p = update(policy(), input({ A: 1 }), "A"); let s = drift(skill(), p);
    p = feedback(p, "first", 0.02); p = feedback(p, "second", -0.01);
    s = trial(s); s = drift(s, p);
    const ids = skillEvents(s).map(event => event.id);
    expect(skillEvents(s).map(event => event.type)).toEqual(["policy", "trial", "policy", "policy"]);
    p = update(p, input({ A: 0.4 }), "A"); s = drift(s, p);
    const afterTrial = ((0.7 * 0.8 + 0.3 * 0.48) + 1) / 2;
    expect(eta(s)).toBeCloseTo(0.7 * (0.7 * afterTrial + 0.3 * 0.50) + 0.3 * 0.49, 12);
    expect(skillEvents(s).map(event => event.id)).toEqual(ids);
  });

  it("does not add separate backlog drifts after crystallization already consumed their aggregate", () => {
    let p = update(policy(), input({ A: 1 }), "A"); let s = drift(skill(), p);
    p = feedback(p, "first", 0.02); p = feedback(p, "second", -0.01);
    s = crystallize(s, p); s = trial(s);
    const ids = skillEvents(s).map(event => event.id);
    p = update(p, input({ A: 0.4 }), "A"); s = drift(s, p);
    expect(skillEvents(s).map(event => event.id)).toEqual(ids);
    expect(skillEvents(s).map(event => event.type)).toEqual(["policy", "crystallization", "trial"]);
    expect(skillEvents(s)[1]!.policyEventId).toBe("feedback:second");
  });
});
