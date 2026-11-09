import { afterEach, describe, expect, it } from "vitest";
import { localCalendarDate } from "@memmy/agent-source-core";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { Embedder, LlmClient } from "../../../src/model/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { memoryVector } from "../../../src/storage/memory-vector-state.js";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../../../src/service/memory-token-budget-ledger.js";
import { WorkerConcurrencyController, providerDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("feedback experience worker model admission", () => {
  it.each([false, true])("resumes deferred feedback through refinement and embedding with all permits (separate embedding provider=%s)", async separateProvider => {
    const controller = new WorkerConcurrencyController({}, {});
    const algorithm = { ...DEFAULT_MEMMY_CONFIG.algorithm,
      l2Induction: { ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction, mode: "legacy" as const } };
    const resumed = byokRuntimeConfig({ algorithm, tokenBudget: { dailyLimitM: 0, totalLimitM: 0 } });
    const embeddingConfig = { ...resumed.embedding,
      ...(separateProvider ? { endpoint: "https://embedding.test.invalid/v1", sourceProvider: "review-embedding" } : {}) };
    const operations: string[] = [], embedded: Array<{ texts: string[]; role?: string }> = [];
    const vector = [0.1, 0.2, 0.3];
    const llm: LlmClient = {
      config: resumed.evolution, isConfigured: () => true,
      complete: async () => "{}",
      completeJson: async <T extends Record<string, unknown>>(_messages: unknown, options: { operation: string }) => {
        operations.push(options.operation);
        const snapshot = controller.snapshot();
        expect(snapshot.activeJobs).toBe(1);
        expect(snapshot.embeddingRequests).toBe(1);
        return { title: "Validate issuer fields", trigger: "When parsing SEC 13F filings.",
          procedure: "Read issuer names from filing fields rather than filenames.",
          verification: "Match each issuer field to its CUSIP record.", caveats: ["Do not infer issuers from filenames."], confidence: 0.9 } as unknown as T;
      },
      status: () => ({ provider: resumed.evolution.provider, model: resumed.evolution.model, configured: true, remote: true })
    };
    function recordEmbedding(texts: string[], role?: "query" | "document") {
      embedded.push({ texts, role });
      const snapshot = controller.snapshot();
      expect(snapshot.activeJobs).toBe(1);
      expect(snapshot.resources).toEqual({ evolution_llm: 1 });
      expect(snapshot.embeddingRequests).toBe(1);
      for (const provider of providerDescriptor(embeddingConfig, controller.limits).providers) {
        expect(snapshot.providers[provider.key]).toBe(1);
      }
    }
    const embedder: Embedder = {
      config: embeddingConfig, isRemote: () => true,
      embed: async (texts, role) => { recordEmbedding(texts, role); return texts.map(() => [...vector]); },
      embedOne: async (text, role) => { recordEmbedding([text], role); return [...vector]; },
      status: () => ({ provider: embeddingConfig.provider, model: embeddingConfig.model, configured: true, remote: true })
    };
    const { db, service } = createTestService({ concurrency: controller,
      config: byokRuntimeConfig({ algorithm, tokenBudget: { dailyLimitM: 1, totalLimitM: 500 } }),
      configLoader: () => ({ config: resumed }), llm, skillLlm: llm, embedder });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, { dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000, dailyDate: localCalendarDate() });
    const session = service.openSession({ namespace: { source: "codex", profileId: "review", userId: "review-user" } });
    const complete = await service.completeTurn("feedback-admission-turn", { sessionId: session.sessionId,
      query: "Parse a SEC 13F filing and extract issuer CUSIP holdings.", answer: "Parsed the filing and validated the issuer field." });
    const episode = repos.runtime.createEpisode({ id: "feedback-admission-episode", sessionId: session.sessionId,
      userId: "review-user", status: "open", rawTurnIds: [complete.rawTurnId], l1MemoryIds: [complete.l1MemoryId],
      feedbackIds: [], decisionRepairIds: [], l2PolicyIds: [], l3WorldModelIds: [], skillMemoryIds: [],
      turnCount: 1, rewardDetail: {}, pipelineStatus: "idle", meta: {}, openedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const raw = repos.runtime.getRawTurn(complete.rawTurnId)!;
    repos.runtime.updateRawTurn({ ...raw, episodeId: episode.id,
      messagePayload: { ...raw.messagePayload, episode_assignment: { status: "assigned" } } });
    complete.episodeId = episode.id;
    const feedback = await service.feedback({ sessionId: session.sessionId, episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId, channel: "explicit", polarity: "positive", magnitude: 1,
      rationale: "Verifier feedback: success. Next time keep the issuer name out of the filename.", rawPayload: { source: "verifier", score: 1 } });
    const queued = repos.runtime.listJobs(undefined, 100).filter(job => job.jobType === "feedback_experience");
    expect(queued).toHaveLength(1);
    expect(operations).toEqual([]);
    expect(embedded).toEqual([]);
    // Isolate the feedback drain while retaining the real producer's record.
    db.db.prepare("UPDATE evolution_jobs SET available_at='2100-01-01T00:00:00.000Z' WHERE job_type!='feedback_experience'").run();
    service.reloadConfig();
    const run = await service.runWorkerOnce(1);
    expect(run).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(repos.runtime.getJob(queued[0]!.id)).toMatchObject({ status: "succeeded", attempts: 1, failureCount: 0, leaseToken: null });
    expect(operations).toEqual(["feedback.refine.v1"]);
    expect(embedded).toEqual([{ texts: [expect.stringContaining("Read issuer names from filing fields")], role: "query" }]);
    const policies = db.db.prepare("SELECT id,properties_json FROM memories WHERE user_id='review-user' AND memory_layer='L2'").all() as Array<{ id: string; properties_json: string }>;
    expect(policies).toHaveLength(1);
    const policy = JSON.parse(policies[0]!.properties_json).internal_info.policy;
    expect(policy).toMatchObject({ title: "Success: Validate issuer fields", evidence_polarity: "positive",
      source_feedback_ids: [feedback.feedbackId], source_trace_ids: [complete.l1MemoryId] });
    const savedVector = memoryVector(repos.memories.get(policies[0]!.id)!, "vec")!;
    expect(savedVector).toHaveLength(vector.length);
    vector.forEach((value, index) => expect(savedVector[index]).toBeCloseTo(value));
    expect(controller.snapshot()).toEqual({ activeJobs: 0, availableJobs: 4, backgroundActiveJobs: 0, maxBackgroundJobs: 3, interactiveReservedSlots: 1, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
    await service.stop();
  });
});
