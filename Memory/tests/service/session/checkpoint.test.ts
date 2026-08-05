import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / session / checkpoint", () => {
  it("persists a structured handoff through the existing compact trace path", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "main",
      userId: "checkpoint-user",
      workspacePath: "/work/checkpoint-project"
    };
    const session = service.openSession({ namespace, sessionId: "checkpoint-session" });
    const result = service.checkpointSession(session.sessionId, {
      namespace,
      task: "Absorb the useful Remnic memory behaviors",
      changes: ["Added project isolation", "Added Markdown audit"],
      validated: ["Namespace tests pass"],
      unverified: ["Full suite not run"],
      nextSteps: ["Inspect graph relations", "Measure rerank filtering"],
      tokenEstimate: 120
    });

    expect(result.checkpointId).toBe(result.rawTurnId);
    expect(result.checkpoint).toEqual({
      task: "Absorb the useful Remnic memory behaviors",
      changes: ["Added project isolation", "Added Markdown audit"],
      validated: ["Namespace tests pass"],
      unverified: ["Full suite not run"],
      nextSteps: ["Inspect graph relations", "Measure rerank filtering"]
    });
    expect(result.memorySnapshot.summary).toContain("Task: Absorb the useful Remnic memory behaviors");
    expect(result.memorySnapshot.summary).toContain("- Full suite not run");
    expect(result.l1MemoryId).toMatch(/^trace_/u);

    const row = db.db.prepare(
      "SELECT message_payload_json FROM raw_turns WHERE id = ?"
    ).get(result.rawTurnId) as { message_payload_json: string };
    expect(JSON.parse(row.message_payload_json)).toMatchObject({
      compact: {
        checkpoint: {
          task: "Absorb the useful Remnic memory behaviors",
          validated: ["Namespace tests pass"],
          unverified: ["Full suite not run"]
        }
      }
    });
    db.close();
  });
});

