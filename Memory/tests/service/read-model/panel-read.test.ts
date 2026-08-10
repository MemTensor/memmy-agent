import { afterEach, describe, expect, it } from "vitest";
import { type MemoryRow } from "../../../src/index.js";
import { updateTraceSummary } from "../../../src/service/embedding/embedding-job-processor.js";
import { changeLogToPanelChange } from "../../../src/service/read-model/panel-read.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / read model / panel", () => {
  it("preserves Span kinds in panel change records", () => {
    expect(changeLogToPanelChange({
      seq: 1,
      memoryId: "span_panel_change",
      kind: "span",
      op: "created",
      entityId: "span_panel_change",
      userId: "user-panel-span-change",
      changeType: "span_created",
      source: "worker.span_big_turn.v1",
      createdAt: "2026-07-24T06:38:21.017Z"
    })).toMatchObject({
      kind: "span",
      id: "span_panel_change",
      op: "created",
      source: "worker"
    });
  });

  it("stores source Agent directly on memory_add and memory_search logs", async () => {
    const { db, service } = createTestService();
    service.addMemory({
      content: "Remember the custom CLI source.",
      source: "test_agent"
    });
    await service.search({
      query: "custom CLI source",
      source: "test_agent",
      layers: ["L1"]
    });

    const logs = service.apiLogs({
      tools: ["memory_add", "memory_search"],
      sourceAgent: "test_agent",
      limit: 10
    });
    expect(logs.total).toBe(2);
    expect(logs.logs.map((log) => log.toolName)).toEqual(["memory_search", "memory_add"]);
    expect(logs.logs.map((log) => log.sourceAgent)).toEqual(["test_agent", "test_agent"]);
    expect(db.db.prepare(
      `SELECT tool_name, source_agent FROM api_logs ORDER BY called_at DESC, id DESC`
    ).all()).toEqual([
      { tool_name: "memory_search", source_agent: "test_agent" },
      { tool_name: "memory_add", source_agent: "test_agent" }
    ]);
    db.close();
  });

  it("uses the current trace summary when rendering memory_add logs", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: { source: "codex", profileId: "default", userId: "user-panel-log-summary" }
    });
    const completed = service.completeTurn("turn-panel-log-summary", {
      sessionId: session.sessionId,
      query: "Summarize this trace for the log panel.",
      answer: "The worker will generate a concise trace summary."
    });
    const repos = new Repositories(db.db);
    const trace = repos.memories.get(completed.l1MemoryId);
    expect(trace).toBeDefined();
    repos.memories.update(updateTraceSummary(trace!, {
      summary: "Current trace summary for the log panel",
      updatedAt: new Date().toISOString()
    }));

    const log = service.apiLogs({ tools: ["memory_add"], limit: 1 }).logs[0];
    const output = JSON.parse(log!.outputJson) as { details: Array<{ summary?: string }> };
    expect(output.details[0]?.summary).toBe("Current trace summary for the log panel");
    db.close();
  });

  it("does not record memory_add logs for agent source scan imports", () => {
    const { db, service } = createTestService();
    service.addMemory({
      requestId: "cursor-import-log-1",
      adapterId: "agent-source:cursor",
      namespace: {
        source: "codex",
        profileId: "default",
        userId: "agent-source-log-user"
      },
      content: "User: imported scan turn\n\nAssistant: imported scan answer",
      layer: "L1",
      source: "cursor",
      tags: ["agent-source", "cursor"],
      turnId: "cursor:conversation-1:0"
    });

    expect(service.apiLogs({ tools: ["memory_add"], limit: 10 }).logs).toHaveLength(0);
    db.close();
  });

  it("reports reflected L1 metrics from internal trace info in panel items", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const memory: MemoryRow = {
      id: "trace_panel_reflection_metric",
      timeline: at,
      userId: "user-panel-reflection-metric",
      sessionId: "session-panel-reflection-metric",
      agentId: "codex",
      appId: "workspace-panel-reflection-metric",
      memoryType: "LongTermMemory",
      status: "activated",
      visibility: "private",
      memoryKey: "trace:session-panel-reflection-metric:turn:0",
      memoryValue: "Summary: reflected top-level metric\nUser:\ncheck reflection",
      tags: [],
      info: {
        summary: "reflected top-level metric"
      },
      properties: {
        memory_type: "LongTermMemory",
        status: "activated",
        tags: [],
        internal_info: {
          memory_layer: "L1",
          memory_kind: "trace",
          schema_version: 1,
          summary: "reflected top-level metric",
          reflection: "RELATED",
          alpha: 0.5,
          value: 0.25,
          trace: {
            raw_turn_id: "raw_panel_reflection_metric",
            userText: "check reflection",
            agentText: "done"
          }
        }
      },
      memoryLayer: "L1",
      contentHash: "panel-reflection-metric-content",
      version: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null
    };
    repos.memories.insert(memory);

    const item = service.panelItems({
      userId: "user-panel-reflection-metric",
      layer: "L1"
    }).items[0];
    expect(item?.metrics).toEqual({
      value: 0.25,
      alpha: 0.5,
      reflectionDone: true
    });

    const spanMemory: MemoryRow = {
      ...memory,
      id: "span_panel_goal",
      memoryKey: "span:session-panel-reflection-metric:0",
      contentHash: "panel-span-goal-content",
      properties: {
        ...memory.properties,
        internal_info: {
          ...memory.properties.internal_info,
          memory_kind: "span",
          span: { span_goal: "Run the panel span regression" }
        }
      }
    };
    repos.memories.insert(spanMemory);

    expect(service.panelItems({
      userId: "user-panel-reflection-metric",
      layer: "L1"
    }).items.find((candidate) => candidate.id === spanMemory.id)?.metadata).toMatchObject({
      spanGoal: "Run the panel span regression"
    });
    db.close();
  });

  it("uses trace user text until a generated summary is available", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "user-panel-trace-title"
    };
    const session = service.openSession({ namespace });
    const completed = service.completeTurn("turn-panel-trace-title", {
      sessionId: session.sessionId,
      query: "修复项目级会话的启动兼容问题",
      answer: "已定位并修复旧会话缺少工作区绑定的问题。"
    });

    const pendingItem = service.panelItems({ namespace, layer: "L1" }).items[0];
    expect(pendingItem?.processing?.state).toBe("summary_pending");
    expect(pendingItem?.title).toBe("修复项目级会话的启动兼容问题");

    repos.processing.update(completed.l1MemoryId, {
      state: "failed",
      stage: "summary",
      errorCode: "summary_failed",
      errorMessage: "summary model unavailable",
      failedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, ["summary_pending"]);
    const failedItem = service.panelItems({ namespace, layer: "L1" }).items[0];
    expect(failedItem?.processing?.state).toBe("failed");
    expect(failedItem?.title).toBe("修复项目级会话的启动兼容问题");

    const current = repos.memories.get(completed.l1MemoryId);
    expect(current).toBeDefined();
    repos.memories.update(updateTraceSummary(current!, {
      summary: "旧会话缺少工作区绑定会导致 Gateway 启动失败",
      updatedAt: new Date().toISOString()
    }));
    const summarizedItem = service.panelItems({ namespace, layer: "L1" }).items[0];
    expect(summarizedItem?.summary).toBe("旧会话缺少工作区绑定会导致 Gateway 启动失败");

    db.close();
  });

  it("pages panel items for list and search queries", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-panel-pagination"
    };
    const session = service.openSession({ namespace });
    const completed = ["alpha", "beta", "gamma"].map((suffix) =>
      service.completeTurn(`turn-panel-pagination-${suffix}`, {
        sessionId: session.sessionId,
        query: `panel pagination needle ${suffix}`,
        answer: `stored panel pagination needle ${suffix}`,
        tags: ["panel-pagination"]
      })
    );

    const firstPage = service.panelItems({
      namespace,
      layer: "L1",
      limit: 2
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBe("2");
    const secondPage = service.panelItems({
      namespace,
      layer: "L1",
      limit: 2,
      cursor: Number(firstPage.nextCursor)
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))).toEqual(
      new Set(completed.map((item) => item.l1MemoryId))
    );

    const firstSearchPage = service.panelItems({
      namespace,
      layer: "L1",
      q: "panel pagination needle",
      limit: 2
    });
    expect(firstSearchPage.items).toHaveLength(2);
    expect(firstSearchPage.nextCursor).toBe("2");
    const secondSearchPage = service.panelItems({
      namespace,
      layer: "L1",
      q: "panel pagination needle",
      limit: 2,
      cursor: Number(firstSearchPage.nextCursor)
    });
    expect(secondSearchPage.items).toHaveLength(1);
    expect(secondSearchPage.nextCursor).toBeUndefined();
    expect(new Set([...firstSearchPage.items, ...secondSearchPage.items].map((item) => item.id))).toEqual(
      new Set(completed.map((item) => item.l1MemoryId))
    );
    const idSearchPage = service.panelItems({
      namespace,
      layer: "L1",
      q: completed[0]!.l1MemoryId,
      limit: 20
    });
    expect(idSearchPage.items.map((item) => item.id)).toEqual([completed[0]!.l1MemoryId]);

    db.close();
  });

  it("filters L1 panel items by source Agent before pagination", () => {
    const { db, service } = createTestService();
    const userId = "user-panel-source-agent";
    const cursorSession = service.openSession({
      namespace: { source: "cursor", profileId: "default", userId }
    });
    const memmySession = service.openSession({
      namespace: { source: "memmy-agent", profileId: "default", userId }
    });
    const codexSession = service.openSession({
      namespace: { source: "codex", profileId: "default", userId }
    });
    const ompSession = service.openSession({
      namespace: { source: "omp", profileId: "default", userId }
    });
    const cursorMemory = service.completeTurn("turn-panel-source-cursor", {
      sessionId: cursorSession.sessionId,
      query: "cursor panel source memory",
      answer: "cursor answer"
    });
    const memmyMemory = service.completeTurn("turn-panel-source-memmy", {
      sessionId: memmySession.sessionId,
      query: "memmy panel source memory",
      answer: "memmy answer"
    });
    const otherMemory = service.completeTurn("turn-panel-source-other", {
      sessionId: codexSession.sessionId,
      query: "other panel source memory",
      answer: "other answer"
    });
    const ompMemory = service.completeTurn("turn-panel-source-omp", {
      sessionId: ompSession.sessionId,
      query: "omp panel source memory",
      answer: "omp answer"
    });
    db.db.prepare("UPDATE memories SET agent_id = 'test_agent', session_id = NULL WHERE id = ?")
      .run(otherMemory.l1MemoryId);

    expect(service.panelItems({ layer: "L1", sourceAgent: "cursor", limit: 1 })).toMatchObject({
      total: 1,
      items: [{ id: cursorMemory.l1MemoryId }]
    });
    expect(service.panelItems({ layer: "L1", sourceAgent: "memmy_agent", limit: 1 })).toMatchObject({
      total: 1,
      items: [{ id: memmyMemory.l1MemoryId }]
    });
    expect(service.panelItems({ layer: "L1", sourceAgent: "omp", limit: 1 })).toMatchObject({
      total: 1,
      items: [{ id: ompMemory.l1MemoryId, metadata: { source: "omp" } }]
    });
    expect(service.panelItems({
      layer: "L1",
      excludedSourceAgents: ["memmy-agent", "cursor", "claude_code", "codex", "pi", "opencode", "openclaw", "hermes", "workbuddy", "omp"],
      limit: 1
    })).toMatchObject({
      total: 1,
      items: [{ id: otherMemory.l1MemoryId, metadata: { source: "test_agent" } }]
    });
    db.close();
  });

  it("derives OMP panel sources from imported session ids", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: { source: "codex", profileId: "default", userId: "user-panel-omp" }
    });
    const completed = service.completeTurn("turn-panel-omp", {
      sessionId: session.sessionId,
      query: "omp panel source memory",
      answer: "omp answer"
    });
    db.db.prepare("UPDATE memories SET agent_id = 'codex', session_id = 'omp::session-imported' WHERE id = ?")
      .run(completed.l1MemoryId);

    expect(service.panelItems({ layer: "L1" })).toMatchObject({
      items: [{ id: completed.l1MemoryId, metadata: { source: "omp" } }]
    });
    expect(service.panelOverviewSummary({}).sourceDistribution).toContainEqual(
      expect.objectContaining({ source: "omp", count: 1 })
    );
    expect(service.panelItems({ layer: "L1", sourceAgent: "omp" })).toMatchObject({
      total: 1,
      items: [{ id: completed.l1MemoryId, metadata: { source: "omp" } }]
    });
    expect(service.panelItems({ layer: "L1", excludedSourceAgents: ["omp"] })).toMatchObject({
      total: 0,
      items: []
    });
    db.close();
  });

  it("lists tasks from episodes, clamps pages, and deletes a whole task transactionally", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-panel-tasks"
    };
    const session = service.openSession({ namespace });
    const completed = service.completeTurn("turn-panel-task", {
      sessionId: session.sessionId,
      query: "find this task by its conversation",
      answer: "task answer"
    });

    expect(service.panelTasks({ namespace, q: "conversation", page: 99 })).toMatchObject({
      tasks: [{ id: completed.episodeId, memoryIds: [completed.l1MemoryId] }],
      page: 1,
      total: 1,
      totalPages: 1
    });
    expect(service.deletePanelTask(completed.episodeId, { namespace })).toMatchObject({
      ok: true,
      id: completed.episodeId,
      deletedMemoryIds: [completed.l1MemoryId]
    });
    expect(service.panelTasks({ namespace, page: 1 })).toMatchObject({ tasks: [], total: 0, page: 1 });
    expect(() => service.getMemory(completed.l1MemoryId, { namespace })).toThrow(/not found/i);

    db.close();
  });

  it("uses structured L3 world model titles for panel items instead of memory keys", () => {
    const { db, service } = createTestService();
    const at = "2026-06-05T08:00:00.000Z";
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value, tags_json,
        info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        'world_panel_title', @at, 'world-panel-user', NULL, NULL, 'memmy-agent', NULL,
        'LongTermMemory', 'activated', 'private', 'world:17dbbffb4ceda711',
        '## Environment\n- **Python algorithm example requests** - User often asks for Python algorithm examples.\n## Inference\n- Python examples should include edge cases.',
        '["world_model","python"]',
        '{"summary":"Environment"}',
        @propertiesJson,
        'L3', 'hash_world_panel_title', 1, @at, @at, NULL
      )`
    ).run({
      at,
      propertiesJson: JSON.stringify({
        memory_type: "LongTermMemory",
        status: "activated",
        tags: ["world_model", "python"],
        info: { summary: "Environment" },
        internal_info: {
          memory_layer: "L3",
          memory_kind: "world_model",
          schema_version: 1,
          world_model: {
            title: "Python algorithm example requests",
            body: "Python algorithm example requests describe repeated requests for examples and edge cases.",
            domain_tags: ["python"],
            policy_ids: []
          }
        }
      })
    });

    const panel = service.panelItems({
      namespace: {
        source: "memmy-agent",
        profileId: "default",
        userId: "world-panel-user"
      },
      layer: "L3",
      limit: 10
    });

    expect(panel.items).toHaveLength(1);
    expect(panel.items[0]?.title).toBe("Python algorithm example requests");
    expect(panel.items[0]?.title).not.toContain("world:");
    expect(panel.items[0]?.summary).not.toBe("Environment");
    const detail = service.getMemory("world_panel_title");
    expect(detail.item.title).toBe("Python algorithm example requests");
    expect(detail.item.title).not.toContain("world:");
    expect(detail.item.summary).not.toBe("Environment");

    db.close();
  });

  it("normalizes internal panel source labels for overview distribution", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "source-label-user"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-source-label", {
      sessionId: session.sessionId,
      query: "remember source label normalization",
      answer: "internal pipeline sources should not be displayed"
    });

    const firstSummary = service.panelOverviewSummary({ namespace });
    const firstSources = firstSummary.sourceDistribution.map((item) => item.source);
    expect(firstSources).toContain("codex");
    expect(firstSources).not.toContain("turn.complete");
    expect(firstSummary.dailyActivity.some((item) => item.count > 0)).toBe(true);

    const row = db.db.prepare(
      `SELECT info_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { info_json: string };
    const info = JSON.parse(row.info_json) as Record<string, unknown>;
    info.source = "worker.l2_induction.v7";
    db.db.prepare(
      `UPDATE memories
       SET info_json = ?
       WHERE id = ?`
    ).run(JSON.stringify(info), complete.l1MemoryId);

    const workerSummary = service.panelOverviewSummary({ namespace });
    const workerSources = workerSummary.sourceDistribution.map((item) => item.source);
    expect(workerSources).toContain("codex");
    expect(workerSources).not.toContain("worker.l2_induction.v7");

    db.close();
  });

  it("exposes OpenClaw as the panel source for OpenClaw trace memories", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "openclaw",
      profileId: "default",
      userId: "source-openclaw-user",
      sessionKey: "openclaw-window-1"
    };
    const session = service.openSession({
      namespace,
      sessionId: "openclaw-memory-agent:main:test"
    });
    const complete = service.completeTurn("turn-source-openclaw", {
      sessionId: session.sessionId,
      query: "remember openclaw panel source",
      answer: "OpenClaw should be displayed as the source agent."
    });

    const list = service.panelItems({ namespace, layer: "L1" });
    const itemBeforeEmbedding = list.items.find((item) => item.id === complete.l1MemoryId);
    expect(itemBeforeEmbedding?.tags).toContain("摘要总结中");
    expect(itemBeforeEmbedding?.tags).toEqual(expect.arrayContaining(["agent-source", "openclaw"]));
    expect(itemBeforeEmbedding?.metadata?.source).toBe("openclaw");

    const detail = service.getMemory(complete.l1MemoryId, { namespace });
    expect(detail.item.tags).toContain("摘要总结中");
    expect(detail.item.tags).toEqual(expect.arrayContaining(["agent-source", "openclaw"]));
    expect(detail.item.metadata.source).toBe("openclaw");
    expect(detail.refs.episode).toMatchObject({
      id: complete.episodeId,
      sessionId: session.sessionId,
      status: "open"
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    expect(embeddingTexts.length).toBeGreaterThan(0);
    const listAfterEmbedding = service.panelItems({ namespace, layer: "L1" });
    expect(listAfterEmbedding.items.find((item) => item.id === complete.l1MemoryId)?.tags).not.toContain("索引建立中");
    expect(listAfterEmbedding.items.find((item) => item.id === complete.l1MemoryId)?.metadata?.source).toBe("openclaw");

    db.close();
  });

  it("scopes panel change logs, jobs, and overview by namespace", () => {
    const { db, service } = createTestService();
    const namespaceA = {
      source: "codex",
      profileId: "default",
      userId: "shared-user",
      workspaceId: "workspace-a"
    };
    const namespaceB = {
      source: "codex",
      profileId: "default",
      userId: "shared-user",
      workspaceId: "workspace-b"
    };
    const sessionA = service.openSession({ namespace: namespaceA });
    const sessionB = service.openSession({ namespace: namespaceB });
    const completeA = service.completeTurn("turn-namespace-a", {
      sessionId: sessionA.sessionId,
      query: "namespace a memory",
      answer: "stored in namespace a"
    });
    const completeB = service.completeTurn("turn-namespace-b", {
      sessionId: sessionB.sessionId,
      query: "namespace b memory",
      answer: "stored in namespace b"
    });

    const changesA = service.panelChanges({ namespace: namespaceA });
    expect(changesA.changes.map((change) => change.id)).toContain(completeA.l1MemoryId);
    expect(changesA.changes.map((change) => change.id)).not.toContain(completeB.l1MemoryId);
    expect(changesA.changes.some((change) => change.kind === "job")).toBe(true);
    const jobIdsA = service.panelJobs({ namespace: namespaceA }).items.map((job) => job.id);
    expect(jobIdsA).toEqual(expect.arrayContaining(completeA.jobs.map((job) => job.jobId)));
    expect(jobIdsA).not.toEqual(expect.arrayContaining(completeB.jobs.map((job) => job.jobId)));
    const overviewA = service.panelOverview({ namespace: namespaceA });
    expect(overviewA.stats.jobs.queued).toBe(completeA.jobs.length);
    expect(overviewA.stats.byLayer.L1).toBe(completeA.l1MemoryIds.length);
    expect(overviewA.stats.byStatus.activated).toBe(completeA.l1MemoryIds.length);
    expect(overviewA.stats.episodes.open).toBe(1);

    const changesB = service.panelChanges({ namespace: namespaceB });
    expect(changesB.changes.map((change) => change.id)).toContain(completeB.l1MemoryId);
    expect(changesB.changes.map((change) => change.id)).not.toContain(completeA.l1MemoryId);
    expect(changesB.changes.some((change) => change.kind === "job")).toBe(true);
    const jobIdsB = service.panelJobs({ namespace: namespaceB }).items.map((job) => job.id);
    expect(jobIdsB).toEqual(expect.arrayContaining(completeB.jobs.map((job) => job.jobId)));
    expect(jobIdsB).not.toEqual(expect.arrayContaining(completeA.jobs.map((job) => job.jobId)));
    const overviewB = service.panelOverview({ namespace: namespaceB });
    expect(overviewB.stats.jobs.queued).toBe(completeB.jobs.length);
    expect(overviewB.stats.byLayer.L1).toBe(completeB.l1MemoryIds.length);
    expect(overviewB.stats.byStatus.activated).toBe(completeB.l1MemoryIds.length);
    expect(overviewB.stats.episodes.open).toBe(1);

    db.close();
  });
});
