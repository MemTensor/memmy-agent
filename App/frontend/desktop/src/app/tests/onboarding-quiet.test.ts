/**
 * Who owns the screen right now: the existing new-user guidance decides whether the collaboration announcement may be
 * offered, and `armed` is a leftover marker from older builds that shows nothing and must not block it forever.
 */
import { describe, expect, it } from "vitest";
import { existingGuidanceComplete, guidanceStepOnScreen } from "../use-onboarding-quiet.js";

describe("guidance step on screen", () => {
  it("counts the dialogs and tours that cover the workspace", () => {
    expect(guidanceStepOnScreen("improvement")).toBe(true);
    expect(guidanceStepOnScreen("product_tour")).toBe(true);
    expect(guidanceStepOnScreen("nickname")).toBe(true);
  });

  it("does not count a step that only waits for a first click, nor no step at all", () => {
    expect(guidanceStepOnScreen("armed")).toBe(false);
    expect(guidanceStepOnScreen(null)).toBe(false);
  });
});

describe("existing guidance complete", () => {
  const done = { guidanceCompleted: true, onboardingCompleted: true, deferredStep: null };

  it("accepts the machine-wide completion mark", () => {
    expect(existingGuidanceComplete(done)).toBe(true);
  });

  it("accepts an account that finished onboarding elsewhere with nothing left to show", () => {
    expect(existingGuidanceComplete({ ...done, guidanceCompleted: false })).toBe(true);
  });

  it("waits for a queued improvement program, tour or nickname step", () => {
    for (const step of ["improvement", "product_tour", "nickname"] as const) {
      expect(existingGuidanceComplete({ ...done, guidanceCompleted: false, deferredStep: step })).toBe(false);
    }
  });

  it("treats the legacy `armed` marker as nothing left to show", () => {
    expect(existingGuidanceComplete({ ...done, guidanceCompleted: false, deferredStep: "armed" })).toBe(true);
  });

  it("does not accept a guide that never finished onboarding and never completed here", () => {
    expect(existingGuidanceComplete({ guidanceCompleted: false, onboardingCompleted: false, deferredStep: null }))
      .toBe(false);
  });
});
