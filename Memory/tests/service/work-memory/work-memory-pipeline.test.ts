import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import type { MemoryService } from "../../../src/service/memory-service.js";
import {
  canonicalWorkMemoryText,
  WorkMemoryPipeline
} from "../../../src/service/work-memory/work-memory-pipeline.js";
import { stableHash } from "../../../src/utils/id.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";
import { upsertMemoryVectorForTest } from "../../fixtures/evolution-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("Work Memory pipeline", () => {
  it("在一次 token compaction boundary 为每个新 L3 batch 只入队一个 Job，重复 boundary 不重复入队", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "work-memory-boundary-session",
      userId: "work-memory-boundary-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/work-memory-boundary-project",
      workspaceHostId: "a".repeat(64),
      namespace
    });
    const completed = service.completeTurn("work-memory-boundary-turn", {
      sessionId: opened.sessionId,
      query: "项目要求所有提交前都运行测试。",
      answer: "已记录该要求。",
      status: "succeeded"
    });
    const boundaryNamespace = opened.projectId ? { ...namespace, projectId: opened.projectId } : namespace;

    const first = service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-boundary-request-1",
      adapterId: "codex-memory",
      source: "codex",
      namespace: boundaryNamespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const second = service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-boundary-request-2",
      adapterId: "codex-memory",
      source: "codex",
      namespace: boundaryNamespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const repos = new Repositories(db.db);
    const jobs = repos.runtime.listJobs(undefined, 100).filter((job) => job.jobType === "work_memory_extract");

    expect(first).toMatchObject({ scheduled: true, batchIds: expect.any(Array) });
    expect(first.batchIds).toHaveLength(1);
    expect(second).toMatchObject({ scheduled: false, batchIds: [] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.scopeSeq).toBe(1);
    expect(jobs[0]?.payload).toEqual(expect.objectContaining({
      trajectoryHash: expect.any(String),
      qa: [{ user: "项目要求所有提交前都运行测试。", assistant: "已记录该要求。" }]
    }));
  });

  it("第一阶段只抽取 requirement/reason，第二阶段 create 时生成 topic 并写入 L1 Work Memory", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "work-memory-create-session",
      userId: "work-memory-create-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/work-memory-create-project",
      workspaceHostId: "b".repeat(64),
      namespace
    });
    const completed = service.completeTurn("work-memory-create-turn", {
      sessionId: opened.sessionId,
      query: "SFT 训练必须使用固定的数据清洗流水线，因为结果需要可复现。",
      answer: "后续训练会遵守该要求。",
      status: "succeeded"
    });
    const boundaryNamespace = opened.projectId ? { ...namespace, projectId: opened.projectId } : namespace;
    service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-create-request",
      adapterId: "codex-memory",
      source: "codex",
      namespace: boundaryNamespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const repos = new Repositories(db.db);
    const job = findWorkMemoryJob(repos);
    const completeJson = vi.fn()
      .mockResolvedValueOnce({ work_memories: [{ requirement: "固定数据清洗流水线", reason: "保证训练结果可复现" }] })
      .mockResolvedValueOnce({ decisions: [{
        candidate_ref: "new_1",
        action: "create",
        matched_memory_ref: null,
        work_topic: "SFT training pipeline"
      }] });
    const llm = testLlm(completeJson as unknown as LlmClient["completeJson"]);
    const pipeline = new WorkMemoryPipeline({
      repos,
      llm,
      embedder: createCapturingEmbedder([]),
      embedAfterCapture: false,
      nowIso: () => "2026-01-01T00:00:00.000Z"
    });

    await pipeline.extract(job);

    const rows = repos.memories.list({
      memoryLayer: "L1",
      memoryKind: "work_memory",
      workMemoryUserId: opened.userId,
      workMemoryProjectId: opened.projectId ?? null
    }, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memoryLayer: "L1",
      memoryValue: canonicalWorkMemoryText("SFT training pipeline", "固定数据清洗流水线", "保证训练结果可复现"),
      properties: { internal_info: expect.objectContaining({
        memory_kind: "work_memory",
        work_topic: "SFT training pipeline",
        requirement: "固定数据清洗流水线",
        reason: "保证训练结果可复现",
        schema_version: 1
      }) }
    });
    const detail = service.getMemory(rows[0]!.id, { namespace: boundaryNamespace });
    expect("workMemory" in detail.item ? detail.item.workMemory : undefined).toEqual({
      workTopic: "SFT training pipeline",
      requirement: "固定数据清洗流水线",
      reason: "保证训练结果可复现",
      projectId: opened.projectId ?? null
    });
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(completeJson.mock.calls[0]?.[0]?.[1]?.content).toBe(
      "QUESTION & ANSWER:\nuser: SFT 训练必须使用固定的数据清洗流水线，因为结果需要可复现。\n\nassistant: 后续训练会遵守该要求。"
    );
    expect(completeJson.mock.calls[1]?.[0]?.[1]?.content).toContain("## 统一候选 Work Memory 池\n[]");
    expect(completeJson.mock.calls[1]?.[0]?.[1]?.content).toContain("## 待判断的新 Work Memory");
  });

  it("merge 只更新召回到的旧行，并复用旧 Work Memory 的 topic", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "work-memory-merge-session",
      userId: "work-memory-merge-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/work-memory-merge-project",
      workspaceHostId: "c".repeat(64),
      namespace
    });
    const existing = workMemoryRow(opened.userId, opened.projectId ?? null);
    const repos = new Repositories(db.db);
    repos.memories.insert(existing);
    expect(repos.memories.searchPatternIds(["固定", "SFT", "数据清洗"], {
      memoryLayer: "L1",
      memoryKind: "work_memory",
      workMemoryUserId: opened.userId,
      workMemoryProjectId: opened.projectId ?? null
    }, 5)).toHaveLength(1);
    const completed = service.completeTurn("work-memory-merge-turn", {
      sessionId: opened.sessionId,
      query: "同一条 SFT 数据清洗要求仍然必须保持固定，以便结果可复现。",
      answer: "会继续沿用原有要求。",
      status: "succeeded"
    });
    const boundaryNamespace = opened.projectId ? { ...namespace, projectId: opened.projectId } : namespace;
    service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-merge-request",
      adapterId: "codex-memory",
      source: "codex",
      namespace: boundaryNamespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const job = findWorkMemoryJob(repos);
    const completeJson = vi.fn()
      .mockResolvedValueOnce({ work_memories: [{ requirement: "固定 SFT 数据清洗", reason: "保证结果可复现" }] })
      .mockResolvedValueOnce({ decisions: [{
        candidate_ref: "new_1",
        action: "merge",
        matched_memory_ref: "existing_1",
        merged_requirement: "固定 SFT 数据清洗流程",
        merged_reason: "保证训练结果可复现",
        work_topic: "SFT training pipeline"
      }] });
    const pipeline = new WorkMemoryPipeline({
      repos,
      llm: testLlm(completeJson as unknown as LlmClient["completeJson"]),
      embedder: createCapturingEmbedder([]),
      embedAfterCapture: false,
      nowIso: () => "2026-01-02T00:00:00.000Z"
    });

    await pipeline.extract(job);

    const saved = repos.memories.get(existing.id);
    expect(saved).toMatchObject({
      id: existing.id,
      memoryKey: "work-memory-key",
      info: { owner: "preserve-me" },
      version: 2,
      memoryValue: canonicalWorkMemoryText("SFT training pipeline", "固定 SFT 数据清洗流程", "保证训练结果可复现"),
      properties: { internal_info: expect.objectContaining({ work_topic: "SFT training pipeline" }) }
    });
    expect(repos.memories.list({ memoryKind: "work_memory", workMemoryUserId: opened.userId, workMemoryProjectId: opened.projectId ?? null }, 20)).toHaveLength(1);
  });

  it("沿用 L1 tier2 检索并按 topic 分组注入 Work Memory", async () => {
    const { db, service } = createTestService({ embedder: createCapturingEmbedder([]) });
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "work-memory-retrieval-user",
      projectId: "work-memory-project"
    };
    const session = service.openSession({ namespace });
    const repos = new Repositories(db.db);
    const row = workMemoryRow(namespace.userId, namespace.projectId);
    repos.memories.insert(row);
    upsertMemoryVectorForTest(db, row.id, "vec_summary", [1, 0, 0]);
    const otherProject = { ...workMemoryRow(namespace.userId, "other-project"), id: "memory_work_other_project" };
    repos.memories.insert(otherProject);
    upsertMemoryVectorForTest(db, otherProject.id, "vec_summary", [1, 0, 0]);

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "固定 SFT 数据清洗流程",
      layers: ["L1"],
      limit: 5,
      includeInjectedContext: true
    });

    expect(recall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: row.id, kind: "work_memory", memoryLayer: "L1" })
    ]));
    expect(recall.hits.some((hit) => hit.id === otherProject.id)).toBe(false);
    expect(recall.sourceMemoryIds).toContain(row.id);
    expect(recall.injectedContext.markdown).toContain("## L1 Work Memories");
    expect(recall.injectedContext.markdown).toContain("### SFT training pipeline");
    expect(recall.injectedContext.markdown).toContain("Requirement: 固定 SFT 数据清洗流程");
    expect(recall.injectedContext.markdown).toContain("Requirement rationale: 保证训练结果可复现");
  });

  it("从没压缩过的会话在 session close 时抽完全部 trace", () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-close-session", "work-memory-close-user");
    service.completeTurn("work-memory-close-turn-1", {
      sessionId: opened.sessionId,
      query: "第一条要求。",
      answer: "已记录。",
      status: "succeeded"
    });
    service.completeTurn("work-memory-close-turn-2", {
      sessionId: opened.sessionId,
      query: "第二条要求。",
      answer: "也记录了。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    expect(workMemoryJobs(repos)).toHaveLength(0);

    service.closeSession(opened.sessionId, { namespace: opened.namespace });

    const jobs = workMemoryJobs(repos);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.qa).toEqual([
      { user: "第一条要求。", assistant: "已记录。" },
      { user: "第二条要求。", assistant: "也记录了。" }
    ]);
    expect(repos.runtime.getWorkMemoryCursor(opened.sessionId).lastExtractedSeq).toBe(2);
  });

  it("压缩之后再 close 只抽尾巴，已抽过的窗口不再入队", () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-tail-session", "work-memory-tail-user");
    const first = service.completeTurn("work-memory-tail-turn-1", {
      sessionId: opened.sessionId,
      query: "压缩前的要求。",
      answer: "已记录。",
      status: "succeeded"
    });
    service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-tail-request-1",
      adapterId: "codex-memory",
      source: "codex",
      namespace: opened.namespace,
      trigger: "token_compaction",
      throughL1MemoryId: first.l1MemoryId
    });
    const repos = new Repositories(db.db);
    expect(workMemoryJobs(repos)).toHaveLength(1);

    service.completeTurn("work-memory-tail-turn-2", {
      sessionId: opened.sessionId,
      query: "压缩后的要求。",
      answer: "也记录了。",
      status: "succeeded"
    });
    service.closeSession(opened.sessionId, { namespace: opened.namespace });

    const jobs = workMemoryJobs(repos);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.payload.qa).toEqual([{ user: "压缩后的要求。", assistant: "也记录了。" }]);
    expect(repos.runtime.getWorkMemoryCursor(opened.sessionId).lastExtractedSeq).toBe(2);
  });

  it("压缩之后再 idle，不再产生新的 extract", async () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-idle-session", "work-memory-idle-user");
    const completed = service.completeTurn("work-memory-idle-turn", {
      sessionId: opened.sessionId,
      query: "完整要求。",
      answer: "已记录。",
      status: "succeeded"
    });
    service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "work-memory-idle-request",
      adapterId: "codex-memory",
      source: "codex",
      namespace: opened.namespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const repos = new Repositories(db.db);
    makeIdleFlushDue(db, opened.sessionId);
    backdateInputTraces(db, opened.sessionId);

    await runWorkerRounds(service, 3, 20);

    expect(workMemoryJobs(repos)).toHaveLength(1);
  });

  it("idle 到期时抽出未抽取的增量，游标推进到当前最大 trace", async () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-idle-flush-session", "work-memory-idle-flush-user");
    service.completeTurn("work-memory-idle-flush-turn", {
      sessionId: opened.sessionId,
      query: "idle 才抽的要求。",
      answer: "已记录。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    expect(workMemoryJobs(repos)).toHaveLength(0);

    makeIdleFlushDue(db, opened.sessionId);
    backdateInputTraces(db, opened.sessionId);
    await runWorkerRounds(service, 3, 20);

    const jobs = workMemoryJobs(repos);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.qa).toEqual([{ user: "idle 才抽的要求。", assistant: "已记录。" }]);
    expect(repos.runtime.getWorkMemoryCursor(opened.sessionId).lastExtractedSeq).toBe(1);
  });

  it("idle 之后 close 不再重复抽取，也不关 episode", async () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-idle-close-session", "work-memory-idle-close-user");
    service.completeTurn("work-memory-idle-close-turn", {
      sessionId: opened.sessionId,
      query: "先 idle 再关闭。",
      answer: "已记录。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    makeIdleFlushDue(db, opened.sessionId);
    backdateInputTraces(db, opened.sessionId);
    await runWorkerRounds(service, 3, 20);
    expect(workMemoryJobs(repos)).toHaveLength(1);

    service.closeSession(opened.sessionId, { namespace: opened.namespace });

    expect(workMemoryJobs(repos)).toHaveLength(1);
    expect(repos.runtime.listJobs(undefined, 100).some((job) => job.jobType === "l3_world_model_update")).toBe(true);
  });

  it("同一 session 两次 turn 武装同一个 dedupeKey，runAfter 以第二次为准", () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-arm-session", "work-memory-arm-user");
    service.completeTurn("work-memory-arm-turn-1", {
      sessionId: opened.sessionId,
      query: "第一次说话。",
      answer: "好。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    const first = idleFlushJobs(repos);
    expect(first).toHaveLength(1);
    const firstRunAfter = String(first[0]?.payload.runAfter);

    service.completeTurn("work-memory-arm-turn-2", {
      sessionId: opened.sessionId,
      query: "第二次说话。",
      answer: "好。",
      status: "succeeded"
    });

    const second = idleFlushJobs(repos);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(Date.parse(String(second[0]?.payload.runAfter))).toBeGreaterThan(Date.parse(firstRunAfter));
  });

  it("session 已关闭时 idle flush 不抽取", async () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-closed-idle-session", "work-memory-closed-idle-user");
    service.completeTurn("work-memory-closed-idle-turn", {
      sessionId: opened.sessionId,
      query: "先关闭再 idle。",
      answer: "已记录。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    service.closeSession(opened.sessionId, { namespace: opened.namespace });
    const before = workMemoryJobs(repos).length;

    makeIdleFlushDue(db, opened.sessionId);
    backdateInputTraces(db, opened.sessionId);
    await runWorkerRounds(service, 3, 20);

    expect(workMemoryJobs(repos)).toHaveLength(before);
  });

  it("失败后重新武装的 idle flush 仍然可被调度", () => {
    const { db, service } = createTestService();
    const opened = openWorkMemorySession(service, "work-memory-retry-session", "work-memory-retry-user");    service.completeTurn("work-memory-retry-turn", {
      sessionId: opened.sessionId,
      query: "重试路径。",
      answer: "好。",
      status: "succeeded"
    });
    const repos = new Repositories(db.db);
    const job = idleFlushJobs(repos)[0]!;
    db.db.prepare(
      `UPDATE evolution_jobs SET status = 'failed', payload_json = '{}', last_error = 'boom' WHERE id = ?`
    ).run(job.id);

    service.completeTurn("work-memory-retry-turn-2", {
      sessionId: opened.sessionId,
      query: "再来一次。",
      answer: "好。",
      status: "succeeded"
    });

    const revived = idleFlushJobs(repos)[0]!;
    expect(revived.status).toBe("queued");
    expect(revived.payload.lastActivityAt).toEqual(expect.any(String));
    expect(revived.payload.runAfter).toEqual(expect.any(String));
  });
});

function workMemoryNamespace(
  opened: ReturnType<MemoryService["openSession"]>,
  sessionKey: string
): {
  source: string;
  profileId: string;
  userId: string;
  sessionKey: string;
  projectId?: string;
} {
  const base = { source: "codex", profileId: "default", userId: opened.userId, sessionKey };
  return opened.projectId ? { ...base, projectId: opened.projectId } : base;
}

function openWorkMemorySession(
  service: MemoryService,
  sessionKey: string,
  userId: string
): ReturnType<MemoryService["openSession"]> & { sessionKey: string; namespace: ReturnType<typeof workMemoryNamespace> } {
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    workspaceUri: `file:///tmp/${sessionKey}`,
    workspaceHostId: stableHash(sessionKey).slice(0, 64),
    namespace: { source: "codex", profileId: "default", sessionKey, userId }
  });
  return { ...opened, sessionKey, namespace: workMemoryNamespace(opened, sessionKey) };
}

