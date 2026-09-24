import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemoryRow } from "../../../src/index.js";
import { PanelItemsOutputSchema } from "../../../src/contracts/memory-runtime.js";
import { detailFromMemory } from "../../../src/service/read-model/memory.js";
import { updateTraceSummary } from "../../../src/service/embedding/embedding-job-processor.js";
import {
  changeLogToPanelChange,
  workspaceUriDisplay
} from "../../../src/service/read-model/panel-read.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  addAgentSourceImport,
  createCapturingEmbedder,
  createBatchReflectionLlm,
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
    expect(summarizedItem?.generatedTitle).toBeUndefined();

    db.close();
  });

  it("returns waiting source text and generated titles through the panel schema", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "user-panel-display-fields"
    };
    const session = service.openSession({ namespace });
    const completed = service.completeTurn("turn-panel-display-fields", {
      sessionId: session.sessionId,
      query: "请修复自动扫描卡顿并运行测试",
      answer: "已完成修复并运行测试。"
    });
    const at = new Date().toISOString();
    const source = repos.memories.get(completed.l1MemoryId)!;
    const longSummary = "已修复自动扫描卡顿，并验证标题与摘要显示。".repeat(6);
    repos.memories.update(updateTraceSummary(source, { summary: longSummary, updatedAt: at }));
    const readable = repos.memories.insert({
      ...source,
      id: "trace_panel_readable_fallback",
      memoryKey: "trace:panel-display-fields:readable",
      contentHash: "panel-display-readable",
      memoryValue: `Summary: 导入后的可读正文\nRawTurn: raw_panel_readable`,
      info: { summary: "导入后的可读正文" },
      properties: {
        ...source.properties,
        info: { summary: "导入后的可读正文" },
        internal_info: {
          ...source.properties.internal_info,
          summary: "导入后的可读正文",
          title: undefined,
          trace: {
            ...(typeof source.properties.internal_info.trace === "object" && source.properties.internal_info.trace
              ? source.properties.internal_info.trace as Record<string, unknown>
              : {}),
            userText: "",
            user_text: "",
            summary: "导入后的可读正文",
            title: undefined
          }
        }
      }
    });
    repos.memories.insert({
      ...source,
      id: "policy_panel_draft",
      memoryKey: "policy:panel-display-fields",
      memoryLayer: "L2",
      contentHash: "panel-display-policy",
      memoryValue: "Policy: pytest retry\nTrigger: pytest workflow fails",
      info: { title: "Policy: pytest retry" },
      properties: {
        memory_type: "LongTermMemory",
        status: "activated",
        tags: [],
        info: { title: "Policy: pytest retry" },
        internal_info: {
          memory_layer: "L2",
          memory_kind: "policy",
          schema_version: 1,
          title: "Policy: pytest retry",
          source_memory_ids: [completed.l1MemoryId],
          policy: {
            title: "Policy: pytest retry",
            source_trace_ids: [completed.l1MemoryId]
          }
        }
      }
    });
    void readable;

    const parsed = PanelItemsOutputSchema.parse(service.panelItems({ namespace, layer: "L1" }));
    const legacy = parsed.items.find((item) => item.id === completed.l1MemoryId);
    const fallback = parsed.items.find((item) => item.id === "trace_panel_readable_fallback");
    expect(legacy?.sourceText).toBe("请修复自动扫描卡顿并运行测试");
    expect(legacy?.generatedTitle).toBeUndefined();
    expect(legacy?.title.length).toBeLessThanOrEqual(80);
    expect(legacy?.summary).toBe(longSummary);
    expect(legacy?.title).not.toBe(legacy?.summary);
    expect(fallback?.sourceText).toBe("导入后的可读正文");
    expect(fallback?.generatedTitle).toBeUndefined();

    const experiences = PanelItemsOutputSchema.parse(service.panelItems({ namespace, layer: "L2" }));
    const draft = experiences.items.find((item) => item.id === "policy_panel_draft");
    expect(draft?.title).toBe("Trigger: pytest workflow fails");
    expect(draft?.generatedTitle).toBeUndefined();
    expect(draft?.experienceDraft).toBe(true);
    expect(draft?.sourceText).toBe("请修复自动扫描卡顿并运行测试");

    repos.memories.update(updateTraceSummary(repos.memories.get(completed.l1MemoryId)!, {
      summary: longSummary,
      title: "扫描卡顿修复",
      updatedAt: at
    }));
    const generated = PanelItemsOutputSchema.parse(service.panelItems({ namespace, layer: "L1" }))
      .items.find((item) => item.id === completed.l1MemoryId);
    expect(generated?.generatedTitle).toBe("扫描卡顿修复");
    const detail = detailFromMemory(repos.memories.get(completed.l1MemoryId)!);
    expect(detail.generatedTitle).toBe("扫描卡顿修复");
    expect(detailFromMemory(repos.memories.get("trace_panel_readable_fallback")!).generatedTitle).toBeUndefined();
    db.close();
  });

  it("does not treat an imported user-sentence title as a generated title", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const imported = addAgentSourceImport(
      service,
      { source: "codex", profileId: "import-title", userId: "user-import-title" },
      "帮我修复 pytest 失败并检查 migration",
      "import-title-provenance"
    );
    const at = new Date().toISOString();
    const summary = "已修复 sqlite migration 导致的 pytest 失败，并通过回归验证。";
    const current = repos.memories.get(imported.id)!;
    expect(current.info.title).toBe("帮我修复 pytest 失败并检查 migration");
    repos.memories.update(updateTraceSummary(current, { summary, updatedAt: at }));

    const listed = PanelItemsOutputSchema.parse(service.panelItems({
      userId: "user-import-title",
      layer: "L1"
    })).items.find((item) => item.id === imported.id);
    expect(listed?.generatedTitle).toBeUndefined();
    expect(listed?.summary).toBe(summary);
    expect(detailFromMemory(repos.memories.get(imported.id)!).generatedTitle).toBeUndefined();

    repos.memories.update(updateTraceSummary(repos.memories.get(imported.id)!, {
      summary,
      title: "pytest 迁移修复",
      updatedAt: at
    }));
    const generated = PanelItemsOutputSchema.parse(service.panelItems({
      userId: "user-import-title",
      layer: "L1"
    })).items.find((item) => item.id === imported.id);
    expect(generated?.generatedTitle).toBe("pytest 迁移修复");
    expect(detailFromMemory(repos.memories.get(imported.id)!).generatedTitle).toBe("pytest 迁移修复");
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

  it("adds typed general and project scope to L3 panel items with one batched lookup", () => {
    const { db, service } = createTestService();
    const repos = (service as unknown as { repos: Repositories }).repos;
    const general = repos.l3WorldModels.upsertField({
      userId: "world-panel-scope-user",
      targetField: "general_rules_and_safety_constraints",
      value: "Do not delete files without confirmation."
    })!;
    repos.l3WorldModels.bindWorkspaceUri(
      "world-panel-scope-user",
      "project-panel-scope",
      "file:///Users/test/Code/My%20Project"
    );
    const project = repos.l3WorldModels.upsertField({
      userId: "world-panel-scope-user",
      projectId: "project-panel-scope",
      targetField: "project_environment_profile",
      value: "TypeScript project."
    })!;
    const unboundProject = repos.l3WorldModels.upsertField({
      userId: "world-panel-scope-user",
      projectId: "project-panel-unbound",
      targetField: "project_environment_profile",
      value: "Legacy project without a workspace binding."
    })!;
    const scopeLookup = vi.spyOn(repos.l3WorldModels, "getScopesByMemoryIds");

    const panel = service.panelItems({ layer: "L3", limit: 20 });

    expect(scopeLookup).toHaveBeenCalledTimes(1);
    expect(scopeLookup).toHaveBeenCalledWith(expect.arrayContaining([general.id, project.id, unboundProject.id]));
    expect(panel.items.find((item) => item.id === general.id)?.worldModelScope).toEqual({ kind: "general" });
    expect(panel.items.find((item) => item.id === project.id)?.worldModelScope).toEqual({
      kind: "project",
      projectLabel: "My Project",
      workspaceDisplayPath: "/Users/test/Code/My Project"
    });
    expect(panel.items.find((item) => item.id === unboundProject.id)?.worldModelScope).toEqual({
      kind: "project",
      projectLabel: null,
      workspaceDisplayPath: null
    });
    expect(service.getMemory(project.id).item).not.toHaveProperty("worldModelScope");

    db.close();
  });

  it("does not expose a workspace path when scope ownership is corrupted", () => {
    const { db, service } = createTestService();
    const repos = (service as unknown as { repos: Repositories }).repos;
    repos.l3WorldModels.bindWorkspaceUri("scope-owner", "scope-project", "file:///safe/project");
    const project = repos.l3WorldModels.upsertField({
      userId: "scope-owner",
      projectId: "scope-project",
      targetField: "project_environment_profile",
      value: "Project profile."
    })!;
    db.db.prepare(`UPDATE memories SET user_id = 'different-owner' WHERE id = ?`).run(project.id);

    expect(service.panelItems({ layer: "L3" }).items.find((item) => item.id === project.id))
      .not.toHaveProperty("worldModelScope");

    db.close();
  });

  it("derives display labels and paths without depending on the host operating system", () => {
    expect(workspaceUriDisplay("file:///C:/Users/Alice/My%20Project/")).toEqual({
      projectLabel: "My Project",
      workspaceDisplayPath: "C:/Users/Alice/My Project/"
    });
    expect(workspaceUriDisplay("file://server/share/My%20Project")).toEqual({
      projectLabel: "My Project",
      workspaceDisplayPath: "//server/share/My Project"
    });
    expect(workspaceUriDisplay("vscode-remote://ssh-remote+host/workspaces/demo")).toEqual({
      projectLabel: "demo",
      workspaceDisplayPath: "vscode-remote://ssh-remote+host/workspaces/demo"
    });
    expect(workspaceUriDisplay("file:///workspace/name%2Fwith-slash")).toEqual({
      projectLabel: "name/with-slash",
      workspaceDisplayPath: "/workspace/name/with-slash"
    });
    expect(workspaceUriDisplay("file:///bad/%E0%A4%A")).toEqual({
      projectLabel: null,
      workspaceDisplayPath: null
    });
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

  it("builds overview statistics without reading memory payloads or vectors", () => {
    const { db, service } = createTestService();
    service.addMemory({
      content: "Overview should use a narrow aggregate projection.",
      layer: "L1",
      source: "codex"
    });
    const prepare = vi.spyOn(db.db, "prepare");

    const summary = service.panelOverviewSummary();

    expect(summary.counts.memories).toBe(1);
    const sql = prepare.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).not.toContain("SELECT *\n         FROM memories");
    expect(sql).not.toContain("FROM memory_vector_entries");
    expect(sql).not.toContain("FROM memory_vec_");
    db.close();
  });

  it("exposes OpenClaw as the panel source for OpenClaw trace memories", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      llm: createBatchReflectionLlm([], "remember openclaw panel source"),
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
    expect(itemBeforeEmbedding?.tags).not.toContain("openclaw");
    expect(itemBeforeEmbedding?.metadata?.source).toBe("openclaw");

    const detail = service.getMemory(complete.l1MemoryId, { namespace });
    expect(detail.item.tags).toContain("摘要总结中");
    expect(detail.item.tags).not.toContain("openclaw");
    expect(detail.item.metadata.source).toBe("openclaw");
    expect(detail.refs.episode).toMatchObject({
      id: complete.episodeId,
      sessionId: session.sessionId,
      status: "open"
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
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
