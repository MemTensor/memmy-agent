import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { l2ComparisonScope } from "../../../src/service/evolution/l2-comparison-scope.js";
import { assignedEpisodeId, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertTracePolicyLinkForTest, queueSkillCrystallizationJobForTest } from "../../fixtures/evolution-fixture.js";
import { createNoToolSkillLlm } from "./evolution-llm-stubs.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(async () => { await cleanup(); vi.useRealTimers(); });

describe("L2 to Skill durable recovery", () => {
  it.each(["transport", "invalid-json-shape", "unconfigured", "invalid-tools", "evidence-changed", "exhausted", "skip"])(
    "preserves input and reports the right outcome on %s", async (scenario) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const base = createNoToolSkillLlm();
      let recovering = false;
      let calls = 0;
      let mutateEvidence = () => {};
      const llm: LlmClient = {
        ...base,
        isConfigured: () => scenario !== "unconfigured" || recovering,
        async completeJson<T extends Record<string, unknown>>(messages: Parameters<LlmClient["completeJson"]>[0], options: Parameters<LlmClient["completeJson"]>[1]): Promise<T> {
          if (options.operation !== "skill.crystallize") return base.completeJson<T>(messages, options);
          calls++;
          if (!recovering) {
            if (scenario === "transport" || scenario === "exhausted") throw new Error("provider temporarily unavailable");
            if (scenario === "invalid-json-shape") return {} as T;
            if (scenario === "skip") return { skip: true } as unknown as T;
            if (scenario === "evidence-changed") mutateEvidence();
          }
          const result = await base.completeJson<T>(messages, options);
          return !recovering && scenario === "invalid-tools"
            ? { ...result, tools: ["invented_tool"] } : result;
        }
      };
      const config = structuredClone(LEGACY_TEST_CONFIG);
      config.algorithm.capture.embedAfterCapture = false;
      config.algorithm.capture.synthReflection = false;
      config.algorithm.skill.cooldownMs = 60_000;
      const { db, service } = createTestService({ config, skillLlm: llm });
      try {
        const userId = `skill-recovery-${scenario}`;
        const session = service.openSession({ namespace: { source: "codex", profileId: "jiang", userId } });
        const complete = await service.completeTurn("evidence", { sessionId: session.sessionId, episodeId: "episode",
          query: "python pytest inspect failure retry after fixing issue",
          answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result." });
        insertActivePolicyMemory(db, { id: "policy", userId, sessionId: session.sessionId, agentId: "codex", appId: "",
          profileId: "jiang", sourceTraceId: complete.l1MemoryId, sourceEpisodeId: assignedEpisodeId(service, complete) });
        // Public capture uses the device owner; the retained historical Policy
        // requires an actual attributed support link to trust that source.
        // The session has no project; normal memory writes store absent appId
        // as NULL instead of this older SQL helper's empty-string placeholder.
        db.db.prepare("UPDATE memories SET app_id = NULL WHERE id = 'policy'").run();
        const repos = new Repositories(db.db);
        const source = repos.memories.get(complete.l1MemoryId)!;
        expect(l2ComparisonScope(source)).toBe(l2ComparisonScope(repos.memories.get("policy")!));
        insertTracePolicyLinkForTest(db, { userId: source.userId, l1MemoryId: source.id, l2MemoryId: "policy" });
        db.db.prepare("UPDATE evolution_jobs SET status = 'succeeded'").run();
        mutateEvidence = () => db.db.prepare("UPDATE memories SET version = version + 1 WHERE id = ?").run(complete.l1MemoryId);
        queueSkillCrystallizationJobForTest(db, { id: "extract", userId, sessionId: session.sessionId,
          episodeId: assignedEpisodeId(service, complete), policyId: "policy" });
        const run = () => service.runWorkerOnce(1, { targetMemoryIds: ["policy"] });
        const retryWhenDue = async () => {
          // Both the durable queue and the semantic-input attempt ledger impose
          // backoff. Let time pass without rewriting either production record.
          const queued = db.db.prepare("SELECT available_at FROM evolution_jobs WHERE id = 'extract'")
            .get() as { available_at: string };
          const ledger = db.db.prepare("SELECT value_json FROM runtime_kv WHERE key = 'skill_crystallization_attempt:policy:new'")
            .get() as { value_json: string } | undefined;
          const nextAttempt = ledger ? JSON.parse(ledger.value_json).nextEligibleAt : undefined;
          const dates = [Date.now(), Date.parse(queued.available_at), nextAttempt ? Date.parse(nextAttempt) : 0];
          vi.setSystemTime(Math.max(...dates.filter(Number.isFinite)) + 1);
          await run();
        };
        const job = () => db.db.prepare("SELECT status, attempts, last_error FROM evolution_jobs WHERE id = 'extract'").get() as { status: string; attempts: number; last_error: string };
        const skills = () => db.db.prepare("SELECT id FROM memories WHERE memory_layer = 'Skill'").all();
        await run();
        expect(skills()).toHaveLength(0);
        if (scenario === "skip") {
          expect(job().status).toBe("succeeded");
          expect(calls).toBe(1);
          return;
        }
        expect(job()).toMatchObject({ status: "failed", attempts: 1 });
        expect(job().last_error).toBeTruthy();
        expect(db.db.prepare("SELECT id FROM memories WHERE id = ?").get(complete.l1MemoryId)).toBeTruthy();
        await run();
        expect(job()).toMatchObject({ status: "failed", attempts: 1 });
        if (scenario === "exhausted") {
          await retryWhenDue(); await retryWhenDue();
          expect(job()).toMatchObject({ status: "dead_letter", attempts: 3 });
          expect(skills()).toHaveLength(0);
          expect(calls).toBe(3);
          await run();
          expect(calls).toBe(3);
          return;
        }
        recovering = true;
        await retryWhenDue();
        expect(job()).toMatchObject({ status: "succeeded", attempts: 2 });
        expect(skills()).toHaveLength(1);
        expect(calls).toBe(scenario === "unconfigured" ? 1 : 2);
        await run();
        expect(skills()).toHaveLength(1);
      } finally { await service.stop(); db.close(); }
    }
  );
});
