import { initialPolicyContributions, policyGainSourceStages, revisePolicySources } from "../../../src/service/evolution/episode-contributions.js";
import { describe, expect, it } from "vitest";
import { initialSkillEtaContributions, readSkillEtaContributions, reviseSkillEtaBaseline,
  reviseSkillEtaSource, reviseSkillEtaTrial } from "../../../src/service/evolution/skill-eta-contributions.js";

const initial = () => initialSkillEtaContributions("body:1", { eta: 0.6, attempts: 0, passes: 0 });
function sequence() {
  const a = reviseSkillEtaSource(initial(), "body:1", "policy:A", 0.2);
  const trial = reviseSkillEtaTrial(a, "body:1", "trial:1", "success");
  return reviseSkillEtaSource(trial, "body:1", "policy:B", 0.8);
}

describe("MEMMY-647 ordered skill eta contract", () => {
  it("matches a single final-source update after replacing the earlier source result", () => {
    const once = reviseSkillEtaSource(initial(), "body:1", "policy:A", 0.4);
    const old = reviseSkillEtaSource(initial(), "body:1", "policy:A", 0.9);
    const reprocessed = reviseSkillEtaSource(old, "body:1", "policy:A", 0.4);
    expect(reprocessed).toEqual(once);
    expect(reprocessed.last.eta).toBeCloseTo(0.54);
  });
  it("revises A before an independent successful trial and B using the original formulas", () => {
    const old = sequence();
    expect(old.last).toEqual({ eta: 0.758, attempts: 1, passes: 1 });
    const revised = reviseSkillEtaSource(old, "body:1", "policy:A", 0.4);
    expect(revised.last.eta).toBeCloseTo(0.779);
    expect(revised.last).toMatchObject({ attempts: 1, passes: 1 });
    expect(revised.order).toHaveLength(3);
    expect(reviseSkillEtaSource(revised, "body:1", "policy:A", 0.4)).toEqual(revised);
    expect(old).toEqual(sequence()); // The caller's prior state remains untouched.
  });

  it("rejudges the same trial in its original position, retaining the later source", () => {
    const revised = reviseSkillEtaTrial(sequence(), "body:1", "trial:1", "failure");
    expect(revised.last.eta).toBeCloseTo(0.408);
    expect(revised.last).toMatchObject({ attempts: 1, passes: 0 });
    expect(reviseSkillEtaTrial(revised, "body:1", "trial:1", "failure")).toEqual(revised);
    expect(reviseSkillEtaTrial(revised, "body:1", "trial:1", "success")).toEqual(sequence());
  });

  it("withdraws and restores A without erasing the trial or B", () => {
    const withdrawn = reviseSkillEtaSource(sequence(), "body:1", "policy:A", null);
    expect(withdrawn.last.eta).toBeCloseTo(0.8);
    expect(withdrawn.last).toMatchObject({ attempts: 1, passes: 1 });
    expect(reviseSkillEtaSource(withdrawn, "body:1", "policy:A", 0.2)).toEqual(sequence());
  });

  it("withdraws a trial result without leaving a phantom attempt, and restores its position", () => {
    const withdrawn = reviseSkillEtaTrial(sequence(), "body:1", "trial:1", null);
    expect(withdrawn.last.eta).toBeCloseTo(0.576);
    expect(withdrawn.last).toMatchObject({ attempts: 0, passes: 0 });
    expect(reviseSkillEtaTrial(withdrawn, "body:1", "trial:1", "success")).toEqual(sequence());
  });

  it("revises a proven crystallization baseline without adding another drift", () => {
    const trial = reviseSkillEtaTrial(initial(), "body:1", "trial:1", "success");
    const b = reviseSkillEtaSource(trial, "body:1", "policy:B", 0.8);
    const revised = reviseSkillEtaBaseline(b, "body:1", { eta: 0.4, attempts: 0, passes: 0 });
    expect(revised.last.eta).toBeCloseTo(0.73);
    expect(revised.order).toHaveLength(2);
    expect(revised.last).toMatchObject({ attempts: 1, passes: 1 });
  });

  it("preserves unexplained manual statistics as a checkpoint rather than an invented trial", () => {
    const revised = reviseSkillEtaSource(sequence(), "body:1", "policy:A", 0.4, { eta: 0.91, attempts: 7, passes: 6 });
    expect(revised.last).toEqual({ eta: 0.91, attempts: 7, passes: 6 });
    expect(revised.order).toHaveLength(4);
    expect(reviseSkillEtaSource(revised, "body:1", "policy:A", 0.2).last).toEqual(revised.last);
    expect(reviseSkillEtaTrial(revised, "body:1", "trial:2", "failure").last).toEqual({ eta: 7 / 9, attempts: 8, passes: 6 });
  });

  it("rejects reusing old-body trials after a content revision", () => {
    expect(() => reviseSkillEtaTrial(sequence(), "body:2", "trial:2", "success")).toThrow("content changed");
    expect(initialSkillEtaContributions("body:2", { eta: 0.6, attempts: 0, passes: 0 }).last)
      .toEqual({ eta: 0.6, attempts: 0, passes: 0 });
  });

  it("keeps source and trial identities distinct even if their external IDs match", () => {
    const source = reviseSkillEtaSource(initial(), "body:1", "same-id", 0.2);
    const trial = reviseSkillEtaTrial(source, "body:1", "same-id", "success");
    expect(trial.order).toHaveLength(2);
    expect(readSkillEtaContributions(JSON.parse(JSON.stringify(trial)))).toEqual(trial);
  });

  it("does not grow storage after 1000 same-source/trial revisions", () => {
    let state = sequence();
    for (let i = 0; i < 1000; i++) {
      state = reviseSkillEtaSource(state, "body:1", "policy:A", i % 2);
      state = reviseSkillEtaTrial(state, "body:1", "trial:1", i % 2 ? "success" : "failure");
    }
    expect(state.order).toHaveLength(3);
    expect(JSON.stringify(state).length).toBeLessThan(600);
    expect(readSkillEtaContributions(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects unknown, duplicate, inconsistent or malformed persisted history", () => {
    expect(() => readSkillEtaContributions({ schemaVersion: 815 })).toThrow("preserve for review");
    const state = sequence();
    expect(() => readSkillEtaContributions({ ...state, order: [...state.order, state.order[0]] })).toThrow("preserve for review");
    expect(() => readSkillEtaContributions({ ...state, last: { ...state.last, eta: 0.2 } })).toThrow("preserve for review");
    expect(() => readSkillEtaContributions({ ...state, baseline: { eta: 0.6, attempts: 1, passes: 2 } })).toThrow("preserve for review");
    expect(readSkillEtaContributions(undefined)).toBeUndefined();
  });
});


describe("MEMMY-647 Policy to Skill source projection", () => {
  it("recomputes dependent B magnitude when A changes, without moving the independent trial", () => {
    const source = (id: string, value: number) => ({ id, supportValues: [value], referenceValues: [] });
    const a = revisePolicySources(initialPolicyContributions(0.2, 1, 0.4, 0.5), [source("A", 1)], 0.2);
    let eta = initial();
    const project = (policy: typeof a) => {
      for (const stage of policyGainSourceStages(policy)) eta = reviseSkillEtaSource(eta, "body:1",
        `policy:r1:${stage.position}`, stage.active ? stage.gain : null);
    };
    project(a);
    expect(eta.last.eta).toBeCloseTo(0.516);
    eta = reviseSkillEtaTrial(eta, "body:1", "trial:1", "success");
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    project(ab);
    expect(eta.last.eta).toBeCloseTo(0.6362);
    const revised = revisePolicySources(ab, [source("A", 0.4), source("B", 0.8)], ab.lastGain);
    project(revised);
    expect(eta.last.eta).toBeCloseTo(0.539);
    expect(eta.order).toHaveLength(3);
    expect(eta.last).toMatchObject({ attempts: 1, passes: 1 });
    const before = structuredClone(eta);
    project(revised);
    expect(eta).toEqual(before);
  });

  it("keeps projection positions stable across withdrawal and restore", () => {
    const a = { id: "A", supportValues: [1], referenceValues: [] };
    const b = { id: "B", supportValues: [0.8], referenceValues: [] };
    const first = revisePolicySources(initialPolicyContributions(0.2, 1, 0.4, 0.5), [a], 0.2);
    const both = revisePolicySources(first, [a, b], first.lastGain);
    const withdrawn = revisePolicySources(both, [b], both.lastGain);
    expect(policyGainSourceStages(withdrawn)).toEqual([
      { position: 0, active: false, gain: 0.2, support: 1 },
      { position: 1, active: true, gain: 0.24000000000000002, support: 1 }
    ]);
    const restored = revisePolicySources(withdrawn, [a, b], withdrawn.lastGain);
    expect(policyGainSourceStages(restored)).toEqual(policyGainSourceStages(both));
    expect(JSON.stringify(both)).not.toContain("stages");
  });
});
