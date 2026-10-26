import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage, type LlmCompletionOptions } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, queueSkillCrystallizationJobForTest } from "../../fixtures/evolution-fixture.js";
import { createNoToolSkillLlm } from "./evolution-llm-stubs.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

describe("MEMMY-647 skill conflict retry", () => {
  it.each(["policy", "trace"] as const)("retries a discarded draft during cooldown after %s changes", async changedSource => {
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.skill.cooldownMs = 60_000;
    config.algorithm.capture.synthReflection = false;
    config.algorithm.capture.embedAfterCapture = false;
    const base = createNoToolSkillLlm();
    let calls = 0;
    let mutate = () => {};
    const llm: LlmClient = {
      ...base,
      async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
        const result = await base.completeJson<T>(messages, options);
        if (options.operation === "skill.crystallize" && ++calls === 1) mutate();
        return result;
      }
    };
    const { db, service } = fixture.createTestService({ skillLlm: llm, config });
    const repos = new Repositories(db.db);
    const userId = "647-conflict";
    const session = service.openSession({ namespace: { source: "codex", profileId: "jiang", userId } });
    const complete = service.completeTurn("647-conflict-source", {
      sessionId: session.sessionId,
      query: "python pytest inspect failure retry after fixing issue",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "647-conflict-policy", userId, sessionId: session.sessionId,
      agentId: "codex", appId: "audit", profileId: "jiang",
      sourceTraceId: complete.l1MemoryId, sourceEpisodeId: complete.episodeId
    });
    db.db.prepare("UPDATE evolution_jobs SET status = 'succeeded'").run();
    mutate = () => {
      const memory = repos.memories.get(changedSource === "policy" ? "647-conflict-policy" : complete.l1MemoryId)!;
      repos.memories.update({ ...memory, memoryValue: `${memory.memoryValue}\nVerify the exact failing test.` });
    };
    queueSkillCrystallizationJobForTest(db, {
      id: "647-conflict-job", userId, sessionId: session.sessionId,
      episodeId: complete.episodeId, policyId: "647-conflict-policy"
    });

    await service.runWorkerOnce(1);
    expect(repos.runtime.getJob("647-conflict-job")).toMatchObject({
      status: "failed", attempts: 1, lastError: expect.stringContaining("skill evidence changed")
    });
    expect(repos.memories.list({ memoryLayer: "Skill" }, 10)).toHaveLength(0);

    await service.runWorkerOnce(1);
    expect(repos.runtime.getJob("647-conflict-job")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(repos.memories.list({ memoryLayer: "Skill" }, 10)).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
