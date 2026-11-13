import { describe, expect, it } from "vitest";
import { initialPolicyContributions, revisePolicySources, revisePolicyFeedback, readPolicyContributions } from "../../../src/service/evolution/episode-contributions.js";

const source = (id: string, value: number) => ({ id, supportValues: [value], referenceValues: [] });
const initial = () => initialPolicyContributions(0.2, 1, 0.4, 0.5);

describe("MEMMY-647 ordered policy contributions", () => {
  it("matches final evidence processed once after an old result is replaced", () => {
    const once = revisePolicySources(initial(), [source("A", 0.4)], 0.2);
    const old = revisePolicySources(initial(), [source("A", 1)], 0.2);
    const reprocessed = revisePolicySources(old, [source("A", 0.4)], old.lastGain);
    expect(reprocessed).toEqual(once);
    expect(reprocessed.lastGain).toBeCloseTo(0.12);
  });
  it("replaces A before B without another smoothing operation", () => {
    const a = revisePolicySources(initial(), [source("A", 1)], 0.2);
    expect(a.lastGain).toBeCloseTo(0.32);
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    expect(ab.lastGain).toBeCloseTo(0.352);
    const revised = revisePolicySources(ab, [source("A", 0.4), source("B", 0.8)], ab.lastGain);
    expect(revised.lastGain).toBeCloseTo(0.112);
    expect(revisePolicySources(revised, [source("A", 0.4), source("B", 0.8)], revised.lastGain)).toEqual(revised);
  });

  it("keeps identified feedback at its original position and handles its retry", () => {
    const a = revisePolicySources(initial(), [source("A", 1)], 0.2);
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    const feedback = revisePolicyFeedback(ab, "feedback-one", 0.02);
    const revised = revisePolicySources(feedback, [source("A", 0.4), source("B", 0.8)], feedback.lastGain);
    expect(revised.lastGain).toBeCloseTo(0.132);
    expect(revisePolicyFeedback(revised, "feedback-one", 0.02)).toEqual(revised);
    expect(revisePolicyFeedback(revised, "feedback-one", -0.02).lastGain).toBeCloseTo(0.092);
  });

  it("preserves an unclassified scalar edit as an explicit checkpoint", () => {
    const a = revisePolicySources(initial(), [source("A", 1)], 0.2);
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    expect(revisePolicySources(ab, [source("A", 0.4), source("B", 0.8)], 0.372).lastGain).toBe(0.372);
  });

  it("withdraws and restores a source in place", () => {
    const a = revisePolicySources(initial(), [source("A", 1)], 0.2);
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    const withdrawn = revisePolicySources(ab, [source("B", 0.8)], ab.lastGain);
    // Only B remains: raw .3, against the unchanged pre-A baseline .2.
    expect(withdrawn.lastGain).toBeCloseTo(0.24);
    const restored = revisePolicySources(withdrawn, [source("A", 1), source("B", 0.8)], withdrawn.lastGain);
    expect(restored.lastGain).toBeCloseTo(ab.lastGain);
    expect(restored.order).toHaveLength(2);
  });

  it("does not grow its source history when the same source is revised repeatedly", () => {
    let state = initial();
    for (let i = 0; i < 1000; i++) state = revisePolicySources(state, [source("A", i % 2)], state.lastGain);
    expect(state.order).toHaveLength(1);
    expect(Object.keys(state.sources)).toEqual(["A"]);
    expect(JSON.stringify(state).length).toBeLessThan(500);
  });
  it("keeps persisted data linear when the number of independent sources doubles", () => {
    function build(count: number) {
      let state = initial();
      const sources = [];
      for (let i = 0; i < count; i++) {
        sources.push(source(`source-${i}`, 0.8));
        state = revisePolicySources(state, sources, state.lastGain);
      }
      return state;
    }
    const smaller = build(100), larger = build(200);
    expect(larger.order).toHaveLength(200);
    expect(JSON.stringify(larger).length / JSON.stringify(smaller).length).toBeLessThan(2.2);
    expect(readPolicyContributions(JSON.parse(JSON.stringify(larger)))).toEqual(larger);
  });

  it("refuses an unknown historical format instead of silently discarding it", () => {
    expect(() => readPolicyContributions({ schemaVersion: 815, history: [] })).toThrow("preserve for review");
  });

});
