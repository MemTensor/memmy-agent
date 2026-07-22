import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type Embedder,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  addAgentSourceImport,
  createBatchReflectionLlm,
  createCapturingEmbedder,
  createFailingLlm,
  createMemoryServiceFixture,
  runWorkerRounds,
  stableTestVector
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / import / processing", () => {
  it("imports L1 memory with async summary, default score, and embedding only", async () => {
    const root = createTestRoot("mindock-memory-import-add-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; maxTokens?: number };
    }> = [];
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(llmCalls),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-add"
    };

    const added = service.addMemory({
      namespace,
      adapterId: "agent-source:cursor",
      requestId: "cursor-turn-1",
      layer: "L1",
      source: "cursor",
      tags: ["agent-source", "cursor"],
      title: "cursor turn conv-a #1",
      turnId: "cursor:conv-a:0",
      content: [
        "## user\n\n记住这个项目使用 pnpm。",
        "## assistant\n\n我先确认项目配置。",
        "## tool\n\nTool: read_file\n\nCall ID: call-read-package\n\nInput:\n{\"path\":\"package.json\"}\n\nOutput:\npackage.json 显示 pnpm workspace。",
        "## assistant\n\n好的，我会记住。"
      ].join("\n\n")
    });

    expect(added.tags).toEqual(expect.arrayContaining(["npm", "read"]));
    expect(added.tags).not.toEqual(expect.arrayContaining(["摘要排队中", "摘要总结中", "索引建立中"]));
    expect(added.tags).toEqual(expect.arrayContaining(["agent-source", "cursor"]));
    expect(added.tags).not.toContain("trace");
    expect(added.title).toBe("记住这个项目使用 pnpm。");
    const inserted = db.db.prepare(
      `SELECT memory_value, info_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { memory_value: string; info_json: string };
    expect(JSON.parse(inserted.info_json)).toMatchObject({ title: "记住这个项目使用 pnpm。" });
    expect(inserted.memory_value).toContain("User:\n记住这个项目使用 pnpm。");
    expect(inserted.memory_value).toContain("Agent:\n我先确认项目配置。");
    expect(inserted.memory_value).toContain("好的，我会记住。");
    expect(inserted.memory_value).toContain("Tool calls:");
    expect(inserted.memory_value).toContain("- read_file");
    expect(service.panelItems({ namespace, layer: "L1" }).items[0]?.title).toBe("记住这个项目使用 pnpm。");
    const queued = db.db.prepare(
      `SELECT job_type, status, target_memory_id
       FROM evolution_jobs
       WHERE target_memory_id = ?`
    ).all(added.id) as Array<{ job_type: string; status: string; target_memory_id: string }>;
    expect(queued).toEqual([
      { job_type: "import_summary", status: "queued", target_memory_id: added.id }
    ]);

    const summaryRun = await service.runWorkerOnce(100);
    expect(summaryRun.jobs.map((job) => job.jobType)).toEqual(["import_summary"]);
    expect(llmCalls.map((call) => call.options.operation)).toEqual(["capture.summarize"]);
    const summaryCall = llmCalls.find((call) => call.options.operation === "capture.summarize");
    expect(summaryCall?.options.maxTokens).toBe(512);
    expect(summaryCall?.messages[0]?.content).toContain("<= 200 characters");
    expect(summaryCall?.messages[0]?.content).toContain("future retrieval");
    expect(summaryCall?.messages[0]?.content).toContain("concrete retrieval anchors");
    expect(summaryCall?.messages[0]?.content).toContain("atomic real-world facts");
    expect(summaryCall?.messages[0]?.content).toContain("use most of the 200-character budget");
    expect(summaryCall?.messages[0]?.content).toContain("Preserve temporal expressions as stated in the source");
    expect(summaryCall?.messages[0]?.content).toContain("Do NOT resolve, normalize, infer, or replace a relative expression");
    expect(summaryCall?.messages[0]?.content).not.toContain("MUST include the resolved absolute date/time");
    expect(summaryCall?.messages[0]?.content).toContain("image captions");
    expect(summaryCall?.messages[0]?.content).toContain("source itself provides an absolute date/time, preserve it");
    expect(summaryCall?.messages[0]?.content).toContain("Use future-query words");
    expect(summaryCall?.messages[0]?.content).toContain("Preserve original speaker/person names");
    expect(summaryCall?.messages[0]?.content).not.toContain("L1");
    expect(summaryCall?.messages[0]?.content).not.toContain("<= 100 characters");

    const summarized = db.db.prepare(
      `SELECT memory_value, tags_json, info_json, properties_json, version
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { memory_value: string; tags_json: string; info_json: string; properties_json: string; version: number };
    const summarizedTags = JSON.parse(summarized.tags_json) as string[];
    const summarizedInfo = JSON.parse(summarized.info_json) as { tags: string[] };
    const summarizedProps = JSON.parse(summarized.properties_json) as {
      info: { tags: string[] };
      internal_info: {
        trace: {
          summary: string;
          reflection?: string | null;
          reflection_scored_at?: string;
          alpha: number;
          value: number;
          priority: number;
          tool_calls: Array<{ id?: string; name?: string; input?: unknown; output?: unknown }>;
        };
      };
    };
    expect(summarizedTags).not.toEqual(expect.arrayContaining(["建立索引中", "索引建立中"]));
    expect(summarizedTags).not.toContain("摘要排队中");
    expect(summarizedInfo.tags).not.toEqual(expect.arrayContaining(["建立索引中", "索引建立中"]));
    expect(summarizedInfo.tags).not.toContain("摘要排队中");
    expect(summarizedProps.info.tags).not.toEqual(expect.arrayContaining(["建立索引中", "索引建立中"]));
    expect(summarizedProps.info.tags).not.toContain("摘要排队中");
    expect(new Repositories(db.db).processing.get(added.id)).toMatchObject({
      state: "embedding_pending",
      stage: "embedding"
    });
    expect(service.panelItems({ namespace, layer: "L1" }).items[0]?.tags).toContain("索引建立中");
    expect(summarizedProps.internal_info.trace).toMatchObject({
      summary: "LLM batch summary",
      reflection: null,
      alpha: 0,
      value: 0,
      priority: 0.5
    });
    expect(summarized.memory_value).toContain("Summary: LLM batch summary");
    expect(summarized.memory_value).toContain("User:\n记住这个项目使用 pnpm。");
    expect(summarized.memory_value).toContain("Tool calls:");
    expect(summarizedProps.internal_info.trace.tool_calls).toEqual([
      expect.objectContaining({
        id: "call-read-package",
        name: "read_file",
        input: { path: "package.json" },
        output: "package.json 显示 pnpm workspace。"
      })
    ]);
    expect(summarizedProps.internal_info.trace.reflection_scored_at).toBeUndefined();

    const jobsAfterSummary = db.db.prepare(
      `SELECT job_type, status
       FROM evolution_jobs
       WHERE target_memory_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(added.id) as Array<{ job_type: string; status: string }>;
    expect(jobsAfterSummary.map((job) => job.job_type)).toEqual(["import_summary", "embedding"]);
    expect(jobsAfterSummary.some((job) => job.job_type === "reflection")).toBe(false);

    const embeddingRun = await service.runWorkerOnce(100);
    expect(embeddingRun.jobs.map((job) => job.jobType)).toEqual(["embedding"]);
    expect(embeddingTexts).toHaveLength(1);
    expect(embeddingTexts[0]).toContain("Summary: LLM batch summary");
    expect(embeddingTexts[0]).toContain("Original exchange:");
    expect(embeddingTexts[0]).toContain("记住这个项目使用 pnpm");
    expect(embeddingTexts[0]).toContain("好的，我会记住");

    const indexed = db.db.prepare(
      `SELECT memories.tags_json, memory_vector_entries.embedding_dim,
              memories.properties_json, memories.version
       FROM memories
       JOIN memory_vector_entries ON memory_vector_entries.memory_id = memories.id
       WHERE memories.id = ? AND memory_vector_entries.vector_field = 'vec_summary'`
    ).get(added.id) as { tags_json: string; embedding_dim: number; properties_json: string; version: number };
    const indexedTags = JSON.parse(indexed.tags_json) as string[];
    const indexedProps = JSON.parse(indexed.properties_json) as {
      internal_info: {
        trace: {
          reflection?: string | null;
          reflection_scored_at?: string;
          vec_summary?: number[];
          vec_action?: number[];
        };
      };
    };
    expect(indexed.embedding_dim).toBe(3);
    expect(indexedTags).not.toEqual(expect.arrayContaining(["索引已建立", "索引建立中"]));
    expect(indexedTags).not.toContain("建立索引中");
    expect(new Repositories(db.db).processing.get(added.id)?.state).toBe("ready");
    expect(indexedProps.internal_info.trace.reflection).toBeNull();
    expect(indexedProps.internal_info.trace.reflection_scored_at).toBeUndefined();
    expect(indexedProps.internal_info.trace.vec_summary).toBeUndefined();
    expect(indexedProps.internal_info.trace.vec_action).toBeUndefined();
    expect(indexed.version).toBe(summarized.version);
    expect(service.panelItems({ namespace, layer: "L1" }).items[0]?.metrics).toEqual({
      value: 0,
      alpha: 0,
      reflectionDone: false
    });
    const episodeCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM episodes
       WHERE user_id = ?`
    ).get("user-import-add") as { count: number };
    const derivedLayerCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ?
         AND memory_layer IN ('L2', 'L3', 'Skill')`
    ).get("user-import-add") as { count: number };
    expect(episodeCount.count).toBe(0);
    expect(derivedLayerCount.count).toBe(0);

    db.close();
  });

  it("records a visible terminal failure when import summary generation exhausts retries", async () => {
    const root = createTestRoot("mindock-memory-import-summary-fallback-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createFailingLlm(),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "hermes",
      profileId: "default",
      userId: "user-import-summary-fallback"
    };
    const added = addAgentSourceImport(
      service,
      namespace,
      "请列出项目里的异常类型。",
      "summary-fallback"
    );

    const runs = [
      await service.runWorkerOnce(100),
      await service.runWorkerOnce(100),
      await service.runWorkerOnce(100)
    ];

    expect(runs.flatMap((run) => run.jobs).map((job) => job.jobType)).toEqual([
      "import_summary",
      "import_summary",
      "import_summary"
    ]);
    expect(embeddingTexts).toEqual([]);
    const stored = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { properties_json: string };
    const properties = JSON.parse(stored.properties_json) as {
      internal_info: {
        trace: { summary: string };
      };
    };
    expect(properties.internal_info.trace.summary).toBe("摘要排队中");
    const processing = new Repositories(db.db).processing.get(added.id);
    expect(processing).toMatchObject({
      state: "failed",
      stage: "summary",
      attemptCount: 3,
      retryAction: "retry"
    });
    expect(processing?.errorMessage).toBeTruthy();
    expect(service.panelItems({ namespace, layer: "L1" }).items[0]?.tags).toContain("处理失败");
    const jobCounts = db.db.prepare(
      `SELECT job_type, COUNT(*) AS count
       FROM evolution_jobs
       WHERE target_memory_id = ?
       GROUP BY job_type
       ORDER BY job_type`
    ).all(added.id) as Array<{ job_type: string; count: number }>;
    expect(jobCounts).toEqual([
      { job_type: "import_summary", count: 1 }
    ]);

    db.close();
  });

  it("falls back to the evolution LLM with thinking disabled when trace summarization fails", async () => {
    const root = createTestRoot("mindock-memory-summary-evolution-fallback-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const summaryCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const evolutionCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const summaryBase = createBatchReflectionLlm([], "unused", "summary-model");
    const summaryLlm: LlmClient = {
      ...summaryBase,
      async completeJson<T extends Record<string, unknown>>(
        messages: LlmMessage[],
        options: LlmCompletionOptions
      ): Promise<T> {
        summaryCalls.push({ messages, options });
        throw new Error("summary endpoint returned HTTP 405");
      }
    };
    const evolutionLlm = createBatchReflectionLlm(
      evolutionCalls,
      "进化模型生成的降级摘要",
      "evolution-model"
    );
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: summaryLlm,
      skillLlm: evolutionLlm,
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "codex", profileId: "default", userId: "summary-evolution-fallback-user" };
    const added = addAgentSourceImport(
      service,
      namespace,
      "黑美人西瓜为什么不常见？",
      "summary-evolution-fallback"
    );

    const run = await service.runWorkerOnce(1);

    expect(run.jobs).toEqual([
      expect.objectContaining({ jobType: "import_summary", status: "succeeded" })
    ]);
    expect(summaryCalls).toHaveLength(1);
    const fallbackCall = evolutionCalls.find((call) => call.options.operation === "capture.summarize");
    expect(fallbackCall?.options.thinkingMode).toBe("disabled");
    const stored = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(added.id) as { properties_json: string };
    const properties = JSON.parse(stored.properties_json) as {
      internal_info: { trace: { summary: string } };
    };
    expect(properties.internal_info.trace.summary).toBe("进化模型生成的降级摘要");
    db.close();
  });

  it("sanitizes provider failures and retries only the failed summary stage", async () => {
    const root = createTestRoot("mindock-memory-processing-retry-summary-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const baseLlm = createBatchReflectionLlm(llmCalls, "summary succeeded after retry");
    let failureMessage: string | null =
      "401 Unauthorized Bearer supersecret-token sk-supersecret123456 api_key=private-value";
    const llm: LlmClient = {
      ...baseLlm,
      async completeJson<T extends Record<string, unknown>>(
        messages: LlmMessage[],
        options: LlmCompletionOptions
      ): Promise<T> {
        if (failureMessage) throw new Error(failureMessage);
        return baseLlm.completeJson<T>(messages, options);
      }
    };
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm,
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "hermes", profileId: "default", userId: "summary-retry-user" };
    const added = addAgentSourceImport(service, namespace, "retry this protected summary", "protected-summary");

    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);

    const failed = service.memoryProcessingStatus([added.id], { namespace }).items[0];
    expect(failed).toMatchObject({
      state: "failed",
      stage: "summary",
      attemptCount: 3,
      retryAction: "open_settings",
      errorCode: "model_configuration"
    });
    expect(failed?.errorMessage).toContain("Bearer [redacted]");
    expect(failed?.errorMessage).not.toContain("supersecret-token");
    expect(failed?.errorMessage).not.toContain("sk-supersecret123456");
    expect(failed?.errorMessage).not.toContain("private-value");
    const persistedFailure = db.db.prepare(
      `SELECT last_error FROM evolution_jobs WHERE target_memory_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).get(added.id) as { last_error: string | null };
    expect(persistedFailure.last_error).toContain("Bearer [redacted]");
    expect(persistedFailure.last_error).not.toContain("supersecret-token");
    expect(persistedFailure.last_error).not.toContain("sk-supersecret123456");
    expect(persistedFailure.last_error).not.toContain("private-value");

    failureMessage = null;
    const retry = service.retryMemoryProcessing(added.id, { namespace });
    expect(retry).toMatchObject({
      accepted: true,
      processing: {
        state: "summary_pending",
        stage: "summary",
        manualRetryCount: 1
      },
      job: { jobType: "import_summary", status: "queued" }
    });
    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "ready",
      stage: null,
      manualRetryCount: 1
    });
    expect(llmCalls.filter((call) => call.options.operation === "capture.summarize")).toHaveLength(1);

    db.close();
  });

  it("classifies an HTML model response as a model endpoint configuration failure", async () => {
    const root = createTestRoot("mindock-memory-processing-html-response-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const baseLlm = createFailingLlm();
    const llm: LlmClient = {
      ...baseLlm,
      async completeJson() {
        throw new Error(
          "openai_compatible HTTP 200: expected JSON but received HTML instead of a model API response; check the configured model endpoint"
        );
      }
    };
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm,
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "codex", profileId: "default", userId: "html-response-user" };
    const added = addAgentSourceImport(service, namespace, "bad model endpoint", "html-response");

    await runWorkerRounds(service, 3, 1);

    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "failed",
      stage: "summary",
      attemptCount: 3,
      retryAction: "open_settings",
      errorCode: "model_configuration",
      errorMessage: expect.stringContaining("HTTP 200")
    });

    db.close();
  });

  it("marks corrupt trace payloads as non-retryable", async () => {
    const root = createTestRoot("mindock-memory-processing-corrupt-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm([]),
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "hermes", profileId: "default", userId: "corrupt-trace-user" };
    const added = addAgentSourceImport(service, namespace, "corrupt trace should stop", "corrupt-trace");
    db.db.prepare(`
      UPDATE memories
      SET properties_json = json_remove(properties_json, '$.internal_info.trace')
      WHERE id = ?
    `).run(added.id);

    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);

    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "failed",
      stage: "summary",
      retryAction: "none",
      errorCode: "memory_corrupt"
    });
    expect(() => service.retryMemoryProcessing(added.id, { namespace })).toThrow(/payload is missing/);

    db.close();
  });

  it("retries an embedding failure without regenerating its completed summary", async () => {
    const root = createTestRoot("mindock-memory-processing-retry-embedding-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    let embeddingFails = true;
    const embedder: Embedder = {
      ...createCapturingEmbedder([]),
      async embed(texts) {
        if (embeddingFails) throw new Error("temporary embedding network outage");
        return texts.map((text) => stableTestVector(text));
      }
    };
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(llmCalls, "summary generated once"),
      embedder
    });
    const namespace = { source: "hermes", profileId: "default", userId: "embedding-retry-user" };
    const added = addAgentSourceImport(service, namespace, "retry only the vector stage", "embedding-stage");

    await service.runWorkerOnce(1);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await service.runWorkerOnce(1);
    }
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "failed",
      stage: "embedding",
      attemptCount: 6,
      retryAction: "retry"
    });

    embeddingFails = false;
    const retry = service.retryMemoryProcessing(added.id, { namespace });
    expect(retry.job?.jobType).toBe("embedding");
    await service.runWorkerOnce(1);
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "ready",
      manualRetryCount: 1
    });
    expect(llmCalls.filter((call) => call.options.operation === "capture.summarize")).toHaveLength(1);

    db.close();
  });

  it("updates one stable imported trace and rebuilds only its current content version", async () => {
    const root = createTestRoot("mindock-memory-import-content-version-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm([], "versioned import summary"),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = { source: "hermes", profileId: "default", userId: "versioned-import-user" };
    const baseInput = {
      namespace,
      adapterId: "agent-source:hermes",
      layer: "L1" as const,
      source: "hermes",
      tags: ["agent-source", "hermes"],
      turnId: "hermes:stable-turn",
      title: "Stable Hermes turn"
    };
    const first = service.addMemory({
      ...baseInput,
      requestId: "version-1",
      content: "## user\n\nold exchange\n\n## assistant\n\nold answer"
    });
    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    expect(new Repositories(db.db).memories.hasVector(first.id, "vec_summary")).toBe(true);

    const second = service.addMemory({
      ...baseInput,
      requestId: "version-2",
      content: "## user\n\nnew exchange\n\n## assistant\n\nnew answer"
    });

    expect(second.id).toBe(first.id);
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE user_id = ?`).get(namespace.userId))
      .toEqual({ count: 1 });
    expect(new Repositories(db.db).memories.hasVector(first.id, "vec_summary")).toBe(false);
    expect(service.memoryProcessingStatus([first.id], { namespace }).items[0]).toMatchObject({
      state: "summary_pending",
      stage: "summary"
    });

    await service.runWorkerOnce(10);
    await service.runWorkerOnce(10);
    expect(service.memoryProcessingStatus([first.id], { namespace }).items[0]?.state).toBe("ready");
    expect(embeddingTexts.at(-1)).toContain("new exchange");
    expect(embeddingTexts.at(-1)).not.toContain("old exchange");

    db.close();
  });

  it("keeps Codex import tool payloads as bounded text", () => {
    const { db, service } = createTestService();
    const deepJsonText = `${"{\"a\":".repeat(80)}0${"}".repeat(80)}`;
    const longOutput = "x".repeat(21_000);

    const added = service.addMemory({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-codex-import-tool-text"
      },
      adapterId: "agent-source:codex",
      requestId: "codex-turn-deep-tool-json",
      layer: "L1",
      source: "codex",
      tags: ["agent-source", "codex"],
      title: "codex turn with deep tool payload",
      turnId: "codex:deep-tool-json:0",
      content: [
        "## user\n\n导入 Codex 深层 tool payload。",
        "## assistant\n\n我会读取工具结果。",
        [
          "## tool",
          "",
          "Tool: local_debug",
          "",
          "Call ID: call-deep-tool-json",
          "",
          "Input:",
          deepJsonText,
          "",
          "Output:",
          longOutput
        ].join("\n"),
        "## assistant\n\n完成。"
      ].join("\n\n")
    });

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          tool_calls: Array<{ input?: unknown; output?: unknown }>;
        };
      };
    };
    const toolCall = properties.internal_info.trace.tool_calls[0];
    expect(typeof toolCall?.input).toBe("string");
    expect(toolCall?.input).toContain("{\"a\":");
    expect(typeof toolCall?.output).toBe("string");
    expect(toolCall?.output).toContain("[truncated:1000 chars]");
    db.close();
  });

  it("preserves complete multiline Input and Output blocks for imported tools", () => {
    const { db, service } = createTestService();
    const prettyObjectInput = JSON.stringify({
      search_query: [
        { q: "memory parser regression" },
        { q: "tool payload boundaries" }
      ],
      response_length: "long"
    }, null, 2);
    const prettyArrayOutput = JSON.stringify([
      { title: "first result", score: 0.9 },
      { title: "second result", score: 0.8 }
    ], null, 2);
    const multilineInput = [
      "printf 'first input line'",
      "Status: this line is part of the input payload",
      "printf 'second input line'"
    ].join("\n");
    const multilineOutput = [
      "first output line",
      "Content-Type: application/json",
      "second output line",
      "third output line"
    ].join("\n");

    const added = service.addMemory({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-codex-import-multiline-tools"
      },
      adapterId: "agent-source:codex",
      requestId: "codex-turn-multiline-tools",
      layer: "L1",
      source: "codex",
      tags: ["agent-source", "codex"],
      title: "codex turn with multiline tool payloads",
      turnId: "codex:multiline-tools:0",
      content: [
        "## user\n\n检查多行工具载荷。",
        [
          "## tool",
          "",
          "Tool: web_search",
          "",
          "Call ID: call-web-search",
          "",
          "Input:",
          prettyObjectInput,
          "",
          "Output:",
          prettyArrayOutput
        ].join("\n"),
        [
          "## tool",
          "",
          "Tool: exec_command",
          "",
          "Call ID: call-exec-command",
          "",
          "Input:",
          multilineInput,
          "",
          "Output:",
          multilineOutput
        ].join("\r\n"),
        "## assistant\n\n多行工具载荷检查完成。"
      ].join("\n\n")
    });

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          tool_calls: Array<{ id?: string; name?: string; input?: unknown; output?: unknown }>;
        };
      };
    };

    expect(properties.internal_info.trace.tool_calls).toEqual([
      expect.objectContaining({
        id: "call-web-search",
        name: "web_search",
        input: prettyObjectInput,
        output: prettyArrayOutput
      }),
      expect.objectContaining({
        id: "call-exec-command",
        name: "exec_command",
        input: multilineInput,
        output: multilineOutput
      })
    ]);
    db.close();
  });

  it("keeps imported L1 summaries untruncated when the model exceeds 200 characters", async () => {
    const root = createTestRoot("mindock-memory-import-summary-cap-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const longSummary = "s".repeat(240);
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(calls, longSummary),
      embedder: createCapturingEmbedder([])
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-summary-cap"
    };
    const added = addAgentSourceImport(service, namespace, "remember exact LoCoMo timing details", "summary-cap");

    await service.runWorkerOnce(10);

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          summary: string;
        };
      };
    };
    expect(calls.find((call) => call.options.operation === "capture.summarize")?.messages[0]?.content)
      .toContain("<= 200 characters");
    expect(calls.find((call) => call.options.operation === "capture.summarize")?.messages[0]?.content)
      .toContain("do not hard-truncate");
    expect(properties.internal_info.trace.summary).toHaveLength(240);
    expect(properties.internal_info.trace.summary).toBe(longSummary);
    expect(properties.internal_info.trace.summary).not.toMatch(/\.\.\.$/);
    db.close();
  });

  it("defers agent source import summaries until the scan summary stage enqueues them", async () => {
    const root = createTestRoot("mindock-memory-import-defer-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev"
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-defer"
    };

    const added = service.addMemory({
      namespace,
      adapterId: "agent-source:cursor",
      requestId: "cursor-turn-deferred",
      layer: "L1",
      source: "cursor",
      tags: ["agent-source", "cursor"],
      turnId: "cursor:conv-deferred:0",
      deferProcessing: true,
      content: [
        "## user\n\n先扫描完成再总结。",
        "## assistant\n\n收到。"
      ].join("\n\n")
    });

    const jobsBefore = db.db.prepare(
      `SELECT job_type
       FROM evolution_jobs
       WHERE target_memory_id = ?`
    ).all(added.id);
    expect(jobsBefore).toEqual([]);

    const enqueued = service.enqueuePendingImportSummaries();
    expect(enqueued).toMatchObject({
      enqueued: 1,
      memoryIds: [added.id]
    });
    expect(service.enqueuePendingImportSummaries()).toMatchObject({
      enqueued: 0,
      memoryIds: [added.id]
    });
    const jobsAfter = db.db.prepare(
      `SELECT job_type, status, target_memory_id
       FROM evolution_jobs
       WHERE target_memory_id = ?`
    ).all(added.id);
    expect(jobsAfter).toEqual([
      { job_type: "import_summary", status: "queued", target_memory_id: added.id }
    ]);

    await service.runWorkerOnce(100);
    await service.runWorkerOnce(100);
    expect(service.enqueuePendingImportSummaries()).toMatchObject({
      enqueued: 0,
      memoryIds: []
    });

    db.close();
  });

  it("limits worker runs to the imported memories requested by a source scan", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-targeted-import-worker"
    };
    const first = addAgentSourceImport(service, namespace, "first targeted import", "targeted-first");
    const unrelated = addAgentSourceImport(service, namespace, "unrelated import", "targeted-unrelated");

    const summaryRun = await service.runWorkerOnce(10, { targetMemoryIds: [first.id] });
    const embeddingRun = await service.runWorkerOnce(10, { targetMemoryIds: [first.id] });

    expect(summaryRun.jobs).toEqual([
      expect.objectContaining({ jobType: "import_summary", targetMemoryId: first.id })
    ]);
    expect(embeddingRun.jobs).toEqual([
      expect.objectContaining({ jobType: "embedding", targetMemoryId: first.id })
    ]);
    expect(service.enqueuePendingImportSummaries().memoryIds).toEqual([unrelated.id]);

    db.close();
  });

  it("orders import summaries by newest panel memories before embedding jobs", async () => {
    const root = createTestRoot("mindock-memory-import-order-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(llmCalls),
      embedder: createCapturingEmbedder([])
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-order"
    };

    const older = addAgentSourceImport(service, namespace, "older memory query", "order-old");
    const newer = addAgentSourceImport(service, namespace, "newer memory query", "order-new");
    db.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run("2026-06-10T10:00:00.000Z", older.id);
    db.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run("2026-06-10T12:00:00.000Z", newer.id);

    const run = await service.runWorkerOnce(10);

    expect(run.jobs.map((job) => job.targetMemoryId)).toEqual([newer.id, older.id]);
    expect(llmCalls[0]?.messages.find((message) => message.role === "user")?.content).toContain("newer memory query");

    db.close();
  });

  it("embeds summarized import memories before continuing later import summaries", async () => {
    const root = createTestRoot("mindock-memory-import-interleave-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(llmCalls),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-interleave"
    };

    for (let index = 0; index < 25; index += 1) {
      addAgentSourceImport(service, namespace, `imported query ${index}`, `interleave-${index}`);
    }

    const summaryRun = await service.runWorkerOnce(20);
    const embeddingRun = await service.runWorkerOnce(20);

    expect(summaryRun.jobs.map((job) => job.jobType)).toEqual(Array.from({ length: 20 }, () => "import_summary"));
    expect(embeddingRun.jobs.map((job) => job.jobType)).toEqual(Array.from({ length: 20 }, () => "embedding"));
    expect(llmCalls.filter((call) => call.options.operation === "capture.summarize")).toHaveLength(20);
    expect(embeddingTexts).toHaveLength(20);
    expect(embeddingTexts.every((text) => text.includes("Summary: LLM batch summary"))).toBe(true);
    expect(embeddingTexts.every((text) => text.includes("Original exchange:"))).toBe(true);
    expect(embeddingTexts.every((text) => text.includes("imported query"))).toBe(true);
    const remainingSummaries = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'import_summary'
         AND status = 'queued'`
    ).get() as { count: number };
    expect(remainingSummaries.count).toBe(5);

    db.close();
  });

  it("orders imported panel memories by source createdAt instead of worker updatedAt", async () => {
    const root = createTestRoot("mindock-memory-import-source-time-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm([]),
      embedder: createCapturingEmbedder([])
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-source-time"
    };

    const oldMemory = addAgentSourceImport(
      service,
      namespace,
      "old imported query",
      "source-time-old",
      "2026-06-01T10:00:00.000Z"
    );
    const newMemory = addAgentSourceImport(
      service,
      namespace,
      "new imported query",
      "source-time-new",
      "2026-06-02T10:00:00.000Z"
    );
    db.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`)
      .run("2026-06-03T10:00:00.000Z", oldMemory.id);
    db.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`)
      .run("2026-06-02T10:00:00.000Z", newMemory.id);

    const rows = db.db.prepare(
      `SELECT id, created_at, updated_at
       FROM memories
       WHERE id IN (?, ?)
       ORDER BY created_at DESC, updated_at DESC, id DESC`
    ).all(oldMemory.id, newMemory.id) as Array<{ id: string; created_at: string; updated_at: string }>;
    const panel = service.panelItems({ namespace, layer: "L1" });

    expect(rows.map((row) => row.id)).toEqual([newMemory.id, oldMemory.id]);
    expect(panel.items.map((item) => item.id)).toEqual([newMemory.id, oldMemory.id]);
    expect(panel.items.map((item) => item.createdAt)).toEqual([
      "2026-06-02T10:00:00.000Z",
      "2026-06-01T10:00:00.000Z"
    ]);

    db.close();
  });

  it("orders placeholder import embeddings by newest role heading", async () => {
    const root = createTestRoot("mindock-memory-import-placeholder-order-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm([]),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-placeholder-order"
    };

    const older = addAgentSourceImport(service, namespace, "older user query", "placeholder-old");
    const newer = addAgentSourceImport(service, namespace, "newer assistant placeholder query", "placeholder-new");
    db.db.prepare(`DELETE FROM evolution_jobs WHERE target_memory_id IN (?, ?)`).run(older.id, newer.id);
    db.db.prepare(`UPDATE memories SET updated_at = ?, info_json = json_set(info_json, '$.summary', ?) WHERE id = ?`)
      .run("2026-06-10T10:00:00.000Z", "## user", older.id);
    db.db.prepare(`UPDATE memories SET updated_at = ?, info_json = json_set(info_json, '$.summary', ?) WHERE id = ?`)
      .run("2026-06-10T12:00:00.000Z", "## assistant\n\nolder importer placeholder", newer.id);
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, session_id, episode_id, target_memory_id,
        payload_json, attempts, max_attempts, leased_until, last_error, created_at, updated_at
      ) VALUES
        ('job_placeholder_old', 'embedding', 'queued', ?, NULL, NULL, ?, '{}', 0, 3, NULL, NULL, ?, ?),
        ('job_placeholder_new', 'embedding', 'queued', ?, NULL, NULL, ?, '{}', 0, 3, NULL, NULL, ?, ?)`
    ).run(
      namespace.userId,
      older.id,
      "2026-06-10T10:00:00.000Z",
      "2026-06-10T10:00:00.000Z",
      namespace.userId,
      newer.id,
      "2026-06-10T12:00:00.000Z",
      "2026-06-10T12:00:00.000Z"
    );

    const run = await service.runWorkerOnce(10);

    expect(run.jobs.map((job) => job.targetMemoryId)).toEqual([newer.id, older.id]);
    expect(embeddingTexts).toEqual([]);
    const queuedSummary = db.db.prepare(
      `SELECT job_type, status
       FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type = 'import_summary'`
    ).all(newer.id) as Array<{ job_type: string; status: string }>;
    expect(queuedSummary).toEqual([{ job_type: "import_summary", status: "queued" }]);

    db.close();
  });

  it("guards imported trace embedding until a real summary job has run", async () => {
    const root = createTestRoot("mindock-memory-import-embedding-guard-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm([]),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-embedding-guard"
    };
    const added = addAgentSourceImport(service, namespace, "do not embed before summary", "guard-1");
    db.db.prepare(`DELETE FROM evolution_jobs WHERE target_memory_id = ?`).run(added.id);
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, session_id, episode_id, target_memory_id,
        payload_json, attempts, max_attempts, leased_until, last_error, created_at, updated_at
      ) VALUES (
        'job_guard_embedding', 'embedding', 'queued', ?, NULL, NULL, ?,
        '{}', 0, 3, NULL, NULL, ?, ?
      )`
    ).run(namespace.userId, added.id, "2026-06-10T10:00:00.000Z", "2026-06-10T10:00:00.000Z");

    const firstRun = await service.runWorkerOnce(100);

    expect(firstRun.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_guard_embedding",
        jobType: "embedding",
        status: "succeeded"
      })
    ]);
    expect(embeddingTexts).toEqual([]);
    const queuedSummary = db.db.prepare(
      `SELECT job_type, status
       FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type = 'import_summary'`
    ).all(added.id) as Array<{ job_type: string; status: string }>;
    expect(queuedSummary).toEqual([{ job_type: "import_summary", status: "queued" }]);
    expect(db.db.prepare(
      `SELECT 1 FROM memory_vector_entries WHERE memory_id = ?`
    ).get(added.id)).toBeUndefined();

    db.close();
  });

  it("keeps summarized memories text-searchable while their embedding is still pending", async () => {
    const root = createTestRoot("mindock-memory-import-retrieval-ready-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const embeddingTexts: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createBatchReflectionLlm(llmCalls, "ready retrieval summary"),
      embedder: createCapturingEmbedder(embeddingTexts),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          retrieval: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.retrieval,
            tagFilter: "off",
            llmFilterEnabled: false
          }
        }
      }
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-import-retrieval-ready"
    };
    const added = addAgentSourceImport(
      service,
      namespace,
      "ready retrieval unique keyword",
      "retrieval-ready"
    );
    const panel = service.panelItems({ namespace, layer: "L1" });
    const panelItem = panel.items.find((item) => item.id === added.id);
    expect(panelItem).toBeTruthy();
    expect(panelItem?.tags).toContain("摘要总结中");

    const beforeSummary = await service.search({
      namespace,
      query: "ready retrieval unique keyword",
      layers: ["L1"],
      limit: 5
    });
    expect(beforeSummary.hits.map((hit) => hit.id)).not.toContain(added.id);
    expect(beforeSummary.candidateMemoryIds).not.toContain(added.id);
    expect(embeddingTexts).toEqual([]);

    await service.runWorkerOnce(1);
    const afterSummary = await service.search({
      namespace,
      query: "ready retrieval unique keyword",
      layers: ["L1"],
      limit: 5
    });
    expect(afterSummary.hits.map((hit) => hit.id)).toContain(added.id);
    expect(afterSummary.candidateMemoryIds).toContain(added.id);
    expect(embeddingTexts).toEqual([]);

    await service.runWorkerOnce(1);
    expect(embeddingTexts).toHaveLength(1);
    expect(embeddingTexts[0]).toContain("Summary: ready retrieval summary");
    expect(embeddingTexts[0]).toContain("ready retrieval unique keyword");
    const afterEmbedding = await service.search({
      namespace,
      query: "ready retrieval unique keyword",
      layers: ["L1"],
      limit: 5
    });
    expect(afterEmbedding.hits.map((hit) => hit.id)).toContain(added.id);
    expect(afterEmbedding.candidateMemoryIds).toContain(added.id);

    db.close();
  });
});
