import { afterEach, describe, expect, it } from "vitest";
import { type MemoryRow } from "../../../src/index.js";
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
    expect(service.panelItems({
      layer: "L1",
      excludedSourceAgents: ["memmy-agent", "cursor", "claude_code", "codex", "opencode", "openclaw", "hermes"],
      limit: 1
    })).toMatchObject({
      total: 1,
      items: [{ id: otherMemory.l1MemoryId, metadata: { source: "test_agent" } }]
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
    expect(itemBeforeEmbedding?.tags).toContain("索引建立中");
    expect(itemBeforeEmbedding?.tags).not.toContain("openclaw");
    expect(itemBeforeEmbedding?.metadata?.source).toBe("openclaw");

    const detail = service.getMemory(complete.l1MemoryId, { namespace });
    expect(detail.item.tags).toContain("索引建立中");
    expect(detail.item.tags).not.toContain("openclaw");
    expect(detail.item.metadata.source).toBe("openclaw");
    expect(detail.refs.episode).toMatchObject({
      id: complete.episodeId,
      sessionId: session.sessionId,
      status: "open"
    });

    await service.runWorkerOnce(20);
    expect(embeddingTexts.length).toBeGreaterThan(0);
    const listAfterEmbedding = service.panelItems({ namespace, layer: "L1" });
    expect(listAfterEmbedding.items.find((item) => item.id === complete.l1MemoryId)?.tags).not.toContain("索引建立中");
    expect(listAfterEmbedding.items.find((item) => item.id === complete.l1MemoryId)?.metadata?.source).toBe("openclaw");

    db.close();
  });

  it("shows panel change logs, jobs, and overview across namespaces", () => {
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
    expect(changesA.changes.map((change) => change.id)).toContain(completeB.l1MemoryId);
    expect(changesA.changes.some((change) => change.kind === "job")).toBe(true);
    const jobIdsA = service.panelJobs({ namespace: namespaceA }).items.map((job) => job.id);
    expect(jobIdsA).toEqual(expect.arrayContaining(completeA.jobs.map((job) => job.jobId)));
    expect(jobIdsA).toEqual(expect.arrayContaining(completeB.jobs.map((job) => job.jobId)));
    const overviewA = service.panelOverview({ namespace: namespaceA });
    expect(overviewA.stats.jobs.queued).toBe(completeA.jobs.length + completeB.jobs.length);
    expect(overviewA.stats.byLayer.L1).toBe(completeA.l1MemoryIds.length + completeB.l1MemoryIds.length);
    expect(overviewA.stats.byStatus.activated).toBe(completeA.l1MemoryIds.length + completeB.l1MemoryIds.length);
    expect(overviewA.stats.episodes.open).toBe(2);

    const changesB = service.panelChanges({ namespace: namespaceB });
    expect(changesB.changes.map((change) => change.id)).toContain(completeB.l1MemoryId);
    expect(changesB.changes.map((change) => change.id)).toContain(completeA.l1MemoryId);
    expect(changesB.changes.some((change) => change.kind === "job")).toBe(true);
    const jobIdsB = service.panelJobs({ namespace: namespaceB }).items.map((job) => job.id);
    expect(jobIdsB).toEqual(expect.arrayContaining(completeB.jobs.map((job) => job.jobId)));
    expect(jobIdsB).toEqual(expect.arrayContaining(completeA.jobs.map((job) => job.jobId)));
    const overviewB = service.panelOverview({ namespace: namespaceB });
    expect(overviewB.stats.jobs.queued).toBe(completeA.jobs.length + completeB.jobs.length);
    expect(overviewB.stats.byLayer.L1).toBe(completeA.l1MemoryIds.length + completeB.l1MemoryIds.length);
    expect(overviewB.stats.byStatus.activated).toBe(completeA.l1MemoryIds.length + completeB.l1MemoryIds.length);
    expect(overviewB.stats.episodes.open).toBe(2);

    db.close();
  });
});
