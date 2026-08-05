import { describe, expect, it } from "vitest";
import { PROJECT_EVIDENCE_DATASET } from "../../fixtures/project-evidence-dataset.js";
import { extractProjectEvidence } from "../../../src/service/evolution/project-evidence.js";

describe("project evidence replay quality set", () => {
  it("contains 30 episodes with explicit expected labels", () => {
    expect(PROJECT_EVIDENCE_DATASET).toHaveLength(30);
    expect(new Set(PROJECT_EVIDENCE_DATASET.map((item) => item.label))).toEqual(new Set(["noise", "evidence"]));
  });

  it("keeps noise out and admits only evidence episodes", () => {
    const results = PROJECT_EVIDENCE_DATASET.map((item) => ({ item, result: extractProjectEvidence(item.input) }));
    expect(results.filter(({ item, result }) => item.label === "noise" && result.eligible)).toHaveLength(0);
    expect(results.filter(({ item, result }) => item.label === "evidence" && !result.eligible)).toHaveLength(0);
  });
});
