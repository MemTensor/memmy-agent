/** Memos sqlite memory client tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { createMemosSqliteMemoryClient } from "../memos-sqlite-memory-client.js";

const NOW = "2026-06-08T10:00:00.000Z";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("createMemosSqliteMemoryClient", () => {
  it("preserves Span memory kinds in panel responses", async () => {
    const dbPath = createMemoryDatabase({
      id: "span_sqlite_1",
      sessionId: "codex-session-span",
      agentId: "codex",
      tagsJson: JSON.stringify(["span"]),
      infoJson: JSON.stringify({ source: "worker.span_big_turn.v1" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_layer: "L1",
          memory_kind: "span",
          source: "worker.span_big_turn.v1",
          span: { span_goal: "Inspect the local span data" }
        }
      })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.panelItems({ layer: "L1", page: 1 })).resolves.toMatchObject({
      items: [{
        id: "memmy-memory::span_sqlite_1",
        kind: "span",
        metadata: { spanGoal: "Inspect the local span data" }
      }]
    });
  });

  it("lists and deletes User Memory through the sqlite fallback", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_user_memory_seed",
      sessionId: "codex-user-memory",
      agentId: "codex",
      tagsJson: "[]",
      infoJson: "{}",
      propertiesJson: JSON.stringify({ internal_info: { memory_layer: "L1" } })
    });
    insertUserMemory(dbPath, "user_memory_sqlite_1", "我最喜欢的水果是苹果");
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.panelItems({ layer: "UserMemory", q: "苹果", page: 1 })).resolves.toMatchObject({
      total: 1,
      items: [{
        id: "memmy-memory::user_memory_sqlite_1",
        kind: "user_memory",
        memoryLayer: "UserMemory",
        tags: ["User Preference"]
      }]
    });
    await expect(client.deleteMemory({ memoryId: "memmy-memory::user_memory_sqlite_1" })).resolves.toMatchObject({
      kind: "user_memory",
      status: "deleted"
    });
    await expect(client.panelItems({ layer: "UserMemory", page: 1 })).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("exposes only the span's raw-turn tool-call range in detail metadata", async () => {
    const dbPath = createMemoryDatabase({
      id: "span_sqlite_steps",
      sessionId: "codex-session-span",
      agentId: "codex",
      tagsJson: JSON.stringify(["span"]),
      infoJson: JSON.stringify({ raw_turn_id: "raw-span-1" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_layer: "L1",
          memory_kind: "span",
          span: { raw_turn_id: "raw-span-1", tool_call_start: 1, tool_call_end: 2 }
        }
      }),
      rawTurn: {
        id: "raw-span-1",
        toolCalls: [
          { id: "tool-0", name: "read_file" },
          { id: "tool-1", name: "rg" },
          { id: "tool-2", name: "npm_test" },
          { id: "tool-3", name: "git_diff" }
        ]
      }
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const detail = await client.getMemory({ memoryId: "memmy-memory::span_sqlite_steps" });

    expect(detail.item.metadata.spanDetail).toEqual({
      toolCallStart: 1,
      toolCallEnd: 2,
      toolCalls: [
        { id: "tool-1", name: "rg" },
        { id: "tool-2", name: "npm_test" }
      ]
    });
  });

  it("derives Hermes source from the session id when the row agent is the default", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_hermes_1",
      sessionId: "hermes-20260608_165922_f6cf51",
      agentId: "codex",
      tagsJson: JSON.stringify(["trace"]),
      infoJson: "{}",
      propertiesJson: JSON.stringify({ internal_info: { source: "turn.complete", value: 0.42, alpha: 0.8, reflection: "Useful turn." } })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const list = await client.panelItems({ layer: "L1", page: 1 });
    expect(list.items[0]?.tags).toEqual(["hermes", "trace"]);
    expect(list.items[0]?.metadata?.source).toBe("hermes");
    expect(list.items[0]?.metrics).toEqual({ value: 0.42, alpha: 0.8, reflectionDone: true });
    await expect(client.panelItems({ layer: "L1", sourceAgent: "hermes", page: 1 }))
      .resolves.toMatchObject({ total: 1, items: [{ id: expect.stringContaining("trace_hermes_1") }] });
    await expect(client.panelItems({ layer: "L1", sourceAgent: "codex", page: 1 }))
      .resolves.toMatchObject({ total: 0, items: [] });

    const detail = await client.getMemory({ memoryId: "memmy-memory::trace_hermes_1" });
    expect(detail.item.metadata.source).toBe("hermes");
    expect(detail.item.metrics).toEqual({ value: 0.42, alpha: 0.8, reflectionDone: true });
  });

  it("filters custom L1 panel item sources as other", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_other_1",
      sessionId: "test-agent-session",
      agentId: "test_agent",
      tagsJson: JSON.stringify(["trace"]),
      infoJson: "{}",
      propertiesJson: JSON.stringify({ internal_info: { source: "memory.add" } })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.panelItems({
      layer: "L1",
      excludedSourceAgents: ["memmy-agent", "cursor", "claude_code", "codex", "opencode", "openclaw", "hermes"],
      page: 1
    })).resolves.toMatchObject({
      total: 1,
      items: [{ id: expect.stringContaining("trace_other_1"), metadata: { source: "test_agent" } }]
    });
    await expect(client.panelItems({ layer: "L1", sourceAgent: "memmy-agent", page: 1 }))
      .resolves.toMatchObject({ total: 0, items: [] });
  });

  it("parses bracket tool blocks from imported trace agent text", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_codex_1",
      sessionId: "codex-session-1",
      agentId: "codex",
      memoryValue: "Imported Codex trace.",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_layer: "L1",
          memory_kind: "trace",
          source: "codex",
          trace: {
            turn_id: "codex-session-1:1",
            user_text: "检查当前目录",
            agent_text: [
              "我先看一下当前目录。",
              "",
              "[tool]",
              "Tool: exec_command",
              "Call ID: call-shell",
              "Input:",
              "{\"cmd\":\"pwd\"}",
              "",
              "Output:",
              "/tmp/project",
              "",
              "目录确认完成。"
            ].join("\n"),
            raw_span: { user_text: true, agent_text: true, tool_call_count: 0 },
            tool_calls: []
          }
        }
      })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const detail = await client.getMemory({ memoryId: "memmy-memory::trace_codex_1" });
    const traceDetail = detail.item.metadata.traceDetail as {
      userQuery?: string;
      finalResponse?: string;
      toolCalls?: Array<{ id?: string; name?: string; input?: unknown; output?: unknown }>;
    };

    expect(traceDetail.userQuery).toBe("检查当前目录");
    expect(traceDetail.finalResponse).toBe("我先看一下当前目录。\n\n目录确认完成。");
    expect(traceDetail.toolCalls).toEqual([
      {
        id: "call-shell",
        name: "exec_command",
        input: { cmd: "pwd" },
        output: "/tmp/project"
      }
    ]);
  });

  it("preserves multiline bracket tool payloads through CRLF and the block end", async () => {
    const prettyInput = JSON.stringify({
      search_query: [
        { q: "memory parser regression" },
        { q: "tool payload boundaries" }
      ],
      response_length: "long"
    }, null, 2);
    const prettyOutput = JSON.stringify([
      { title: "first result", score: 0.9 },
      { title: "second result", score: 0.8 }
    ], null, 2);
    const dbPath = createMemoryDatabase({
      id: "trace_codex_multiline",
      sessionId: "codex-session-multiline",
      agentId: "codex",
      memoryValue: "Imported Codex multiline trace.",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_layer: "L1",
          memory_kind: "trace",
          source: "codex",
          trace: {
            turn_id: "codex-session-multiline:1",
            user_text: "检查多行工具载荷",
            agent_text: [
              "我会检查工具载荷。",
              "",
              "[tool]",
              "Tool: web_search",
              "Call ID: call-search",
              "Input:",
              prettyInput,
              "",
              "Output:",
              prettyOutput,
              "",
              "[tool]",
              "Tool: exec_command",
              "Call ID: call-exec",
              "Input:",
              "printf 'first line\\nsecond line'",
              "",
              "Output:",
              "first line",
              "second line"
            ].join("\r\n"),
            raw_span: { user_text: true, agent_text: true, tool_call_count: 0 },
            tool_calls: []
          }
        }
      })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const detail = await client.getMemory({ memoryId: "memmy-memory::trace_codex_multiline" });
    const traceDetail = detail.item.metadata.traceDetail as {
      finalResponse?: string;
      toolCalls?: Array<{ id?: string; name?: string; input?: unknown; output?: unknown }>;
    };

    expect(traceDetail.finalResponse).toBe("我会检查工具载荷。");
    expect(traceDetail.toolCalls).toEqual([
      {
        id: "call-search",
        name: "web_search",
        input: JSON.parse(prettyInput),
        output: JSON.parse(prettyOutput)
      },
      {
        id: "call-exec",
        name: "exec_command",
        input: "printf 'first line\\nsecond line'",
        output: "first line\nsecond line"
      }
    ]);
  });

  it("exposes generated skill status from linked episodes", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_skill_1",
      sessionId: "codex-session-skill",
      agentId: "codex",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex", episode_id: "episode-skill-1" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_layer: "L1",
          memory_kind: "trace",
          source: "codex",
          trace: {
            episode_id: "episode-skill-1",
            turn_id: "turn-skill-1",
            user_text: "沉淀一个技能",
            agent_text: "已沉淀。",
            tool_calls: []
          }
        }
      }),
      episode: {
        id: "episode-skill-1",
        sessionId: "codex-session-skill",
        skillMemoryIds: ["skill_sqlite_1"]
      }
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const detail = await client.getMemory({ memoryId: "memmy-memory::trace_skill_1" });
    const traceDetail = detail.item.metadata.traceDetail as {
      episode?: {
        skillStatus?: string;
        skillReason?: string;
        skillMemoryIds?: string[];
        linkedSkillId?: string;
      };
    };

    expect(traceDetail.episode).toMatchObject({
      skillStatus: "succeeded",
      skillReason: "已从该任务沉淀出可复用技能。",
      skillMemoryIds: ["skill_sqlite_1"],
      linkedSkillId: "skill_sqlite_1"
    });
  });

  it("matches panel item searches by memory id", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_sqlite_panel_id",
      sessionId: "codex-session-search-id",
      agentId: "codex",
      memoryValue: "Plain SQLite memory body.",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex" }),
      propertiesJson: JSON.stringify({ internal_info: { memory_layer: "L1", memory_kind: "trace", source: "codex" } })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    const list = await client.panelItems({ layer: "L1", q: "trace_sqlite_panel_id", page: 1 });

    expect(list.items.map((item) => item.id)).toEqual(["memmy-memory::trace_sqlite_panel_id"]);
    expect(list.items[0]?.metadata?.source).toBe("codex");
  });

  it("filters memory_add and memory_search logs by exact and other source Agent", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_log_filter",
      sessionId: "codex-session-log-filter",
      agentId: "codex",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex" }),
      propertiesJson: JSON.stringify({ internal_info: { source: "codex", memory_kind: "trace" } })
    });
    seedApiLogs(dbPath);
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.memoryApiLogs({
      tools: ["memory_add", "memory_search"],
      sourceAgent: "openclaw",
      limit: 20,
      offset: 0
    })).resolves.toMatchObject({
      total: 2,
      logs: [
        { toolName: "memory_add", sourceAgent: "openclaw", outputJson: expect.stringContaining("OpenClaw") },
        { toolName: "memory_search", sourceAgent: "openclaw", inputJson: expect.stringContaining("session_openclaw") }
      ]
    });
    const otherLogs = await client.memoryApiLogs({
      tools: ["memory_add", "memory_search"],
      excludedSourceAgents: ["memmy-agent", "cursor", "claude_code", "codex", "opencode", "openclaw", "hermes"],
      limit: 20,
      offset: 0
    });
    expect(otherLogs).toMatchObject({
      total: 4,
      logs: [
        { toolName: "memory_add", sourceAgent: "test_agent", outputJson: expect.stringContaining("custom Agent") },
        { toolName: "memory_add", outputJson: expect.stringContaining("CLI") },
        { toolName: "memory_search", sourceAgent: "test_agent", inputJson: expect.stringContaining("session_test_agent") },
        { toolName: "memory_search" }
      ]
    });
    expect(otherLogs.logs.map((log) => log.sourceAgent)).toEqual(["test_agent", undefined, "test_agent", undefined]);

    await expect(client.memoryApiLogs({
      tools: ["memory_search"],
      sourceAgent: "openclaw",
      limit: 20,
      offset: 0
    })).resolves.toMatchObject({ total: 1, logs: [{ toolName: "memory_search" }] });
  });

  it("uses the current span goal when reading memory_add logs", async () => {
    const dbPath = createMemoryDatabase({
      id: "span_log_goal",
      sessionId: "codex-session-log-summary",
      agentId: "codex",
      memoryValue: "Goal: Current goal from the span",
      tagsJson: JSON.stringify(["span"]),
      infoJson: JSON.stringify({ span_goal: "Current goal from the span" }),
      propertiesJson: JSON.stringify({
        internal_info: {
          memory_kind: "span",
          span: { span_goal: "Current goal from the span" }
        }
      })
    });
    seedApiLogs(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(`
      INSERT INTO api_logs (tool_name, source_agent, input_json, output_json, duration_ms, success, called_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "memory_add",
      "codex",
      "{}",
      JSON.stringify({ details: [{ role: "span", traceId: "span_log_goal" }] }),
      1,
      1,
      "2026-06-08T09:04:00.000Z"
    );
    db.close();

    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.memoryApiLogs({
      tools: ["memory_add"], sourceAgent: "codex", limit: 20, offset: 0
    })).resolves.toMatchObject({
      logs: [{ outputJson: expect.stringContaining("Current goal from the span") }]
    });
  });

  it("deletes local SQLite memories so list, search, and detail cannot read them", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_delete_1",
      sessionId: "codex-session-delete",
      agentId: "codex",
      memoryValue: "Delete this exact SQLite memory.",
      tagsJson: JSON.stringify(["trace", "codex", "delete-me"]),
      infoJson: JSON.stringify({ source: "codex" }),
      propertiesJson: JSON.stringify({ internal_info: { source: "codex", memory_kind: "trace" } })
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.deleteMemory({ memoryId: "memmy-memory::trace_delete_1" })).resolves.toMatchObject({
      ok: true,
      id: "memmy-memory::trace_delete_1",
      kind: "trace",
      status: "deleted"
    });
    await expect(client.panelItems({ layer: "L1", page: 1 })).resolves.toMatchObject({ items: [] });
    await expect(client.search({ query: "Delete this exact SQLite memory.", verbose: true })).resolves.toMatchObject({
      debug: { hits: [] }
    });
    await expect(client.getMemory({ memoryId: "memmy-memory::trace_delete_1" })).rejects.toMatchObject({
      code: "not_found",
      status: 404
    });

    expect(readMemoryRowCount(dbPath, "trace_delete_1")).toBe(0);
    expect(readVectorRowCount(dbPath)).toBe(0);
  });

  it("lists and atomically deletes tasks independently from memory pagination", async () => {
    const dbPath = createMemoryDatabase({
      id: "trace_task_1",
      sessionId: "codex-session-task",
      agentId: "codex",
      memoryValue: "Task-owned memory.",
      tagsJson: JSON.stringify(["trace", "codex"]),
      infoJson: JSON.stringify({ source: "codex", episode_id: "episode-task-1" }),
      propertiesJson: JSON.stringify({ internal_info: { source: "codex", memory_kind: "trace" } }),
      episode: { id: "episode-task-1", sessionId: "codex-session-task", skillMemoryIds: [] }
    });
    const client = createMemosSqliteMemoryClient({
      sources: [{ id: "memmy-memory", label: "memmy", dbPath }],
      now: () => NOW
    });

    await expect(client.panelTasks({ q: "episode-task-1", page: 99 })).resolves.toMatchObject({
      tasks: [{ id: "memmy-memory::episode-task-1", memoryIds: ["memmy-memory::trace_task_1"] }],
      page: 1,
      total: 1,
      totalPages: 1
    });
    await expect(client.deletePanelTask("memmy-memory::episode-task-1")).resolves.toMatchObject({
      ok: true,
      id: "memmy-memory::episode-task-1",
      deletedMemoryIds: ["memmy-memory::trace_task_1"]
    });
    await expect(client.panelTasks({ page: 1 })).resolves.toMatchObject({ tasks: [], total: 0, page: 1 });
    expect(readMemoryRowCount(dbPath, "trace_task_1")).toBe(0);
  });
});

function createMemoryDatabase(row: {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  memoryValue?: string;
  tagsJson: string;
  infoJson: string;
  propertiesJson: string;
  episode?: {
    id: string;
    sessionId: string;
    skillMemoryIds: string[];
  };
  rawTurn?: {
    id: string;
    toolCalls: Array<Record<string, unknown>>;
  };
}): string {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-sqlite-client-"));
  const dbPath = join(tempDir, "memory.sqlite");
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(getSqliteVecLoadablePath());
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      timeline TEXT NOT NULL,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      app_id TEXT,
      memory_type TEXT NOT NULL,
      status TEXT NOT NULL,
      visibility TEXT NOT NULL,
      memory_key TEXT,
      memory_value TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      info_json TEXT NOT NULL,
      properties_json TEXT NOT NULL,
      memory_layer TEXT NOT NULL,
      content_hash TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  db.prepare(`
    INSERT INTO memories (
      id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
      memory_type, status, visibility, memory_key, memory_value,
      tags_json, info_json, properties_json, memory_layer, content_hash,
      version, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    "default",
    "local-user",
    null,
    row.sessionId,
    row.agentId,
    null,
    "LongTermMemory",
    "activated",
    "private",
    row.id,
    row.memoryValue ?? "Hermes wrote this turn.",
    row.tagsJson,
    row.infoJson,
    row.propertiesJson,
    "L1",
    null,
    1,
    NOW,
    NOW,
    null
  );
  db.exec(`
    CREATE TABLE memory_vector_entries (
      id INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      vector_field TEXT NOT NULL,
      embedding_model TEXT,
      embedding_provider TEXT,
      embedding_dim INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (memory_id, vector_field)
    );
    CREATE VIRTUAL TABLE memory_vec_3 USING vec0(embedding float[3] distance_metric=cosine);
  `);
  db.prepare(`
    INSERT INTO memory_vector_entries (
      id, memory_id, vector_field, embedding_model, embedding_provider, embedding_dim, updated_at
    ) VALUES (1, ?, 'vec_summary', 'test', 'openai_compatible', 3, ?)
  `).run(row.id, NOW);
  db.prepare(`INSERT INTO memory_vec_3 (rowid, embedding) VALUES (?, ?)`)
    .run(1n, Buffer.from(new Float32Array([1, 0, 0]).buffer));
  if (row.rawTurn) {
    db.exec(`
      CREATE TABLE raw_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        episode_id TEXT,
        turn_id TEXT,
        user_id TEXT,
        conversation_id TEXT,
        user_text TEXT,
        assistant_text TEXT,
        reasoning_summary TEXT,
        tool_calls_json TEXT,
        tool_results_json TEXT,
        source_memory_ids_json TEXT,
        usage_json TEXT,
        message_payload_json TEXT,
        status TEXT,
        redacted_at TEXT,
        deleted_at TEXT,
        created_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO raw_turns (
        id, session_id, episode_id, turn_id, user_id, conversation_id, user_text,
        assistant_text, reasoning_summary, tool_calls_json, tool_results_json,
        source_memory_ids_json, usage_json, message_payload_json, status,
        redacted_at, deleted_at, created_at
      ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, '[]', '[]', '{}', '{}', 'succeeded', NULL, NULL, ?)
    `).run(row.rawTurn.id, row.sessionId, row.rawTurn.id, "local-user", JSON.stringify(row.rawTurn.toolCalls), NOW);
  }
  if (row.episode) {
    db.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        l1_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        raw_turn_ids_json TEXT,
        skill_memory_ids_json TEXT,
        turn_count INTEGER,
        r_task REAL,
        reward_detail_json TEXT,
        pipeline_status TEXT,
        pipeline_error TEXT,
        meta_json TEXT,
        opened_at TEXT,
        closed_at TEXT,
        updated_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO episodes (
        id, session_id, status, title, summary, l1_memory_ids_json, raw_turn_ids_json,
        skill_memory_ids_json, turn_count, r_task, reward_detail_json,
        pipeline_status, pipeline_error, meta_json, opened_at, closed_at, updated_at
      ) VALUES (?, ?, 'closed', NULL, NULL, ?, '[]', ?, 1, 0.8, '{}', 'idle', NULL, '{}', ?, ?, ?)
    `).run(
      row.episode.id,
      row.episode.sessionId,
      JSON.stringify([row.id]),
      JSON.stringify(row.episode.skillMemoryIds),
      NOW,
      NOW,
      NOW
    );
  }
  db.close();
  return dbPath;
}

function readMemoryRowCount(dbPath: string, memoryId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("select count(*) as count from memories where id = ?").get(memoryId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function insertUserMemory(dbPath: string, id: string, content: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE user_memories (
        id TEXT PRIMARY KEY,
        source_turn_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        memory_types_json TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_user_text_hash TEXT NOT NULL,
        source_turn_refs_json TEXT NOT NULL,
        status TEXT NOT NULL,
        replaces_memory_id TEXT,
        replaced_by_memory_id TEXT,
        archived_at TEXT,
        archive_reason TEXT,
        embedding_json TEXT,
        embedding_model TEXT,
        embedding_provider TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO user_memories (
        id, source_turn_id, user_id, memory_types_json, content,
        normalized_user_text_hash, source_turn_refs_json, status,
        created_at, updated_at
      ) VALUES (?, 'turn-user-memory', 'local-user', '["User Preference"]', ?, 'hash', '["turn-user-memory"]', 'active', ?, ?)
    `).run(id, content, NOW, NOW);
  } finally {
    db.close();
  }
}

function seedApiLogs(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        source_agent TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        called_at TEXT NOT NULL
      )
    `);
    const insert = db.prepare(`
      INSERT INTO api_logs (
        tool_name, source_agent, input_json, output_json, duration_ms, success, called_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?)
    `);
    insert.run("memory_add", "openclaw", "{}", JSON.stringify({
      details: [{ sourceAgent: "openclaw", summary: "Stored by OpenClaw" }]
    }), "2026-06-08T09:03:00.000Z");
    insert.run("memory_add", "test_agent", "{}", JSON.stringify({
      details: [{ sourceAgent: "test_agent", summary: "Stored by custom Agent" }]
    }), "2026-06-08T09:02:30.000Z");
    insert.run("memory_add", null, "{}", JSON.stringify({
      details: [{ summary: "Stored directly through CLI" }]
    }), "2026-06-08T09:02:00.000Z");
    insert.run("memory_search", "openclaw", JSON.stringify({ sessionId: "session_openclaw" }), JSON.stringify({ candidates: [] }), "2026-06-08T09:01:00.000Z");
    insert.run("memory_search", "test_agent", JSON.stringify({ sessionId: "session_test_agent" }), JSON.stringify({ candidates: [] }), "2026-06-08T09:00:30.000Z");
    insert.run("memory_search", null, "{}", JSON.stringify({ candidates: [] }), "2026-06-08T09:00:00.000Z");
  } finally {
    db.close();
  }
}

function readVectorRowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: true });
  try {
    db.loadExtension(getSqliteVecLoadablePath());
    const row = db.prepare("select count(*) as count from memory_vec_3").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}
