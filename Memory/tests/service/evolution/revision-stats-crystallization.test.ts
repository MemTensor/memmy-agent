import { describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import type { MemoryRow } from "../../../src/types.js";
import {
  revisePolicyStatistics, reviseSkillCrystallization, reviseSkillPolicy, reviseSkillTrial, withRevisionHistory
} from "../../../src/service/evolution/revision-stats.js";

const options = DEFAULT_MEMMY_CONFIG.algorithm.skill;
const parameters = { minSupport: 1, minGain: 0.02, archiveGain: -0.05, tauSoftmax: 0.5, gainEmaAlpha: 0.4 };

function policy(): MemoryRow {
  return { id: "policy-1", userId: "audit", memoryValue: "policy", tags: [], memoryLayer: "L2", status: "activated", info: {},
    properties: { internal_info: { policy: { signature: "python|pytest|_|_", status: "active", gain: 0.8, support: 2 } } }
  } as unknown as MemoryRow;
}
function skill(): MemoryRow {
  return { id: "skill-1", userId: "audit", memoryValue: "Procedure A", tags: [], memoryLayer: "Skill", status: "resolving", info: {},
    properties: { internal_info: { skill: { eta: 0.84, status: "candidate", trials_attempted: 0, trials_passed: 0 } } }
  } as unknown as MemoryRow;
}
function updatePolicy(memory: MemoryRow, source: string, values: Record<string, number>): MemoryRow {
  const traces = Object.entries(values).sort().map(([episodeId, value]) => ({ id: `trace-${episodeId}`, episodeId, value }));
  const result = revisePolicyStatistics(memory, { evidence: traces, reference: traces, parameters }, source);
  if (!result) return memory;
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.policy as object, {
    gain: result.gain, support: result.support, status: result.status, raw_gain: result.rawGain
  });
  return withRevisionHistory(next, "policy_revision_history", result.history);
}
function saveSkill(memory: MemoryRow, result: ReturnType<typeof reviseSkillTrial>): MemoryRow {
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.skill as object, {
    eta: result.eta, status: result.status, trials_attempted: result.trialsAttempted, trials_passed: result.trialsPassed
  });
  next.status = result.status === "active" ? "activated" : result.status === "archived" ? "archived" : "resolving";
  return withRevisionHistory(next, "skill_revision_history", result.history);
}
function crystallize(previous: MemoryRow | undefined, p: MemoryRow, text = previous?.memoryValue ?? "Procedure A") {
  const next = structuredClone(previous ?? skill());
  next.memoryValue = text;
  next.status = "resolving";
  Object.assign(next.properties.internal_info.skill as object, { status: "candidate" });
  return saveSkill(next, reviseSkillCrystallization(previous, next, p, options));
}
function drift(s: MemoryRow, p: MemoryRow) {
  return saveSkill(s, reviseSkillPolicy(s, p, options.archiveEta));
}
function trial(s: MemoryRow, id: string, attempted: number, passed: number) {
  return saveSkill(s, reviseSkillTrial(s, id, attempted, passed, options));
}
function history(s: MemoryRow) {
  return s.properties.internal_info.skill_revision_history as ReturnType<typeof reviseSkillTrial>["history"];
}

function legacyCrystallize(previous: MemoryRow | undefined, p: MemoryRow, text?: string) {
  const next = crystallize(previous, p, text);
  const legacyEventId = (p.properties.internal_info.policy_revision_history as { lastEventId: string }).lastEventId;
  const event = history(next).events.filter(item => item.type === "crystallization").at(-1)!;
  // Persisted layout from the old writer: aggregate gain with the triggering source's ID.
  event.id = `crystallization:${p.id}:${legacyEventId}`;
  event.policyEventId = legacyEventId;
  return next;
}

function revisedAncestorPolicy() {
  let p = updatePolicy(policy(), "A", { A: 1 });
  p = updatePolicy(p, "B", { A: 1, B: 0.8 });
  return updatePolicy(p, "A", { A: 0.6, B: 0.8 });
}

