import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type Embedder,
  type LlmClient,
  type MemoryRow
} from "../../../src/index.js";
import {
  retrievalDocumentIsCurrent,
  retrievalDocumentSourceHash
} from "../../../src/algorithm/plugin-algorithms.js";
import {
  embeddingTextForMemory,
  updateMemoryVectorField
} from "../../../src/service/embedding/embedding-pipeline.js";
import { l2VectorCacheKey } from "../../../src/service/embedding/l2-vector-cache.js";
import { memoryVector } from "../../../src/storage/memory-vector-state.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { createEmbedder } from "../../../src/model/embedder.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import {
  addAgentSourceImport,
  createBatchReflectionLlm,
  createCapturingEmbedder,
  createMemoryServiceFixture,
  stableTestVector
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MemoryService / embedding / processing", () => {
  it.each([false, true])("reuses exact L2 query vectors across jobs (preseeded: %s)", async (preseeded) => {
    const seen: string[] = [];
    const embedder = createCapturingEmbedder(seen);
    const { db, service } = createTestService({ embedder });
    const repos = new Repositories(db.db);
    const memory = negativePolicyMemory("PPT headings", "Before presenting");
    repos.memories.insert(memory);
    const key = () => l2VectorCacheKey(embedder.config, "query", embeddingTextForMemory(repos.memories.get(memory.id)!));
    if (preseeded) repos.runtime.setKv(key(), [1, 0, 0], memory.createdAt);
    // A document vector must never serve a query request.
    repos.runtime.setKv(l2VectorCacheKey(embedder.config, "document", embeddingTextForMemory(memory)), [0, 1, 0], memory.createdAt);
    async function run(index: number) {
      const id = `l2-cache-job-${index}`;
      repos.runtime.enqueueJob({ id, jobType: "embedding", status: "queued", dedupeKey: id,
        userId: memory.userId, targetMemoryId: memory.id, payload: {}, attempts: 0, maxAttempts: 3,
        createdAt: memory.createdAt, updatedAt: memory.createdAt });
      const result = await service.runWorkerOnce(10);
      expect(result.jobs).toContainEqual(expect.objectContaining({ jobId: id, status: "succeeded" }));
    }
    await run(1);
    await run(2);
    expect(seen).toHaveLength(preseeded ? 0 : 1);
    expect(repos.runtime.getKv(key())?.value).toEqual([1, 0, 0]);
    expect(memoryVector(repos.memories.get(memory.id)!, "vec")).toEqual([1, 0, 0]);
    const changed = repos.memories.get(memory.id)!;
    (changed.properties.internal_info.policy as Record<string, unknown>).trigger = "After a style correction";
    repos.memories.update(changed);
    await run(3);
    expect(seen).toHaveLength(preseeded ? 1 : 2);
    embedder.config.model = "different-model";
    await run(4);
    expect(seen).toHaveLength(preseeded ? 2 : 3);
  });

  for (const queue of ["fresh", "retry"] as const) {
    for (const format of ["code", "message"] as const) {
      it.each([
        ["OperationNotSupported", "The embeddings operation does not work with the specified model.", false],
        ["insufficient_quota", "Insufficient balance.", false],
        ["rate_limit_exceeded", "Rate limit exceeded.", true]
      ] as const)(`${queue} queue does not fan out shared HTTP 400 %s (${format})`, async (code, message, transient) => {
        const inputs: string[][] = [];
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
          inputs.push((JSON.parse(String(init?.body)) as { input: string[] }).input);
          return new Response(JSON.stringify({ error: {
            code: format === "code" ? code : undefined,
            message: format === "message" ? message : "Request rejected"
          } }), { status: 400 });
        });
        vi.stubGlobal("fetch", fetchMock);
        const { db, service } = createTestService({
          // Four background members fit one request while the realtime slot remains reserved.
          concurrency: new WorkerConcurrencyController({ maxActiveJobs: 5 }),
          embedder: createHttpTestEmbedder(),
          llm: createBatchReflectionLlm([], "Synthetic summary.")
        });
        const repos = new Repositories(db.db);
        if (queue === "fresh") {
          const session = service.openSession({ namespace: { source: "codex", profileId: "shared-error", userId: "test" } });
          const ids = await Promise.all(["GOOD_A", "GOOD_B", "GOOD_C"].map(async (answer, i) => (await service.completeTurn(`turn-${i}`, {
            sessionId: session.sessionId, query: "Remember this.", answer
          })).l1MemoryId));
          await prepareFreshEmbeddingBatch(service, ids);
          expect(fetchMock).not.toHaveBeenCalled();
          await service.runWorkerOnce(ids.length, { targetMemoryIds: ids });
          for (const id of ids) expect(repos.processing.get(id)).toMatchObject({
            state: transient ? "embedding_pending" : "failed",
            errorCode: transient ? "transient_provider_error" : "model_configuration",
            retryAction: transient ? "retry" : "open_settings"
          });
        } else {
          const retries = ["GOOD_A", "GOOD_B", "GOOD_C"].map((content, i) => {
            const memory = skillMemory(undefined, { id: `shared-${i}`, content });
            repos.memories.insert(memory);
            return repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: memory.id,
              vectorField: "vec", sourceText: embeddingTextForMemory(memory), embedRole: "query", now: Date.now() - 1 });
          });
          await service.runWorkerOnce(10);
          for (const retry of retries) {
            const stored = repos.runtime.getEmbeddingRetry(retry.id)!;
            expect(stored).toMatchObject({ status: transient ? "pending" : "failed", attempts: transient ? 1 : 0 });
            if (transient) expect(stored.nextAttemptAt).toBeGreaterThan(Date.now());
            else expect(stored.blockedReason).toBe("configuration");
          }
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(inputs.map(input => input.length)).toEqual([3]);
        expect(db.db.prepare("SELECT count(*) AS n FROM memory_vector_entries").get()).toEqual({ n: 0 });
      });
    }

    it.each([
      ["context_length_exceeded", "maximum context length exceeded"],
      ["20015", "The parameter is invalid."]
    ])(`${queue} queue preserves valid siblings through the HTTP adapter (%s)`, async (code, message) => {
      const inputs: string[][] = [];
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const { input } = JSON.parse(String(init?.body)) as { input: string[] };
        inputs.push(input);
        const bad = input.some(text => text.includes("BAD_EMBEDDING_ITEM"));
        return new Response(JSON.stringify(bad ? { code, message } : {
          data: input.map(() => ({ embedding: [1, 0, 0] }))
        }), { status: bad ? 400 : 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { db, service } = createTestService({ embedder: createHttpTestEmbedder(),
        concurrency: new WorkerConcurrencyController({ maxActiveJobs: 5 }),
        llm: createBatchReflectionLlm([], "Synthetic summary.") });
      const repos = new Repositories(db.db);
      const texts = ["GOOD_A", "GOOD_B", "GOOD_C", "BAD_EMBEDDING_ITEM"];
      if (queue === "fresh") {
        const session = service.openSession({ namespace: { source: "codex", profileId: "isolation", userId: "test" } });
        const ids = await Promise.all(texts.map(async (answer, i) => (await service.completeTurn(`turn-${i}`, {
          sessionId: session.sessionId, query: "Remember this.", answer
        })).l1MemoryId));
        await prepareFreshEmbeddingBatch(service, ids);
        expect(fetchMock).not.toHaveBeenCalled();
        await service.runWorkerOnce(ids.length, { targetMemoryIds: ids });
        expect(ids.map(id => repos.processing.get(id)?.state)).toEqual([
          "ready", "ready", "ready", code === "context_length_exceeded" ? "ready_text_only" : "failed"
        ]);
      } else {
        const retries = texts.map((content, i) => {
          const memory = skillMemory(undefined, { id: `isolated-${i}`, content });
          repos.memories.insert(memory);
          return repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: memory.id,
            vectorField: "vec", sourceText: embeddingTextForMemory(memory), embedRole: "query", now: Date.now() - 1 });
        });
        await service.runWorkerOnce(10);
        expect(retries.map(retry => repos.runtime.getEmbeddingRetry(retry.id)?.status)).toEqual([
          "succeeded", "succeeded", "succeeded", "failed"
        ]);
      }
      expect(db.db.prepare("SELECT count(*) AS n FROM memory_vector_entries").get()).toEqual({ n: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(inputs.map(input => input.length)).toEqual([4, 1, 1, 1, 1]);
      for (const marker of texts) expect(inputs[0]!.filter(text => text.includes(marker))).toHaveLength(1);
      await service.runWorkerOnce(20, { priorityCohortOnly: true });
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  }

  it("embeds Skill retrieval metadata instead of the full SKILL.md when short metadata exists", () => {
    const text = embeddingTextForMemory(skillMemory({
      retrievalBlurb: "Use for safe SQLite schema migrations.",
      triggerContext: "Trigger when a task changes tables or indexes."
    }));

    expect(text).toContain("Use for safe SQLite schema migrations.");
    expect(text).toContain("Trigger when a task changes tables or indexes.");
    expect(text).not.toContain("PROCEDURE_ONLY_SENTINEL");
  });

  it("keeps legacy Skill memories searchable through their invocation guide", () => {
    expect(embeddingTextForMemory(skillMemory())).toContain("PROCEDURE_ONLY_SENTINEL");
  });

  it("keeps oversized Skill retrieval documents intact for provider-aware chunking", () => {
    const prefix = "Legacy Skill instructions\n";
    const text = embeddingTextForMemory(skillMemory(undefined, {
      content: `${prefix}${" procedure".repeat(8_000)}\nTAIL_SENTINEL`
    }));

    expect(text).toContain(prefix);
    expect(text).toContain("TAIL_SENTINEL");
  });

  it("marks a replacement Skill vector with its retrieval document version and source hash", () => {
    const memory = skillMemory({
      retrievalBlurb: "Use for safe SQLite schema migrations.",
      triggerContext: "Trigger when a task changes tables or indexes."
    });
    const sourceHash = retrievalDocumentSourceHash(memory);
    const updated = updateMemoryVectorField(memory, "vec", [1, 0], {
      provider: "test",
      model: "test",
      updatedAt: "2026-07-24T01:00:00.000Z",
      sourceHash
    });

    expect(updated.properties.internal_info.retrieval_index).toEqual({
      version: 2,
      source_hash: sourceHash,
      indexed_at: "2026-07-24T01:00:00.000Z"
    });
    expect(retrievalDocumentIsCurrent(updated)).toBe(true);
  });

  it("embeds L3 summary and structure without duplicating the rendered body", () => {
    const text = embeddingTextForMemory(worldModelMemory());

    expect(text).toContain("Schema migrations require staged verification.");
    expect(text).toContain("Environment: SQLite database");
    expect(text).not.toContain("BODY_ONLY_SENTINEL");
  });

  it("falls back to title when negative L2 title and trigger exceed 2048 mixed-language tokens", () => {
    const title = "Avoid";
    const triggerAtLimit = [
      "错".repeat(1_024),
      Array.from({ length: 1_023 }, () => "word").join(" ")
    ].join(" ");

    expect(embeddingTextForMemory(negativePolicyMemory(title, triggerAtLimit))).toBe(
      [title, triggerAtLimit].join("\n")
    );
    expect(embeddingTextForMemory(negativePolicyMemory(title, `${triggerAtLimit} 超`))).toBe(title);
  });

  it("retries trace embedding jobs without leaving the processing state stuck", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = createTestRoot("mindock-memory-embedding-retry-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const embedder = createFlakyEmbedder();
    const service = createTestMemoryService({
      db,
      mode: "dev",
      embedder,
      llm: createBatchReflectionLlm([], "Remember that transient embedding failures should be retried.")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-retry"
      }
    });
    const complete = (await service.completeTurn("turn-retry-1", {
      sessionId: session.sessionId,
      query: "Remember that transient embedding failures should be retried.",
      answer: "I will keep the retry queue durable."
    }));
    const initialMemory = db.db
      .prepare(`SELECT version FROM memories WHERE id = ?`)
      .get(complete.l1MemoryId) as { version: number };

    // Use an explicit one-job budget to inspect the intermediate state before
    // continuous admission can immediately start the generated embedding.
    const summaryRun = await service.runWorkerOnce(1, { targetMemoryIds: [complete.l1MemoryId] });
    expect(summaryRun.jobs.some((job) => job.jobType === "trace_summary" && job.status === "succeeded")).toBe(true);
    const firstRun = await service.runWorkerOnce(1, { targetMemoryIds: [complete.l1MemoryId] });
    const failedEmbedding = firstRun.jobs.find((job) => job.jobType === "embedding" && job.status === "failed");
    expect(failedEmbedding?.jobId).toBeTruthy();
    const failedJob = db.db.prepare(
      `SELECT id, status, attempts FROM evolution_jobs WHERE id = ?`
    ).get(failedEmbedding!.jobId) as { id: string; status: string; attempts: number };
    expect(failedJob).toMatchObject({ status: "failed", attempts: 1 });

    const queued = db.db
      .prepare(
        `SELECT target_kind, target_id, vector_field, status, attempts
         FROM embedding_retry_queue
         WHERE target_id = ?`
      )
      .all(complete.l1MemoryId) as Array<{
        target_kind: string;
        target_id: string;
        vector_field: string;
        status: string;
        attempts: number;
      }>;
    expect(queued).toEqual([]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)).toMatchObject({
      state: "embedding_pending",
      stage: "embedding",
      attemptCount: 1
    });

    const retryAt = new Repositories(db.db).runtime.getJob(failedJob.id)!.availableAt!;
    expect(Date.parse(retryAt)).toBeGreaterThan(Date.now());
    vi.setSystemTime(Date.parse(retryAt));
    const secondRun = await service.runWorkerOnce(20, { priorityCohortOnly: true });
    expect(secondRun.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: failedJob.id, jobType: "embedding", status: "succeeded" })
    ]));
    expect(secondRun.embeddingRetries.succeeded).toBe(0);
    const drained = db.db
      .prepare(
        `SELECT vector_field, status, attempts
         FROM embedding_retry_queue
         WHERE target_id = ?`
      )
      .all(complete.l1MemoryId) as Array<{ vector_field: string; status: string; attempts: number }>;
    expect(drained).toEqual([]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)?.state).toBe("ready");

    service.closeSession(session.sessionId);
    const reflectionRun = await service.runWorkerOnce(20);
    expect(reflectionRun.jobs.some((job) => job.jobType === "reflection" && job.status === "succeeded")).toBe(true);
    const reflectedMemory = db.db
      .prepare(`SELECT version FROM memories WHERE id = ?`)
      .get(complete.l1MemoryId) as { version: number };
    const reindexRun = await service.runWorkerOnce(20, { priorityCohortOnly: true });
    const afterReflection = [...reflectionRun.jobs, ...reindexRun.jobs];
    expect(afterReflection.some((job) => job.jobType === "embedding" && job.status === "succeeded")).toBe(true);
    expect(afterReflection.findIndex(job => job.jobType === "reflection"))
      .toBeLessThan(afterReflection.findIndex(job => job.jobType === "embedding"));
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)?.state).toBe("ready");
    const memory = db.db
      .prepare(
        `SELECT memory_vector_entries.embedding_model,
                memory_vector_entries.embedding_dim,
                memories.version
         FROM memory_vector_entries
         JOIN memories ON memories.id = memory_vector_entries.memory_id
         WHERE memory_vector_entries.memory_id = ?
           AND memory_vector_entries.vector_field = 'vec_summary'`
      )
      .get(complete.l1MemoryId) as { embedding_model: string | null; embedding_dim: number; version: number };
    expect(memory.embedding_model).toBe("flaky-test-embedding");
    expect(memory.embedding_dim).toBe(3);
    expect(reflectedMemory.version).toBeGreaterThan(initialMemory.version);
    expect(memory.version).toBe(reflectedMemory.version);

    db.close();
  });

  it.each([
    [400, "context_length_exceeded", "maximum context length exceeded"],
    [400, "20015", "The parameter is invalid."],
    [413, "payload_too_large", "Request too large"],
    [422, "invalid_input", "Invalid input"]
  ])("isolates a deterministic embedding failure and keeps the valid sibling (%s / %s)", async (status, code, message) => {
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const embedder = createSelectiveFailureEmbedder(undefined, new ModelHttpError(message, "openai_compatible", status as number, code as string, message as string));
    const { db, service } = createTestService({
      llm: createBatchReflectionLlm(llmCalls, "Imported memory summary."),
      embedder
    });
    const session = service.openSession({
      namespace: { source: "codex", profileId: "batch-isolation", userId: "user-batch-isolation" }
    });
    const good = (await service.completeTurn("turn-embedding-good", {
      sessionId: session.sessionId,
      query: "Remember the valid embedding item.",
      answer: "VALID_EMBEDDING_ITEM"
    }));
    const bad = (await service.completeTurn("turn-embedding-bad", {
      sessionId: session.sessionId,
      query: "Remember the oversized embedding item.",
      answer: "BAD_EMBEDDING_ITEM"
    }));

    const targets = { targetMemoryIds: [good.l1MemoryId, bad.l1MemoryId] };
    await service.runWorkerOnce(2, targets);
    const embeddingRun = await service.runWorkerOnce(2, targets);
    const repositories = new Repositories(db.db);

    expect(embeddingRun.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetMemoryId: good.l1MemoryId, status: "succeeded" }),
      expect.objectContaining({ targetMemoryId: bad.l1MemoryId, status: "dead_letter" })
    ]));
    expect(repositories.processing.get(good.l1MemoryId)?.state).toBe("ready");
    expect(repositories.processing.get(bad.l1MemoryId)).toMatchObject({
      state: code === "context_length_exceeded" ? "ready_text_only" : "failed",
      stage: code === "context_length_exceeded" ? null : "embedding",
      retryAction: "none",
      errorCode: code === "context_length_exceeded" ? "model_input_too_long" : "invalid_model_request"
    });
    db.close();
  });

  it("holds a forbidden legacy embedding retry for configuration repair without consuming an attempt", async () => {
    const { db, service } = createTestService({ embedder: createForbiddenEmbedder() });
    const repositories = new Repositories(db.db);
    const memory = skillMemory();
    repositories.memories.insert(memory);
    const retry = repositories.runtime.enqueueEmbeddingRetry({
      targetKind: "skill",
      targetId: memory.id,
      vectorField: "vec",
      sourceText: embeddingTextForMemory(memory),
      embedRole: "query",
      now: Date.now() - 1
    });

    const run = await service.runWorkerOnce(10);

    expect(run.embeddingRetries.items).toEqual([
      expect.objectContaining({ id: retry.id, status: "failed", attempts: 0 })
    ]);
    expect(repositories.runtime.getEmbeddingRetry(retry.id)).toMatchObject({
      status: "failed",
      attempts: 0,
      blockedReason: "configuration",
      lastError: "Access to the configured model is forbidden."
    });
    db.close();
  });

  it("does not enqueue a legacy retry for a processing-less deterministic worker failure", async () => {
    const calls = { batch: 0, single: 0 };
    const { db, service } = createTestService({ embedder: createSelectiveFailureEmbedder(calls) });
    const repositories = new Repositories(db.db);
    const memory = skillMemory(undefined, {
      id: "skill_deterministic_worker_failure",
      content: "BAD_EMBEDDING_ITEM"
    });
    repositories.memories.insert(memory);
    repositories.runtime.enqueueJob({
      id: "job_skill_deterministic_worker_failure",
      jobType: "embedding",
      status: "queued",
      dedupeKey: `embedding:${memory.id}`,
      userId: memory.userId,
      targetMemoryId: memory.id,
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt
    });

    const run = await service.runWorkerOnce(10);

    expect(run.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_skill_deterministic_worker_failure",
        status: "dead_letter"
      })
    ]);
    expect(db.db.prepare(
      `SELECT id FROM embedding_retry_queue WHERE target_id = ?`
    ).all(memory.id)).toEqual([]);
    expect(calls).toEqual({ batch: 1, single: 0 });
    db.close();
  });

  it("does not re-request a single legacy retry after a token-limit failure", async () => {
    const calls = { batch: 0, single: 0 };
    const { db, service } = createTestService({ embedder: createSelectiveFailureEmbedder(calls) });
    const repositories = new Repositories(db.db);
    const memory = skillMemory(undefined, {
      id: "skill_legacy_token_limit",
      content: "BAD_EMBEDDING_ITEM"
    });
    repositories.memories.insert(memory);
    const retry = repositories.runtime.enqueueEmbeddingRetry({
      targetKind: "skill",
      targetId: memory.id,
      vectorField: "vec",
      sourceText: embeddingTextForMemory(memory),
      embedRole: "query",
      now: Date.now() - 1
    });

    await service.runWorkerOnce(10);

    expect(repositories.runtime.getEmbeddingRetry(retry.id)).toMatchObject({
      status: "failed",
      attempts: 1
    });
    expect(calls).toEqual({ batch: 1, single: 0 });
    db.close();
  });

  it.each([
    [400, "context_length_exceeded", "maximum context length exceeded"],
    [400, "20015", "The parameter is invalid."],
    [413, "payload_too_large", "Request too large"],
    [422, "invalid_input", "Invalid input"]
  ])("isolates a deterministic legacy retry failure and keeps the valid sibling (%s / %s)", async (status, code, message) => {
    const { db, service } = createTestService({ embedder: createSelectiveFailureEmbedder(undefined, new ModelHttpError(message, "openai_compatible", status as number, code as string, message as string)) });
    const repositories = new Repositories(db.db);
    const good = skillMemory(undefined, {
      id: "skill_legacy_retry_good",
      content: "VALID_EMBEDDING_ITEM"
    });
    const bad = skillMemory(undefined, {
      id: "skill_legacy_retry_bad",
      content: "BAD_EMBEDDING_ITEM"
    });
    repositories.memories.insert(good);
    repositories.memories.insert(bad);
    const goodRetry = repositories.runtime.enqueueEmbeddingRetry({
      targetKind: "skill",
      targetId: good.id,
      vectorField: "vec",
      sourceText: embeddingTextForMemory(good),
      embedRole: "query",
      now: Date.now() - 1
    });
    const badRetry = repositories.runtime.enqueueEmbeddingRetry({
      targetKind: "skill",
      targetId: bad.id,
      vectorField: "vec",
      sourceText: embeddingTextForMemory(bad),
      embedRole: "query",
      now: Date.now() - 1
    });

    const run = await service.runWorkerOnce(10);

    expect(run.embeddingRetries.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: goodRetry.id, status: "succeeded" }),
      expect.objectContaining({ id: badRetry.id, status: "failed", attempts: 1 })
    ]));
    expect(repositories.runtime.getEmbeddingRetry(goodRetry.id)?.status).toBe("succeeded");
    expect(repositories.runtime.getEmbeddingRetry(badRetry.id)?.status).toBe("failed");
    expect(retrievalDocumentIsCurrent(repositories.memories.get(good.id)!)).toBe(true);
    db.close();
  });

  it.each([401, 403, 429, 500])("does not fan out a shared HTTP %s failure", async (status) => {
    const calls = { batch: 0, single: 0 };
    const failure = new ModelHttpError("Provider unavailable", "openai_compatible", status, undefined, "Provider unavailable");
    const { db, service } = createTestService({ embedder: createSelectiveFailureEmbedder(calls, failure) });
    const repositories = new Repositories(db.db);
    for (let index = 0; index < 2; index += 1) {
      const memory = skillMemory(undefined, { id: `shared-failure-${index}`, content: "VALID_EMBEDDING_ITEM" });
      repositories.memories.insert(memory);
      repositories.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: memory.id, vectorField: "vec",
        sourceText: embeddingTextForMemory(memory), embedRole: "query", now: Date.now() - 1 });
    }
    await service.runWorkerOnce(10);
    expect(calls).toEqual({ batch: 1, single: 0 });
    db.close();
  });

  it("embeds L1 summary together with bounded user and assistant text", async () => {
    const root = createTestRoot("mindock-memory-dual-embedding-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const seenTexts: string[] = [];
    const embedder = createCapturingEmbedder(seenTexts);
    const service = createTestMemoryService({
      db,
      mode: "dev",
      embedder,
      llm: createBatchReflectionLlm([], "Remember the SQLite migration rule.")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-dual-embedding"
      }
    });
    const complete = (await service.completeTurn("turn-dual-embedding", {
      sessionId: session.sessionId,
      query: "Remember the SQLite migration rule.",
      answer: "I will run the focused migration test before broad checks."
    }));

    await service.runWorkerOnce(10);
    await service.runWorkerOnce(10);
    await service.runWorkerOnce(10);

    expect(seenTexts).toHaveLength(1);
    expect(seenTexts[0]).toContain("Summary: Remember the SQLite migration rule");
    expect(seenTexts[0]).toContain("Original exchange:");
    expect(seenTexts[0]).toContain("focused migration test");
    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          vec_summary: number[];
          vec_action: number[] | null;
        };
      };
    };
    expect(properties.internal_info.trace.vec_summary).toBeUndefined();
    expect(properties.internal_info.trace.vec_action).toBeUndefined();
    expect(db.db.prepare(
      `SELECT embedding_dim FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec_summary'`
    ).get(complete.l1MemoryId)).toEqual({ embedding_dim: 3 });
    db.close();
  });

  it("summarizes and embeds captured L1 traces before episode reflection", async () => {
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      llm: createBatchReflectionLlm(llmCalls, "SQLite migrations should run focused checks before broad checks."),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-live-trace-summary"
    };
    const session = service.openSession({ namespace });

    await service.startTurn({
      sessionId: session.sessionId,
      turnId: "turn-live-trace-summary",
      query: "Remember the SQLite migration workflow."
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_processing_state").get()).toEqual({ count: 0 });

    const complete = (await service.completeTurn("turn-live-trace-summary", {
      sessionId: session.sessionId,
      query: "Remember the SQLite migration workflow.",
      answer: "Use focused checks first, then broaden only after the migration path is verified."
    }));

    expect(complete.jobs.map((job) => job.jobType)).toEqual(["episode_assignment", "episode_finalize", "trace_summary"]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)).toMatchObject({
      state: "summary_pending",
      stage: "summary",
      activeJobId: null
    });
    const recall = await service.search({
      namespace,
      query: "SQLite migration workflow",
      layers: ["L1"]
    });
    expect(recall.hits.some((hit) => hit.id === complete.l1MemoryId)).toBe(false);
    const openEpisodeRun = await service.runWorkerOnce(10, { priorityCohortOnly: true });
    expect(openEpisodeRun.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "trace_summary", targetMemoryId: complete.l1MemoryId })
    ]));
    expect(llmCalls.filter((call) => call.options.operation === "capture.summarize")).toHaveLength(1);
    expect(llmCalls.some((call) => call.options.operation === "capture.reflection.batch.v13")).toBe(false);
    const embeddingRun = await service.runWorkerOnce(10, { priorityCohortOnly: true });
    // Newly produced embedding work may finish in the original drain.
    const completed = [...openEpisodeRun.jobs, ...embeddingRun.jobs];
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "embedding", targetMemoryId: complete.l1MemoryId })
    ]));
    const reflectionIndex = completed.findIndex((job) => job.jobType === "reflection");
    const embeddingIndex = completed.findIndex((job) => job.jobType === "embedding");
    if (reflectionIndex >= 0) expect(embeddingIndex).toBeLessThan(reflectionIndex);
    const auxiliaryJobs = [...openEpisodeRun.jobs, ...embeddingRun.jobs].map((job) => job.jobType);
    expect(auxiliaryJobs).toEqual(expect.arrayContaining(["episode_assignment", "episode_finalize", "episode_idle_close"]));
    expect(embeddingTexts).toHaveLength(1);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type IN ('trace_summary', 'embedding')`
    ).get(complete.l1MemoryId)).toEqual({ count: 2 });
    const row = db.db.prepare(
      `SELECT info_json, properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { info_json: string; properties_json: string };
    const info = JSON.parse(row.info_json) as { summary?: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        summary?: string;
        trace: {
          summary?: string;
          vec_summary?: number[];
        };
      };
    };
    expect(info.summary).toBe("SQLite migrations should run focused checks before broad checks.");
    expect(properties.internal_info.summary).toBe("SQLite migrations should run focused checks before broad checks.");
    expect(properties.internal_info.trace.summary).toBe("SQLite migrations should run focused checks before broad checks.");
    expect(properties.internal_info.trace.vec_summary).toBeUndefined();
    expect(db.db.prepare(
      `SELECT embedding_dim FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec_summary'`
    ).get(complete.l1MemoryId)).toEqual({ embedding_dim: 3 });
    db.close();
  });

  it("keeps L1 waiting without a summary model, then generates a title after one is configured", async () => {
    let configured = false;
    const llm: LlmClient = {
      config: {
        ...DEFAULT_MEMMY_CONFIG.summary,
        provider: "host",
        endpoint: "http://127.0.0.1/summary",
        model: "summary-test"
      },
      isConfigured: () => configured,
      async complete() {
        return "{}";
      },
      async completeJson<T extends Record<string, unknown>>(_selectionMessages: unknown, selectionOptions: { operation: string }) {
      if (selectionOptions.operation === "episode.select.v1") return { episodeId: null, title: "Test task", summary: "Test task summary" } as unknown as T;
        return { title: "生成标题", summary: "生成摘要" } as unknown as T;
      },
      status: () => ({
        provider: "host",
        model: "summary-test",
        configured,
        remote: true
      })
    };
    const { db, service } = createTestService({ llm });
    const session = service.openSession({
      namespace: { source: "codex", profileId: "default", sessionKey: "unconfigured-summary" }
    });
    (await service.completeTurn("turn-unconfigured-summary", {
      sessionId: session.sessionId,
      query: "请修复自动扫描卡顿并运行测试",
      answer: "已完成修复并运行测试。"
    }));
    addAgentSourceImport(
      service,
      { source: "codex", profileId: "unconfigured-import", userId: "unconfigured-import" },
      "请修复导入流程并验证结果",
      "unconfigured-import"
    );

    const held = await service.runWorkerOnce(100);
    const heldAgain = await service.runWorkerOnce(100);
    const summaryJobs = (run: { jobs: Array<{ jobType: string }> }) =>
      run.jobs.filter((job) => job.jobType === "trace_summary" || job.jobType === "import_summary");
    expect(summaryJobs(held)).toEqual([]);
    expect(summaryJobs(heldAgain)).toEqual([]);

    const waiting = service.panelItems({ layer: "L1" }).items;
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    expect(waiting.every((item) => item.processing?.state === "summary_pending")).toBe(true);
    expect(waiting.map((item) => item.sourceText)).toEqual(expect.arrayContaining([
      "请修复自动扫描卡顿并运行测试",
      "请修复导入流程并验证结果"
    ]));
    expect(waiting.some((item) => item.summary === "生成摘要" || item.generatedTitle === "生成标题")).toBe(false);
    const queued = db.db.prepare(
      `SELECT status FROM evolution_jobs WHERE job_type IN ('trace_summary', 'import_summary')`
    ).all() as Array<{ status: string }>;
    expect(queued.length).toBeGreaterThanOrEqual(2);
    expect(queued.every((job) => job.status === "queued")).toBe(true);
    const past = new Date(Date.now() - 5_000).toISOString();
    db.db.prepare(
      `UPDATE evolution_jobs
       SET payload_json = json_set(payload_json, '$.runAfter', ?)
       WHERE job_type IN ('trace_summary', 'import_summary')`
    ).run(past);
    const summaryDue = Date.parse(past);
    const heldWake = service.nextWorkerRunAt();
    expect(heldWake).not.toBe(summaryDue);
    expect(heldWake === undefined || heldWake > Date.now()).toBe(true);

    configured = true;
    expect(service.nextWorkerRunAt()).toBe(summaryDue);
    await service.runWorkerOnce(100);
    await service.runWorkerOnce(100);
    const generated = service.panelItems({ layer: "L1" }).items;
    expect(generated.every((item) => item.generatedTitle === "生成标题")).toBe(true);
    expect(generated.every((item) => item.summary === "生成摘要")).toBe(true);
    expect(generated.every((item) => item.processing?.state !== "summary_pending" && item.processing?.state !== "summarizing")).toBe(true);
    expect(generated.every((item) => item.processing?.state !== "failed")).toBe(true);
    const finished = db.db.prepare(
      `SELECT status FROM evolution_jobs WHERE job_type IN ('trace_summary', 'import_summary')`
    ).all() as Array<{ status: string }>;
    expect(finished.every((job) => job.status === "succeeded")).toBe(true);
    db.close();
  });
});