function workMemoryJobs(repos: Repositories): EvolutionJobRecord[] {
  return repos.runtime.listJobs(undefined, 100).filter((job) => job.jobType === "work_memory_extract");
}

function idleFlushJobs(repos: Repositories): EvolutionJobRecord[] {
  return repos.runtime.listJobs(undefined, 100).filter((job) => job.jobType === "work_memory_idle_flush");
}

/** Pull the armed idle flush forward so the next worker pass leases it. */
function makeIdleFlushDue(db: { db: import("better-sqlite3").Database }, sessionId: string): void {
  const due = new Date(Date.now() - 1000).toISOString();
  idleFlushJobs(new Repositories(db.db))
    .filter((job) => job.sessionId === sessionId)
    .forEach((job) => {
      db.db.prepare(
        `UPDATE evolution_jobs SET payload_json = ? WHERE id = ?`
      ).run(JSON.stringify({ ...job.payload, runAfter: due }), job.id);
    });
}

/**
 * Backdate a Session's input traces so the idle handler sees a real quiet gap.
 * The handler reads the newest trace timestamp, not the clock, as last activity.
 */
function backdateInputTraces(
  db: { db: import("better-sqlite3").Database },
  sessionId: string,
  idleMs = 3 * 60 * 60 * 1000
): void {
  db.db.prepare(
    `UPDATE l3_world_model_input_traces SET created_at = ? WHERE session_id = ?`
  ).run(new Date(Date.now() - idleMs).toISOString(), sessionId);
}

