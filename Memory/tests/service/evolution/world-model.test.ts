import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory } from "../../fixtures/evolution-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("MemoryService / evolution / legacy world model", () => {
  it("does not generate policy-derived legacy L3 records after schema v6", async () => {
    const { db, service } = createTestService();
    insertActivePolicyMemory(db, {
      id: "policy_no_legacy_world_model",
      userId: "world-model-user",
      sessionId: "world-model-session",
      agentId: "codex",
      appId: "world-model-workspace",
      profileId: "default",
      sourceTraceId: "trace_world_model",
      sourceEpisodeId: "episode_world_model"
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const job = repos.runtime.enqueueJob({
      id: "job_legacy_l3_noop",
      jobType: "l3_abstraction",
      status: "queued",
      userId: "world-model-user",
      payload: {
        targetKind: "policy_cluster",
        seedPolicyId: "policy_no_legacy_world_model",
        policyIds: ["policy_no_legacy_world_model"]
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: at,
      updatedAt: at
    });

    await service.runWorkerOnce(10);

    expect(repos.runtime.getJob(job.id)?.status).toBe("succeeded");
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'L3'`
    ).get()).toEqual({ count: 0 });
  });
});