function negativePolicyMemory(title: string, trigger: string): MemoryRow {
  const now = "2026-07-24T00:00:00.000Z";
  return {
    id: "policy_negative_embedding_limit",
    timeline: now,
    userId: "negative-embedding-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: "policy:negative-embedding-limit",
    memoryValue: "Avoid the failed approach.",
    tags: ["policy", "negative"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        policy: {
          title,
          trigger,
          procedure: "Avoid the failed approach.",
          verification: "Verify the failure cannot recur.",
          boundary: "Apply only to the matching task.",
          experience_type: "failure_avoidance",
          evidence_polarity: "negative"
        }
      }
    },
    memoryLayer: "L2",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function skillMemory(short?: {
  retrievalBlurb: string;
  triggerContext: string;
}, override: { id?: string; content?: string } = {}): MemoryRow {
  const now = "2026-07-24T00:00:00.000Z";
  const content = override.content ?? "# SQLite migration\n\nPROCEDURE_ONLY_SENTINEL";
  return {
    id: override.id ?? "skill_retrieval_document",
    timeline: now,
    userId: "skill-retrieval-user",
    memoryType: "SkillMemory",
    status: "activated",
    visibility: "private",
    memoryKey: "skill:sqlite-migration",
    memoryValue: content,
    tags: ["sqlite", "migration"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        skill: {
          name: "SQLite migration",
          status: "active",
          invocation_guide: content,
          ...(short ? { procedure_json: short } : {})
        }
      }
    },
    memoryLayer: "Skill",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function worldModelMemory(): MemoryRow {
  const now = "2026-07-24T00:00:00.000Z";
  return {
    id: "world_model_retrieval_document",
    timeline: now,
    userId: "world-retrieval-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: "world-model:sqlite-migrations",
    memoryValue: "# SQLite migrations\n\nBODY_ONLY_SENTINEL",
    tags: ["sqlite", "migration"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L3",
        memory_kind: "world_model",
        world_model: {
          title: "SQLite migrations",
          domain_key: "engineering|database",
          domain_tags: ["sqlite", "migration"],
          summary: "Schema migrations require staged verification.",
          body: "# SQLite migrations\n\nBODY_ONLY_SENTINEL",
          structure: {
            environment: [{ label: "Environment", description: "SQLite database" }],
            inference: [{ label: "Inference", description: "Verify focused paths first" }],
            constraints: [{ label: "Constraint", description: "Preserve old readers" }]
          }
        }
      }
    },
    memoryLayer: "L3",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

/** Prepare all compatible embedding jobs before draining, without relying on old priority cohorts. */
async function prepareFreshEmbeddingBatch(
  service: ReturnType<typeof createTestService>["service"], ids: readonly string[]
): Promise<void> {
  for (const id of ids) {
    const run = await service.runWorkerOnce(1, { targetMemoryIds: [id] });
    expect(run.jobs).toEqual([expect.objectContaining({
      jobType: "trace_summary", targetMemoryId: id, status: "succeeded"
    })]);
  }
}

function createHttpTestEmbedder(): Embedder {
  return createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: "openai_compatible",
    model: "custom-alias", endpoint: "https://embedding.test/v1", cache: false, maxRetries: 0 },
    { usageRecorder: { record() { return "skipped"; } } });
}

function createFlakyEmbedder(): Embedder {
  let batchCalls = 0;
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "flaky-test-embedding"
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      batchCalls += 1;
      if (batchCalls === 1) {
        throw new Error("temporary embedding outage");
      }
      return texts.map((text) => stableTestVector(text));
    },
    async embedOne(text: string) {
      return stableTestVector(text);
    },
    status() {
      return {
        provider: "local",
        model: "flaky-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function createSelectiveFailureEmbedder(calls?: { batch: number; single: number }, failure?: ModelHttpError): Embedder {
  const inputTooLong = () => failure ?? new ModelHttpError(
    "openai_compatible HTTP 400: maximum context length exceeded",
    "openai_compatible",
    400,
    "context_length_exceeded",
    "This model's maximum context length is 8192 tokens"
  );
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      model: "selective-test-embedding"
    },
    isRemote() {
      return true;
    },
    async embed(texts: string[]) {
      if (calls) calls.batch += 1;
      if (texts.length > 1) throw inputTooLong();
      if (texts[0]?.includes("BAD_EMBEDDING_ITEM")) throw inputTooLong();
      return texts.map((text) => stableTestVector(text));
    },
    async embedOne(text: string) {
      if (calls) calls.single += 1;
      if (text.includes("BAD_EMBEDDING_ITEM")) throw inputTooLong();
      return stableTestVector(text);
    },
    status() {
      return {
        provider: "openai_compatible",
        model: "selective-test-embedding",
        configured: true,
        remote: true
      };
    }
  };
}

function createForbiddenEmbedder(): Embedder {
  const forbidden = () => new ModelHttpError(
    "openai_compatible HTTP 403: forbidden",
    "openai_compatible",
    403,
    "model_access_denied",
    "Access to the configured model is forbidden."
  );
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      model: "forbidden-test-embedding"
    },
    isRemote() {
      return true;
    },
    async embed() {
      throw forbidden();
    },
    async embedOne() {
      throw forbidden();
    },
    status() {
      return {
        provider: "openai_compatible",
        model: "forbidden-test-embedding",
        configured: true,
        remote: true
      };
    }
  };
}