function findWorkMemoryJob(repos: Repositories): EvolutionJobRecord {
  const job = repos.runtime.listJobs(undefined, 100).find((item) => item.jobType === "work_memory_extract");
  if (!job) throw new Error("work memory job not found");
  return job;
}

function testLlm(completeJson: LlmClient["completeJson"]): LlmClient {
  return {
    config: {} as LlmClient["config"],
    isConfigured: () => true,
    complete: vi.fn(),
    completeJson,
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}

function workMemoryRow(userId: string, projectId: string | null): MemoryRow {
  const at = "2026-01-01T00:00:00.000Z";
  const topic = "SFT training pipeline";
  const requirement = "固定 SFT 数据清洗流程";
  const reason = "保证训练结果可复现";
  const memoryValue = canonicalWorkMemoryText(topic, requirement, reason);
  return {
    id: "memory_work_existing",
    timeline: at,
    userId,
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryValue,
    tags: ["work_memory"],
    memoryKey: "work-memory-key",
    info: projectId ? { project_id: projectId, owner: "preserve-me" } : { owner: "preserve-me" },
    properties: {
      memory_type: "LongTermMemory",
      status: "activated",
      tags: ["work_memory"],
      info: projectId ? { project_id: projectId, owner: "preserve-me" } : { owner: "preserve-me" },
      internal_info: {
        memory_layer: "L1",
        memory_kind: "work_memory",
        work_topic: topic,
        requirement,
        reason,
        schema_version: 1
      }
    },
    memoryLayer: "L1",
    contentHash: stableHash(memoryValue),
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}
