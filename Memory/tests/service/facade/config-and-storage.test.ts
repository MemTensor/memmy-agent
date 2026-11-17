import { assignedEpisodeId } from "../../fixtures/memory-service-fixture.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  SCHEMA_MIGRATION_ID,
  SCHEMA_VERSION,
  createStorageBackend,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { withJobLeaseGuard } from "../../../src/storage/job-lease-context.js";
import {
  accountRuntimeConfig,
  addAgentSourceImport,
  configWithMemoryGates,
  createCapturingEmbedder,
  createBatchReflectionLlm,
  createFailingLlm,
  createMemoryServiceFixture,
  runWorkerRounds,
  runWorkerRoundsWithDueRetries,
  tableCounts
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / facade / config and storage", () => {
  it("resumes a configuration block when the effective loader config changes without reload", async () => {
    let currentConfig = { ...DEFAULT_MEMMY_CONFIG, summary: { ...DEFAULT_MEMMY_CONFIG.summary, model: "before-repair" } };
    let unauthorized = true;
    const llm = createBatchReflectionLlm([]);
    const completeJson = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      if (unauthorized) throw new Error("unauthorized API key");
      return completeJson<T>(messages, options);
    };
    const { db, service } = createTestService({ config: currentConfig, configLoader: () => ({ config: currentConfig }), llm });
    const namespace = { source: "codex", profileId: "config-recovery", userId: "config-recovery-user" };
    const added = addAgentSourceImport(service, namespace, "config repair preserves this job", "effective-config");
    await service.runWorkerOnce(1);
    const repos = new Repositories(db.db);
    const blocked = repos.runtime.listJobs("failed").find((job) => job.targetMemoryId === added.id)!;
    expect(blocked).toMatchObject({ blockedReason: "configuration", failureCount: 0 });
    expect(repos.processing.get(added.id)).toMatchObject({ state: "failed", retryAction: "open_settings" });
    unauthorized = false;
    expect(service.reconcileWorkerStartup(100).restartedFailedProcessing).toBe(0);
    expect((await service.runWorkerOnce(1)).leased).toBe(0);
    currentConfig = { ...currentConfig, summary: { ...currentConfig.summary, model: "after-repair" } };
    await service.runWorkerOnce(1);
    expect(repos.runtime.getJob(blocked.id)).toMatchObject({ status: "succeeded", failureCount: 0 });
    expect(repos.processing.get(added.id)?.state).toBe("embedding_pending");
  });

  it("starts a new worker through the public service without inheriting an expired caller lease", async () => {
    const { db, service } = createTestService({ llm: createBatchReflectionLlm([]) });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({ id: "expired-caller", jobType: "reflection", status: "queued", userId: "detached-caller",
      payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    const [caller] = repos.runtime.leaseQueuedJobs(1, 60, undefined, false, ["reflection"]);
    const child = addAgentSourceImport(service, { source: "codex", profileId: "detached", userId: "detached-caller" },
      "a fresh drain gets its own lease", "detached-drain");
    await withJobLeaseGuard(caller!, () => repos.runtime.isJobLeaseHeld(caller!), async () => {
      db.db.prepare("UPDATE evolution_jobs SET leased_until = ? WHERE id = ?")
        .run(new Date(Date.now() - 1_000).toISOString(), caller!.id);
      const result = await service.runWorkerOnce(1, { targetMemoryIds: [child.id] });
      expect(result.succeeded).toBe(1);
    });
    expect(repos.processing.get(child.id)?.state).toBe("embedding_pending");
    expect(repos.runtime.getJob(caller!.id)?.failureCount).toBe(0);
  });

  it("migrates the local sqlite schema", () => {
    const { db, root } = createTestService();
    const schema = db.schemaVersion();
    expect(schema.version).toBe(SCHEMA_VERSION);
    expect(schema.lastMigrationId).toBe(SCHEMA_MIGRATION_ID);
    const backend = createStorageBackend({
      mode: "dev",
      sqlitePath: join(root, "backend.sqlite")
    });
    expect(backend.capabilities()).toMatchObject({
      backendId: "sqlite-local",
      backend: "sqlite",
      fullText: "fts5",
      vector: "native",
      changeLog: true,
      idempotency: true,
      jobs: true,
      importExport: true
    });
    const backendService = createTestMemoryService({ backend, mode: "dev" });
    expect(backendService.health().storage.backendId).toBe("sqlite-local");
    backend.close();
    const remoteBackend = createStorageBackend({
      mode: "cloud",
      backend: "openmem-cloud-rest",
      endpoint: "https://memory.example.test",
      token: "cloud-token",
      schemaVersion: "runtime-v1"
    });
    expect(remoteBackend.capabilities()).toMatchObject({
      backendId: "openmem-cloud-rest",
      backend: "openmem-cloud-rest",
      fullText: "remote",
      vector: "remote",
      changeLog: true,
      idempotency: true
    });
    expect(() => remoteBackend.repositories()).toThrow(/agent-side REST backend/);
    const columns = db.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("memory_layer");
    expect(columns.map((column) => column.name)).toContain("properties_json");
    const rawTurnColumns = db.db.prepare(`PRAGMA table_info(raw_turns)`).all() as Array<{ name: string }>;
    expect(rawTurnColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "message_payload_json",
      "redacted_at",
      "deleted_at"
    ]));
    const sessionColumns = db.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toContain("last_seen_at");
    const episodeColumns = db.db.prepare(`PRAGMA table_info(episodes)`).all() as Array<{ name: string }>;
    expect(episodeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "turn_count",
      "feedback_ids_json",
      "decision_repair_ids_json",
      "l2_policy_ids_json",
      "l3_world_model_ids_json",
      "skill_memory_ids_json",
      "r_task",
      "reward_detail_json",
      "pipeline_status"
    ]));
    const feedbackColumns = db.db.prepare(`PRAGMA table_info(feedback)`).all() as Array<{ name: string }>;
    expect(feedbackColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "project_id",
      "context_hash"
    ]));
    const skillTrialColumns = db.db.prepare(`PRAGMA table_info(skill_trials)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(skillTrialColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "status",
      "l1_memory_id"
    ]));
    expect(skillTrialColumns.find((column) => column.name === "episode_id")?.notnull).toBe(0);
    const recallColumns = db.db.prepare(`PRAGMA table_info(recall_events)`).all() as Array<{ name: string }>;
    expect(recallColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "namespace_id",
      "query_hash",
      "candidate_memory_ids_json",
      "injected_memory_ids_json",
      "dropped_json",
      "outcome"
    ]));
    const changeColumns = db.db.prepare(`PRAGMA table_info(memory_change_log)`).all() as Array<{ name: string }>;
    expect(changeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "namespace_id",
      "kind",
      "op",
      "entity_id",
      "version"
    ]));
    const retryColumns = db.db.prepare(`PRAGMA table_info(embedding_retry_queue)`).all() as Array<{ name: string }>;
    expect(retryColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "target_kind",
      "target_id",
      "vector_field",
      "source_text",
      "embed_role",
      "claimed_by",
      "lease_until"
    ]));
    const auditTable = db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'`
    ).get() as { name: string } | undefined;
    expect(auditTable?.name).toBe("audit_logs");
    db.close();
  });

  it("coalesces active evolution jobs by dedupe key instead of payload reason", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const first = repos.runtime.enqueueJob({
      id: "job_embed_first",
      jobType: "embedding",
      status: "queued",
      dedupeKey: "embedding:trace_same",
      userId: "dedupe-user",
      targetMemoryId: "trace_same",
      payload: { reason: "capture.created", sourceJobId: "job_a" },
      attempts: 0,
      maxAttempts: 3,
      createdAt: "2026-06-22T01:00:00.000Z",
      updatedAt: "2026-06-22T01:00:00.000Z"
    });
    const second = repos.runtime.enqueueJob({
      id: "job_embed_second",
      jobType: "embedding",
      status: "queued",
      dedupeKey: "embedding:trace_same",
      userId: "dedupe-user",
      targetMemoryId: "trace_same",
      payload: { reason: "reflection.updated", sourceJobId: "job_b" },
      attempts: 0,
      maxAttempts: 3,
      createdAt: "2026-06-22T01:00:01.000Z",
      updatedAt: "2026-06-22T01:00:01.000Z"
    });

    const rows = db.db.prepare(
      `SELECT id, dedupe_key, payload_json
       FROM evolution_jobs
       WHERE dedupe_key = ?`
    ).all("embedding:trace_same") as Array<{ id: string; dedupe_key: string; payload_json: string }>;

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("job_embed_first");
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      reason: "reflection.updated",
      sourceJobId: "job_b"
    });
    db.close();
  });

  it("reloads runtime model config without replacing the storage backend", () => {
    const root = createTestRoot("mindock-memory-reload-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const nextConfig = accountRuntimeConfig();
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: DEFAULT_MEMMY_CONFIG,
      configLoader: () => ({ config: nextConfig })
    });

    const result = service.reloadConfig({ reason: "profile_switched" });

    expect(result).toMatchObject({
      changed: true,
      requiresRestart: false,
      models: {
        summary: {
          provider: "openai_compatible",
          model: "memory_summary",
          configured: true,
          remote: true,
          routing: "follow"
        },
        evolution: {
          provider: "openai_compatible",
          model: "memory_evolution",
          configured: true,
          remote: true,
          routing: "follow"
        },
        embedding: {
          provider: "local",
          model: "capturing-test-embedding",
          configured: true,
          remote: false,
          mode: "cloud"
        }
      }
    });
    expect(service.health().models.summary.routing).toBe("follow");
    expect(service.health().storage.backendId).toBe("sqlite-local");

    db.close();
  });

  it("reports a model failure through the health status", () => {
    const { db } = createTestService();
    const service = createTestMemoryService({
      db,
      llm: createFailingLlm(),
      embedder: createCapturingEmbedder([])
    });

    expect(service.health().ok).toBe(false);
    expect(service.health().models.evolution.lastError).toBe("llm filter unavailable");
  });

  it("restarts retryable terminal processing failures after model config reload", async () => {
    const root = createTestRoot("mindock-memory-reload-failed-processing-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: DEFAULT_MEMMY_CONFIG,
      configLoader: () => ({ config: DEFAULT_MEMMY_CONFIG }),
      llm: createFailingLlm(),
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "hermes", profileId: "default", userId: "reload-failure-user" };
    const added = addAgentSourceImport(service, namespace, "retry after config reload", "reload-failure");
    await runWorkerRoundsWithDueRetries(service, db, [added.id], 3, 1);
    const failed = service.memoryProcessingStatus([added.id], { namespace }).items[0];
    expect(failed?.state).toBe("failed");

    service.reloadConfig({
      reason: "manual_processing_retry",
      restartFailedProcessing: false
    });
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state).toBe("failed");

    service.reloadConfig({ reason: "model_settings_saved" });

    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]).toMatchObject({
      state: "summary_pending",
      stage: "summary",
      attemptCount: 0,
      errorCode: failed?.errorCode,
      errorMessage: failed?.errorMessage,
      failedAt: failed?.failedAt
    });
    const jobs = db.db.prepare(
      `SELECT status, attempts
       FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type = 'import_summary'
       ORDER BY created_at ASC, id ASC`
    ).all(added.id) as Array<{ status: string; attempts: number }>;
    expect(jobs).toEqual([
      { status: "dead_letter", attempts: 3 },
      { status: "queued", attempts: 0 }
    ]);

    db.close();
  });

  it("generates semantic ids for future memory writes", async () => {
    const { service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-id-prefix"
    };
    const session = service.openSession({ namespace });
    const complete = (await service.completeTurn("turn-id-prefix", {
      sessionId: session.sessionId,
      query: "Remember that generated IDs should use semantic prefixes.",
      answer: "Trace memories and episodes should expose their entity type in the ID."
    }));

    const policy = service.addMemory({
      namespace,
      layer: "L2",
      title: "ID prefix policy",
      content: "Prefer semantic ID prefixes for generated policy memories."
    });
    const world = service.addMemory({
      namespace,
      layer: "L3",
      title: "ID prefix world model",
      content: "The local runtime uses semantic prefixes to identify world model memories."
    });
    const skill = service.addMemory({
      namespace,
      layer: "Skill",
      title: "ID prefix skill",
      content: "Use semantic prefixes when creating generated skill memories."
    });

    expect(complete.l1MemoryId).toMatch(/^trace_[a-f0-9]{20}$/);
    expect(assignedEpisodeId(service, complete)).toMatch(/^episode_[a-f0-9]{20}$/);
    expect(policy.id).toMatch(/^policy_[a-f0-9]{20}$/);
    expect(world.id).toMatch(/^world_[a-f0-9]{20}$/);
    expect(skill.id).toMatch(/^skill_[a-f0-9]{20}$/);
  });

  it("disables memory writes while still allowing read-only retrieval", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-memory-add-disabled"
    };
    const seed = service.addMemory({
      namespace,
      layer: "L2",
      title: "Evaluation seed memory",
      content: "Evaluation seed memory says banana routing uses the fixture database."
    });
    await runWorkerRounds(service, 2, 20);
    const before = tableCounts(db, [
      "memories",
      "sessions",
      "raw_turns",
      "recall_events",
      "memory_change_log",
      "evolution_jobs",
      "api_logs"
    ]);
    const readOnly = createTestMemoryService({
      db,
      mode: "dev",
      config: configWithMemoryGates({
        enableMemoryAdd: false,
        enableMemorySearch: true
      })
    });

    const recall = await readOnly.search({
      namespace,
      query: "banana routing fixture database",
      includeInjectedContext: true
    });
    expect(recall.hits.map((hit) => hit.id)).toContain(seed.id);
    expect(recall.status).toContain("memory_add:disabled:no_recall_log");

    const session = readOnly.openSession({ namespace, sessionId: "readonly-session" });
    expect(session.sessionId).toBe("readonly-session");
    const start = await readOnly.startTurn({
      namespace,
      sessionId: session.sessionId,
      query: "Use the banana routing fixture database memory.",
      turnId: "readonly-turn"
    });
    expect(start.hits.map((hit) => hit.id)).toContain(seed.id);
    expect(start.status).toContain("memory_add:disabled:no_turn_write");
    const complete = (await readOnly.completeTurn("readonly-turn", {
      namespace,
      sessionId: session.sessionId,
      query: "Use the banana routing fixture database memory.",
      answer: "Used the seed memory."
    }));
    expect(complete.l1MemoryIds).toEqual([]);
    expect(complete.scheduledEvolution).toBe(false);
    expect(() => readOnly.addMemory({
      namespace,
      content: "This write must be rejected."
    })).toThrow("memory add is disabled");

    expect(tableCounts(db, [
      "memories",
      "sessions",
      "raw_turns",
      "recall_events",
      "memory_change_log",
      "evolution_jobs",
      "api_logs"
    ])).toEqual(before);
    db.close();
  });
});