function legacySameSourceSkill(trialFirst = true) {
  const p = updatePolicy(revisedAncestorPolicy(), "A", { A: 0.4, B: 0.8 });
  // Frozen output of the old writer, including its retained same-source drift.
  // Do not generate this history through the current implementation under test.
  const stored: ReturnType<typeof reviseSkillTrial>["history"] = {
    version: 1, base: { eta: 0.84, status: "candidate", trialsAttempted: 0, trialsPassed: 0 },
    events: [
      { id: `crystallization:${p.id}:A`, type: "crystallization", policyId: p.id, policyEventId: "A",
        gain: 0.328, support: 2, minEta: 0.1, minSupport: 1, status: "candidate" },
      { id: "trial:verified", type: "trial", attempted: 1, passed: 1, repairOrigin: false,
        options: { candidateTrials: 1, minEtaForRetrieval: 0.1, repairCandidateMinEta: 0.5, archiveEta: 0.1 } },
      { id: `policy:${p.id}:A`, type: "policy", policyId: p.id, policyEventId: "A", gain: 0.48, archiveEta: 0.1 }
    ],
    last: { eta: trialFirst ? 0.7264 : 0.8044, status: "active", trialsAttempted: 1, trialsPassed: 1 }
  };
  if (!trialFirst) [stored.events[1], stored.events[2]] = [stored.events[2]!, stored.events[1]!];
  return { p, s: saveSkill(skill(), { ...stored.last!, history: stored }) };
}

