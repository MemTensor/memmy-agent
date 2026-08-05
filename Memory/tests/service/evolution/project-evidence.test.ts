import { describe, expect, it } from "vitest";
import { extractProjectEvidence } from "../../../src/service/evolution/project-evidence.js";

describe("project evidence extraction", () => {
  it.each([
    "<codex_internal_context source=\"goal\">continue working</codex_internal_context>",
    "You are a focused child agent spawned by a parent agent.",
    "What is the architecture?",
    "继续"
  ])("rejects %s as non-evidence", (userText) => {
    expect(extractProjectEvidence({ id: "noise", userText }).eligible).toBe(false);
  });

  it("classifies a tool-backed successful procedure as eligible outcome evidence", () => {
    const evidence = extractProjectEvidence({
      id: "trace-1",
      userText: "Run the migration and verify the schema.",
      agentText: "Migration completed successfully; the schema check passed.",
      toolCalls: [{ name: "shell", output: "exit code 0" }]
    });
    expect(evidence).toMatchObject({ kind: "outcome", eligible: true });
    expect(evidence.stableKey).toMatch(/^evidence:/);
  });

  it("uses the same stable key for equivalent evidence", () => {
    const a = extractProjectEvidence({ id: "a", userText: "Run tests", agentText: "Tests passed" });
    const b = extractProjectEvidence({ id: "b", userText: " Run   tests ", agentText: "Tests passed" });
    expect(a.stableKey).toBe(b.stableKey);
  });
});
