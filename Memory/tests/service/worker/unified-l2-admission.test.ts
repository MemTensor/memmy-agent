import { afterEach, describe, expect, it } from "vitest";
import type { Embedder, LlmClient } from "../../../src/model/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { WorkerConcurrencyController, providerDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("unified L2 worker admission", () => {
  it.each(["l2_induction", "l2_association"] as const)("reserves both providers and embedding capacity for %s", async jobType => {
    const config = byokRuntimeConfig();
    config.algorithm.capture.embedAfterCapture = false;
    config.embedding = { ...config.embedding, endpoint: "https://l2-embedding.test.invalid/v1", sourceProvider: "l2-test" };
    const controller = new WorkerConcurrencyController({}, {});
    let queries = 0, extractions = 0;
    function assertPermits() {
      const snapshot = controller.snapshot();
      expect(snapshot.activeJobs).toBe(1);
      expect(snapshot.resources).toEqual({ evolution_llm: 1 });
      expect(snapshot.embeddingRequests).toBe(1);
      for (const model of [config.embedding, config.evolution]) {
        for (const provider of providerDescriptor(model, controller.limits).providers) {
          expect(snapshot.providers[provider.key]).toBe(1);
        }
      }
    }
    const embedder: Embedder = {
      config: config.embedding, isRemote: () => true,
      embed: async texts => { assertPermits(); queries += texts.length; return texts.map(() => [1, 0]); },
      embedOne: async () => { throw new Error("unexpected single embedding"); },
      status: () => ({ provider: config.embedding.provider, model: config.embedding.model, configured: true, remote: true })
    };
    const llm: LlmClient = {
      config: config.evolution, isConfigured: () => true, complete: async () => "{}",
      completeJson: async <T extends Record<string, unknown>>(_messages: unknown, options: { operation: string }) => {
        assertPermits(); expect(options.operation).toBe("l2.extraction.v2"); extractions++;
        return { operations: [{ operation: "create", l1_ids: ["source"], new_l2: {
          type: "check", title: "PPT visual hierarchy", applicability: "Before presenting slides",
          content: "Check that each slide has one clearly dominant heading.", verification: "Review at presentation scale.", exclusions: ""
        } }] } as unknown as T;
      },
      status: () => ({ provider: config.evolution.provider, model: config.evolution.model, configured: true, remote: true })
    };
    const { db, service } = createTestService({ config, concurrency: controller, llm, skillLlm: llm, embedder });
    const repos = new Repositories(db.db), at = new Date().toISOString();
    repos.memories.insert({ id: "source", userId: "u", timeline: at, memoryLayer: "L1", memoryType: "LongTermMemory",
      status: "activated", visibility: "private", memoryValue: "The PPT heading was lost among equal-sized text.",
      tags: [], info: {}, properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: {
        summary: "PPT heading hierarchy needs correction", userText: "Make the heading stand out", agentText: "Increased its size", value: -1
      } } }, version: 1, createdAt: at, updatedAt: at });
    upsertL2Candidate(repos, { sourceMemoryId: "source", userId: "u", route: "negative", at });
    repos.runtime.enqueueJob({ id: "extract", jobType, userId: "u", targetMemoryId: "source", payload: {},
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    const run = await service.runWorkerOnce(1, { targetMemoryIds: ["source"] });
    expect(run).toMatchObject({ succeeded: 1, failed: 0 });
    expect(queries).toBe(1); expect(extractions).toBe(1);
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ activeJobs: 0, embeddingRequests: 0, resources: {}, providers: {} });
  });
});