// These exercise the event sequence, not just repeated calls with one final state.
describe("MEMMY-647 crystallization contribution and rebuild order", () => {
  it("replaces a crystallized source without adding another reward contribution", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    let s = crystallize(undefined, p);
    p = updatePolicy(p, "A", { A: 0.6 });
    s = drift(s, p);
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.5 + 0.5 * policyMetaFromMemory(p)!.gain);
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization"]);
    const before = history(s);
    s = crystallize(s, p);
    s = drift(s, p);
    expect(history(s)).toEqual(before);
  });

  it("still applies the next independent source after a crystallized source", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    let s = crystallize(undefined, p);
    const beforeEta = skillMetaFromMemory(s)!.eta;
    p = updatePolicy(p, "B", { A: 1, B: 0.8 });
    s = drift(s, p);
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization", "policy"]);
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.7 * beforeEta + 0.3 * policyMetaFromMemory(p)!.gain);
  });

  it("keeps A / B / revised A crystallizations tied to the current aggregate", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    let s = crystallize(undefined, p);
    p = updatePolicy(p, "B", { A: 1, B: 0.8 });
    s = crystallize(drift(s, p), p);
    const eventCount = history(s).events.length;
    for (const a of [0.6, 0.4]) {
      p = updatePolicy(p, "A", { A: a, B: 0.8 });
      s = crystallize(drift(s, p), p);
      expect(history(s).events).toHaveLength(eventCount);
      const latest = history(s).events.at(-1)!;
      expect(latest).toMatchObject({ type: "crystallization", policyEventId: "B", gain: policyMetaFromMemory(p)!.gain });
      expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.5 + 0.5 * policyMetaFromMemory(p)!.gain);
    }
  });

  it("revises an ancestor already included when the Skill was first created after B", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    p = updatePolicy(p, "B", { A: 1, B: 0.8 });
    let s = crystallize(undefined, p);
    p = updatePolicy(p, "A", { A: 0.6, B: 0.8 });
    s = crystallize(drift(s, p), p);
    expect(history(s).events).toHaveLength(1);
    expect(history(s).events[0]).toMatchObject({ type: "crystallization", policyEventId: "B" });
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.5 + 0.5 * policyMetaFromMemory(p)!.gain);
  });

  it("upgrades a legacy triggering-source binding without resetting verified identical content", () => {
    let p = revisedAncestorPolicy();
    let s = trial(legacyCrystallize(undefined, p), "old", 1, 1);
    const before = skillMetaFromMemory(s)!;
    const ids = history(s).events.map(event => event.id);
    s = crystallize(s, p);
    expect(skillMetaFromMemory(s)).toMatchObject({ status: "active", eta: before.eta, trialsAttempted: 1, trialsPassed: 1 });
    expect(history(s).events.map(event => event.id)).toEqual(ids);
    expect(history(s).events[0]).toMatchObject({ policyEventId: "B", gain: policyMetaFromMemory(p)!.gain });
    const migrated = history(s);
    s = crystallize(s, p);
    expect(history(s)).toEqual(migrated);

    p = updatePolicy(p, "A", { A: 0.4, B: 0.8 });
    s = crystallize(drift(s, p), p);
    const control = trial(crystallize(undefined, p), "old", 1, 1);
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(skillMetaFromMemory(control)!.eta);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
    expect(history(s).events.map(event => event.id)).toEqual(ids);
  });

  it("upgrades the latest legacy crystallization even when an earlier aggregate binding exists", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    p = updatePolicy(p, "B", { A: 1, B: 0.8 });
    let s = crystallize(undefined, p);
    s = trial(s, "before-rebuild", 1, 1);
    p = updatePolicy(p, "A", { A: 0.6, B: 0.8 });
    s = legacyCrystallize(s, p, "Procedure B");
    s = trial(s, "after-rebuild", 2, 2);
    const before = history(s);
    s = crystallize(s, p);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
    expect(history(s).events.map(event => event.id)).toEqual(before.events.map(event => event.id));
    expect(history(s).events[0]).toEqual(before.events[0]);
    expect(history(s).events[2]).toMatchObject({ id: `crystallization:${p.id}:A`, policyEventId: "B" });
    s = crystallize(s, p);
    expect(history(s).events).toHaveLength(4);
  });

  it("does not rebind an earlier source that already has a later independent reward contribution", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    let s = trial(crystallize(undefined, p), "old", 1, 1);
    p = updatePolicy(p, "B", { A: 1, B: 0.8 });
    s = drift(s, p);
    p = updatePolicy(p, "A", { A: 0.6, B: 0.8 });
    s = drift(s, p);
    const before = history(s).events;
    const beforeEta = skillMetaFromMemory(s)!.eta;
    s = crystallize(s, p);
    expect(history(s).events.slice(0, before.length)).toEqual(before);
    expect(history(s).events[0]).toMatchObject({ policyEventId: "A" });
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(beforeEta);
  });

  it("keeps a genuine new source independent after upgrading a legacy binding", () => {
    let p = revisedAncestorPolicy();
    let s = crystallize(trial(legacyCrystallize(undefined, p), "old", 1, 1), p);
    const migrated = history(s).events[0];
    p = updatePolicy(p, "C", { A: 0.6, B: 0.8, C: 0.9 });
    s = crystallize(drift(s, p), p);
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization", "trial", "policy", "crystallization"]);
    expect(history(s).events[0]).toEqual(migrated);
    expect(history(s).events.at(-1)).toMatchObject({ policyEventId: "C" });
  });

  it("requires a later trial when legacy content actually changes during upgrade", () => {
    const p = revisedAncestorPolicy();
    let s = trial(legacyCrystallize(undefined, p), "old", 1, 1);
    s = crystallize(s, p, "Procedure B");
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization", "trial", "crystallization"]);
    s = trial(s, "old", 1, 0);
    s = trial(s, "old", 1, 1);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    s = trial(s, "new", 2, 2);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
  });

  it.each([true, false])("preserves a legacy same-source drift and trial order (trial first: %s)", trialFirst => {
    const { p, s } = legacySameSourceSkill(trialFirst);
    const before = history(s);
    for (const input of [s, drift(s, p)]) {
      const refreshed = crystallize(input, p);
      expect(skillMetaFromMemory(refreshed)).toMatchObject(before.last!);
      expect(history(refreshed).events).toEqual(before.events.map((event, index) =>
        index === 0 ? { ...event, policyEventId: "B" } : event));
      expect(history(crystallize(refreshed, p))).toEqual(history(refreshed));
    }
  });

  it.each([true, false])("replays withdrawal and restoration around a retained same-source drift (trial first: %s)", trialFirst => {
    const { p, s } = legacySameSourceSkill(trialFirst);
    let updated = crystallize(s, p);
    const migrated = history(updated);
    updated = trial(updated, "verified", 0, 0);
    expect(skillMetaFromMemory(updated)).toMatchObject({ status: "candidate", trialsAttempted: 0, trialsPassed: 0 });
    expect(skillMetaFromMemory(updated)!.eta).toBeCloseTo(0.6088);
    updated = crystallize(updated, p);
    expect(history(updated).events).toHaveLength(3);
    updated = trial(updated, "verified", 1, 1);
    expect(skillMetaFromMemory(updated)).toMatchObject({ status: "active", trialsAttempted: 1, trialsPassed: 1 });
    expect(skillMetaFromMemory(updated)!.eta).toBeCloseTo(migrated.last!.eta);
    expect(history(updated).events.map(event => event.id)).toEqual(migrated.events.map(event => event.id));
  });

  it("updates retained A and aggregate B in place while keeping a genuinely new C independent", () => {
    let { p, s } = legacySameSourceSkill();
    s = crystallize(s, p);
    const ids = history(s).events.map(event => event.id);
    for (const [source, values] of [["A", { A: 0.2, B: 0.8 }], ["B", { A: 0.2, B: 0.6 }]] as const) {
      p = updatePolicy(p, source, values);
      s = crystallize(drift(s, p), p);
      expect(history(s).events.map(event => event.id)).toEqual(ids);
      expect(history(s).events[0]).toMatchObject({ policyEventId: "B", gain: policyMetaFromMemory(p)!.gain });
      expect(skillMetaFromMemory(s)!.status).toBe("active");
    }
    p = updatePolicy(p, "C", { A: 0.2, B: 0.6, C: 0.9 });
    s = crystallize(drift(s, p), p);
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization", "trial", "policy", "policy", "crystallization"]);
    expect(history(s).events[3]).toMatchObject({ policyEventId: "C" });
    expect(history(s).events[4]).toMatchObject({ policyEventId: "C" });
  });

  it("still protects an independent C when same-source A and independent C drifts coexist", () => {
    let { p, s } = legacySameSourceSkill();
    p = updatePolicy(p, "C", { A: 0.4, B: 0.8, C: 0.6 });
    s = drift(s, p);
    p = updatePolicy(p, "A", { A: 0.2, B: 0.8, C: 0.6 });
    s = drift(s, p);
    const before = history(s).events;
    expect(before.filter(event => event.type === "policy").map(event => event.policyEventId)).toEqual(["A", "C"]);
    s = crystallize(s, p);
    expect(history(s).events.slice(0, before.length)).toEqual(before);
    expect(history(s).events[0]).toMatchObject({ policyEventId: "A" });
    expect(history(s).events).toHaveLength(before.length + 1);
  });

  it("does not let retained same-source drift or old trials verify genuinely changed content", () => {
    const { p, s } = legacySameSourceSkill();
    let updated = crystallize(s, p, "Procedure B");
    expect(skillMetaFromMemory(updated)!.status).toBe("candidate");
    updated = trial(updated, "verified", 1, 0);
    updated = trial(updated, "verified", 1, 1);
    updated = crystallize(updated, p);
    expect(skillMetaFromMemory(updated)!.status).toBe("candidate");
    expect(history(updated).events.map(event => event.type)).toEqual(["crystallization", "trial", "policy", "crystallization"]);
    updated = trial(updated, "later", 2, 2);
    expect(skillMetaFromMemory(updated)!.status).toBe("active");
  });

  it("keeps a later Policy checkpoint as an independent contribution that blocks legacy rebinding", () => {
    let { p, s } = legacySameSourceSkill();
    Object.assign(p.properties.internal_info.policy as object, { gain: 0.73 });
    p = updatePolicy(p, "A", { A: 0.4, B: 0.8 });
    s = drift(s, p);
    // Revise A again so the legacy-binding compatibility branch is eligible.
    p = updatePolicy(p, "A", { A: 0.3, B: 0.8 });
    s = drift(s, p);
    const policyHistory = p.properties.internal_info.policy_revision_history as
      NonNullable<ReturnType<typeof revisePolicyStatistics>>["history"];
    const checkpoint = policyHistory.events.at(-1)!;
    expect(checkpoint).toMatchObject({ type: "checkpoint", gain: 0.73 });
    expect(policyHistory.lastEventId).toBe("A");
    expect(checkpoint.id).not.toBe(policyHistory.lastEventId);

    const before = history(s).events;
    expect(before.filter(event => event.type === "policy" && event.policyEventId === checkpoint.id))
      .toEqual([expect.objectContaining({ policyId: p.id, gain: 0.73 })]);
    expect(before.some(event => event.type === "checkpoint")).toBe(false);
    const updated = crystallize(s, p);
    expect(history(updated).events.slice(0, before.length)).toEqual(before);
    expect(history(updated).events[0]).toMatchObject({ policyEventId: "A" });
    expect(history(updated).events).toHaveLength(before.length + 1);
    expect(history(updated).events.at(-1)).toMatchObject({ type: "crystallization", policyEventId: checkpoint.id });
    expect(skillMetaFromMemory(updated)!.status).toBe("candidate");
    expect(skillMetaFromMemory(updated)!.eta).toBeCloseTo(skillMetaFromMemory(s)!.eta);
    expect(history(crystallize(updated, p))).toEqual(history(updated));
  });

  it.each(["checkpoint", "archive"] as const)("preserves a manual %s after a legacy same-source drift", intervention => {
    const { p, s } = legacySameSourceSkill();
    if (intervention === "checkpoint") {
      Object.assign(s.properties.internal_info.skill as object, { eta: 0.73 });
    } else {
      s.status = "archived";
      s.properties.internal_info.skill_manually_archived = true;
    }
    const updated = crystallize(s, p);
    expect(skillMetaFromMemory(updated)).toMatchObject({ status: intervention === "archive" ? "archived" : "active", trialsAttempted: 1, trialsPassed: 1 });
    expect(skillMetaFromMemory(updated)!.eta).toBeCloseTo(intervention === "archive" ? 0.7264 : 0.73);
    expect(history(updated).events.filter(event => event.type === "crystallization")).toHaveLength(1);
    expect(history(crystallize(updated, p))).toEqual(history(updated));
  });

  it("puts changed content after old trials and requires a later trial to activate it", () => {
    const p = updatePolicy(policy(), "A", { A: 1 });
    let s = trial(crystallize(undefined, p), "old", 1, 1);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
    s = crystallize(s, p, "Procedure B");
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    expect(history(s).events.map(event => event.type)).toEqual(["crystallization", "trial", "crystallization"]);
    s = trial(s, "old", 1, 0);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    s = trial(s, "old", 1, 1);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    s = trial(s, "new", 2, 2);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
    const before = history(s);
    s = crystallize(s, p, "Procedure B");
    expect(history(s)).toEqual(before);
    expect(skillMetaFromMemory(s)!.status).toBe("active");
  });

  it("retains a distinct rebuild when content returns from A to B to A", () => {
    const p = updatePolicy(policy(), "A", { A: 1 });
    let s = trial(crystallize(undefined, p), "old", 1, 1);
    s = crystallize(s, p, "Procedure B");
    s = trial(s, "new", 2, 2);
    s = crystallize(s, p, "Procedure A");
    const events = history(s).events;
    expect(events.map(event => event.type)).toEqual(["crystallization", "trial", "crystallization", "trial", "crystallization"]);
    expect(new Set(events.map(event => event.id)).size).toBe(events.length);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    s = trial(s, "new", 2, 1);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
  });

  it("keeps the rebuild after trials while repeatedly correcting its Policy evidence", () => {
    let p = updatePolicy(policy(), "A", { A: 1 });
    let s = trial(crystallize(undefined, p), "old", 1, 1);
    s = crystallize(s, p, "Procedure B");
    const identities = history(s).events.map(event => event.id);
    for (const value of [0.6, 0.4, 0.8]) {
      p = updatePolicy(p, "A", { A: value });
      s = crystallize(drift(s, p), p);
      expect(history(s).events.map(event => event.id)).toEqual(identities);
      expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    }
    s = trial(s, "old", 0, 0);
    expect(skillMetaFromMemory(s)!.status).toBe("candidate");
    expect(skillMetaFromMemory(s)!.trialsAttempted).toBe(0);
  });

  it("preserves a later manual checkpoint when replaying old trials and duplicate content", () => {
    const p = updatePolicy(policy(), "A", { A: 1 });
    let s = crystallize(trial(crystallize(undefined, p), "old", 1, 1), p, "Procedure B");
    Object.assign(s.properties.internal_info.skill as object, { eta: 0.73, status: "active" });
    s.status = "activated";
    s = trial(s, "old", 1, 0);
    s = crystallize(s, p);
    expect(skillMetaFromMemory(s)!).toMatchObject({ eta: 0.73, status: "active", trialsAttempted: 1, trialsPassed: 0 });
    expect(history(s).events.at(-1)!.type).toBe("checkpoint");
  });

  it("keeps a public manual archive during a rebuild and older verdict correction", () => {
    const p = updatePolicy(policy(), "A", { A: 1 });
    let s = trial(crystallize(undefined, p), "old", 1, 1);
    s.status = "archived";
    s.properties.internal_info.skill_manually_archived = true;
    s = crystallize(s, p, "Procedure B");
    s = trial(s, "old", 0, 0);
    expect(s.status).toBe("archived");
    expect(skillMetaFromMemory(s)!.status).toBe("archived");
    expect(history(s).externallyArchived).toBe(true);
  });
});
