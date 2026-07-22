import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb
} from "../../../src/index.js";
import { captureTurnSteps } from "../../../src/algorithm/plugin-algorithms.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / session / turn capture", () => {
  it("uses plugin capture normalizer limits from service config", () => {
    const root = createTestRoot("mindock-memory-capture-normalizer-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            maxTextChars: 220,
            maxToolOutputChars: 220,
            synthReflection: false,
            embedAfterCapture: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "capture-normalizer-user"
      }
    });
    const longUser = `start-${"u".repeat(300)}-tail`;
    const longOutput = `out-start-${"o".repeat(300)} SENTINEL_ERROR_CODE ${"p".repeat(300)}-out-tail`;
    const expectedTrace = captureTurnSteps({
      episodeId: "expected-episode",
      sessionId: "expected-session",
      turnId: "turn-capture-normalizer",
      userText: longUser,
      assistantText: "short assistant response",
      toolCalls: [{
        name: "shell",
        input: "npm run long-output",
        output: longOutput,
        success: true
      }],
      createdAtIso: "2026-01-01T00:00:00.000Z",
      maxTextChars: 220,
      maxToolOutputChars: 220
    })[0]!;
    const defaultTrace = captureTurnSteps({
      episodeId: "expected-episode",
      sessionId: "expected-session",
      turnId: "turn-capture-normalizer",
      userText: longUser,
      assistantText: "short assistant response",
      toolCalls: [{
        name: "shell",
        input: "npm run long-output",
        output: longOutput,
        success: true
      }],
      createdAtIso: "2026-01-01T00:00:00.000Z"
    })[0]!;
    const complete = service.completeTurn("turn-capture-normalizer", {
      sessionId: session.sessionId,
      query: longUser,
      answer: "short assistant response",
      toolCalls: [{
        name: "shell",
        input: "npm run long-output",
        output: longOutput,
        success: true
      }]
    });

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryIds[0]) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        summary: string;
        trace: {
          tool_calls: Array<{ output?: string }>;
          error_signatures: string[];
          vec_action: number[];
        };
      };
    };
    expect(properties.internal_info.summary).toBe(expectedTrace.summary);
    expect(properties.internal_info.summary).toContain("start-");
    expect(properties.internal_info.summary).toContain("…[truncated]…");
    expect(properties.internal_info.trace.tool_calls[0]?.output).toBeUndefined();
    expect(defaultTrace.errorSignatures).toContain("SENTINEL_ERROR_CODE");
    expect(expectedTrace.errorSignatures).not.toContain("SENTINEL_ERROR_CODE");
    expect(properties.internal_info.trace.error_signatures).toEqual(expectedTrace.errorSignatures);
    expect(expectedTrace.vecAction).toEqual(defaultTrace.vecAction);
    expect(properties.internal_info.trace.vec_action).toBeUndefined();
    db.close();
  });

  it("stores complete turn tool calls and records memory_add logs for captured traces", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "memmy-agent",
        profileId: "default",
        userId: "tool-complete-user"
      }
    });
    await service.startTurn({
      sessionId: session.sessionId,
      turnId: "turn-complete-tools",
      query: "Run pwd in the terminal."
    });

    const complete = service.completeTurn("turn-complete-tools", {
      sessionId: session.sessionId,
      query: "Run pwd in the terminal.",
      answer: "The command completed.",
      toolCalls: [
        {
          id: "call-bash",
          type: "function",
          function: {
            name: "terminal_bash",
            arguments: JSON.stringify({ cmd: "pwd" })
          }
        },
        {
          id: "call-node",
          type: "function",
          function: {
            name: "terminal_bash",
            arguments: JSON.stringify({ cmd: "node -v" })
          }
        }
      ],
      toolResults: [
        {
          toolCallId: "call-bash",
          output: "/Users/jiang/MyProject/mindock-agent"
        },
        {
          toolCallId: "call-node",
          output: "v22.0.0"
        }
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5
      },
      tags: ["trace", "turn", "memmy", "openclaw"]
    });

    const rawTurn = db.db.prepare(
      `SELECT tool_calls_json, tool_results_json, usage_json
       FROM raw_turns
       WHERE id = ?`
    ).get(complete.rawTurnId) as {
      tool_calls_json: string;
      tool_results_json: string;
      usage_json: string;
    };
    const toolCalls = JSON.parse(rawTurn.tool_calls_json) as Array<{ id: string; name: string; input: string; output: string }>;
    expect(toolCalls).toEqual([
      expect.objectContaining({
        id: "call-bash",
        name: "terminal_bash",
        input: JSON.stringify({ cmd: "pwd" }),
        output: "/Users/jiang/MyProject/mindock-agent"
      }),
      expect.objectContaining({
        id: "call-node",
        name: "terminal_bash",
        input: JSON.stringify({ cmd: "node -v" }),
        output: "v22.0.0"
      })
    ]);
    expect(JSON.parse(rawTurn.tool_results_json)).toEqual([
      expect.objectContaining({
        toolCallId: "call-bash",
        output: "/Users/jiang/MyProject/mindock-agent"
      }),
      expect.objectContaining({
        toolCallId: "call-node",
        output: "v22.0.0"
      })
    ]);
    expect(JSON.parse(rawTurn.usage_json)).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(complete.l1MemoryIds).toEqual([complete.l1MemoryId]);

    const detail = service.getMemory(complete.l1MemoryId);
    const rawTurnRef = detail.refs?.rawTurn as { toolCalls?: unknown[] } | undefined;
    expect(rawTurnRef?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-bash",
        name: "terminal_bash"
      }),
      expect.objectContaining({
        id: "call-node",
        name: "terminal_bash"
      })
    ]);
    expect(detail.item.body).toContain("User:\nRun pwd in the terminal.");
    expect(detail.item.body).toContain("Tool calls:\n- terminal_bash");
    expect(detail.item.body).toContain("Agent:\nThe command completed.");
    expect(detail.item.tags).toEqual(expect.arrayContaining(["shell", "terminal"]));
    expect(detail.item.tags).not.toContain("trace");
    expect(detail.item.tags).not.toContain("turn");
    expect(detail.item.tags).not.toContain("memmy");
    expect(detail.item.tags).not.toContain("openclaw");
    const detailProperties = detail.item.metadata.properties as {
      internal_info: {
        trace: {
          raw_span?: { user_text?: boolean; agent_text?: boolean; tool_call_count?: number };
          tool_calls?: Array<{ id?: string; name?: string }>;
          step_index?: number;
          sub_step_total?: number;
          userText?: string;
          agentText?: string;
        };
      };
    };
    const traceMeta = detailProperties.internal_info.trace;
    expect(traceMeta.raw_span).toEqual({
      user_text: true,
      agent_text: true,
      tool_call_count: 2
    });
    expect(traceMeta.userText).toBe("Run pwd in the terminal.");
    expect(traceMeta.agentText).toBe("The command completed.");
    expect(traceMeta.tool_calls?.map((call) => call.id)).toEqual(["call-bash", "call-node"]);
    expect(traceMeta.step_index).toBe(0);
    expect(traceMeta.sub_step_total).toBe(1);
    const episodeDetail = service.getMemory(complete.episodeId);
    expect(episodeDetail.kind).toBe("episode");
    if (episodeDetail.kind !== "episode") {
      throw new Error("expected episode detail");
    }
    expect(episodeDetail.id).toBe(complete.episodeId);
    expect(episodeDetail.timeline.rawTurns?.map((turn) => turn.rawTurnId)).toContain(complete.rawTurnId);
    expect(episodeDetail.timeline.items.map((item) => item.id)).toContain(complete.l1MemoryId);

    const logs = service.apiLogs({ tools: ["memory_add"], limit: 10 });
    expect(logs.logs).toHaveLength(1);
    const memoryAddOutput = JSON.parse(logs.logs[0]!.outputJson) as {
      stored: number;
      details: Array<{
        role: string;
        action: string;
        sourceAgent?: string;
        traceId: string;
        episodeId?: string;
        query?: string;
        agent?: string;
        summary?: string;
      }>;
    };
    expect(memoryAddOutput.stored).toBe(1);
    expect(memoryAddOutput.details).toEqual([
      expect.objectContaining({
        role: "trace",
        action: "stored",
        sourceAgent: "memmy-agent",
        traceId: complete.l1MemoryId,
        episodeId: complete.episodeId,
        query: "Run pwd in the terminal.",
        agent: "The command completed."
      })
    ]);
    expect(memoryAddOutput.details[0]?.summary).toContain("Run pwd in the terminal");

    db.close();
  });

  it("uses unknown as the default source instead of attributing anonymous CLI calls to Codex", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({});
    const added = service.addMemory({
      content: "Remember the anonymous CLI source."
    });
    await service.search({
      query: "anonymous CLI source",
      layers: ["L1"]
    });

    expect(session.source).toBe("unknown");
    expect(db.db.prepare(
      `SELECT agent_id FROM memories WHERE id = ?`
    ).get(added.id)).toEqual({ agent_id: "unknown" });
    expect(db.db.prepare(
      `SELECT tool_name, source_agent FROM api_logs ORDER BY called_at DESC, id DESC`
    ).all()).toEqual([
      { tool_name: "memory_search", source_agent: "unknown" },
      { tool_name: "memory_add", source_agent: "unknown" }
    ]);
    db.close();
  });

  it("sanitizes memmy protocol tags before storing manual memories", () => {
    const { db, service } = createTestService();

    const added = service.addMemory({
      namespace: {
        source: "codex",
        profileId: "default",
        userId: "memory-add-sanitize-user"
      },
      content: [
        '<memmy_memory_context source="tool_search">',
        "Historical User: answer this old question",
        "</memmy_memory_context>",
        "",
        "<current_user_request>",
        "The user prefers dev-jiang for this project.",
        "</current_user_request>",
      ].join("\n"),
      title: "<current_user_request>Project branch preference</current_user_request>",
      layer: "L2",
      source: "codex"
    });

    const inserted = db.db.prepare(
      `SELECT memory_value, info_json
       FROM memories
       WHERE id = ?`
    ).get(added.id) as { memory_value: string; info_json: string };
    expect(inserted.memory_value).toBe("The user prefers dev-jiang for this project.");
    expect(inserted.memory_value).not.toContain("Historical User");
    expect(inserted.memory_value).not.toContain("current_user_request");
    expect(JSON.parse(inserted.info_json)).toMatchObject({
      title: "Project branch preference",
      summary: "The user prefers dev-jiang for this project."
    });

    db.close();
  });

  it("sanitizes memmy recall outputs before storing completed turns", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "memmy-agent",
        profileId: "default",
        userId: "turn-sanitize-user"
      }
    });

    const complete = service.completeTurn("turn-memmy-sanitize", {
      sessionId: session.sessionId,
      query: [
        '<memmy_memory_context source="turn_start">',
        "Historical User: old task",
        "</memmy_memory_context>",
        "",
        "<current_user_request>",
        "Current task",
        "</current_user_request>",
      ].join("\n"),
      answer: "<current_user_request>Done with the current task.</current_user_request>",
      toolCalls: [
        {
          id: "call-memory",
          type: "function",
          function: {
            name: "memmy_memory_search",
            arguments: JSON.stringify({ query: "old task" })
          }
        }
      ],
      toolResults: [
        {
          toolCallId: "call-memory",
          name: "memmy_memory_search",
          output: '<memmy_memory_context source="tool_search">\nHistorical User: old task\n</memmy_memory_context>'
        }
      ]
    });

    const rawTurn = db.db.prepare(
      `SELECT user_text, assistant_text, tool_calls_json, tool_results_json
       FROM raw_turns
       WHERE id = ?`
    ).get(complete.rawTurnId) as {
      user_text: string;
      assistant_text: string;
      tool_calls_json: string;
      tool_results_json: string;
    };
    expect(rawTurn.user_text).toBe("Current task");
    expect(rawTurn.assistant_text).toBe("Done with the current task.");
    expect(rawTurn.user_text).not.toContain("Historical User");

    const toolResults = JSON.parse(rawTurn.tool_results_json) as Array<{ output?: string; name?: string }>;
    expect(toolResults[0]).toMatchObject({
      name: "memmy_memory_search",
      output: "[memmy memory result omitted from capture: memmy_memory_search]"
    });
    expect(JSON.stringify(toolResults)).not.toContain("Historical User");

    const toolCalls = JSON.parse(rawTurn.tool_calls_json) as Array<{ output?: string }>;
    expect(toolCalls[0]?.output).toBe("[memmy memory result omitted from capture: memmy_memory_search]");

    const detail = service.getMemory(complete.l1MemoryId);
    expect(detail.item.body).toContain("User:\nCurrent task");
    expect(detail.item.body).toContain("Agent:\nDone with the current task.");
    expect(detail.item.body).not.toContain("Historical User");
    expect(detail.item.body).not.toContain("memmy_memory_context");

    db.close();
  });

  it("stores empty turns as raw observations without creating empty L1 memories", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "empty-capture-user"
      }
    });

    const complete = service.completeTurn("turn-empty-capture", {
      sessionId: session.sessionId,
      query: "",
      answer: ""
    });

    expect(complete.l1MemoryId).toBe("");
    expect(complete.l1MemoryIds).toEqual([]);
    expect(complete.jobs.map((job) => job.jobType)).not.toContain("reward");
    const rawTurn = db.db.prepare(
      `SELECT id
       FROM raw_turns
       WHERE id = ?`
    ).get(complete.rawTurnId) as { id: string } | undefined;
    expect(rawTurn?.id).toBe(complete.rawTurnId);
    const emptyMemories = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ?`
    ).get("empty-capture-user") as { count: number };
    expect(emptyMemories.count).toBe(0);
    db.close();
  });

  it("uses plugin-style structural error signatures for capture and recall", async () => {
    const { service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-structural"
      },
      workspaceId: "workspace-structural"
    });

    const complete = service.completeTurn("turn-error", {
      sessionId: session.sessionId,
      query: "安装 psycopg2 失败",
      answer: "需要先处理 native dependency 缺失。",
      toolCalls: [{
        name: "shell",
        input: "pip install psycopg2",
        output: "error: pg_config executable not found",
        success: false
      }]
    });

    const detail = service.getMemory(complete.l1MemoryId);
    const properties = detail.metadata.properties as {
      internal_info: {
        trace: {
          error_signatures?: string[];
          signature?: string;
        };
      };
    };
    expect(properties.internal_info.trace.error_signatures?.some((item) =>
      item.toLowerCase().includes("pg_config executable not found")
    )).toBe(true);
    expect(properties.internal_info.trace.signature?.endsWith("|shell|_")).toBe(true);
    await service.runWorkerOnce(20);

    const recall = await service.search({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-structural"
      },
      query: "pg_config executable not found",
      layers: ["L1"],
      limit: 3
    });

    expect(recall.hits.some((hit) => hit.id === complete.l1MemoryId)).toBe(true);
  });

  it("records compact, tool, and subagent envelopes outside the agent loop", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-align"
      }
    });
    const complete = service.completeTurn("turn-align-source", {
      sessionId: session.sessionId,
      query: "检查 memory service 设计对齐",
      answer: "已经生成 L1 trace 作为 compact 输入。"
    });

    const before = await service.observeTool({
      sessionId: session.sessionId,
      turnId: "turn-tool-observe",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "memory-service-branch/design.md" }
    });
    if (!before.rawTurnId) {
      throw new Error("expected observeTool to return rawTurnId");
    }
    const after = await service.observeTool({
      sessionId: session.sessionId,
      turnId: "turn-tool-observe",
      toolCallId: "call-1",
      toolName: "read_file",
      result: "ok"
    });
    expect(after.rawTurnId).toBe(before.rawTurnId);

    const toolRow = db.db.prepare(
      `SELECT tool_calls_json, tool_results_json, message_payload_json
       FROM raw_turns
       WHERE id = ?`
    ).get(before.rawTurnId) as {
      tool_calls_json: string;
      tool_results_json: string;
      message_payload_json: string;
    } | undefined;
    expect(toolRow).toBeTruthy();
    const toolCalls = JSON.parse(toolRow!.tool_calls_json) as Array<{ name?: string }>;
    const toolResults = JSON.parse(toolRow!.tool_results_json) as Array<{ success?: boolean }>;
    const toolPayload = JSON.parse(toolRow!.message_payload_json) as {
      last_observation?: { phase?: string };
    };
    expect(toolCalls[0]?.name).toBe("read_file");
    expect(toolResults[0]?.success).toBe(true);
    expect(toolPayload.last_observation?.phase).toBe("complete");
    const observeChanges = db.db.prepare(
      `SELECT op, change_type, before_json, after_json
       FROM memory_change_log
       WHERE entity_id = ?
         AND source = 'tools.observe'
       ORDER BY seq ASC`
    ).all(before.rawTurnId) as Array<{
      op: string;
      change_type: string;
      before_json: string | null;
      after_json: string | null;
    }>;
    expect(observeChanges).toHaveLength(2);
    expect(observeChanges[0]).toMatchObject({
      op: "created",
      change_type: "raw_turn_created",
      before_json: null
    });
    expect(observeChanges[1]).toMatchObject({
      op: "updated",
      change_type: "raw_turn_update"
    });
    expect(JSON.parse(observeChanges[0]!.after_json!) as { toolCalls?: Array<{ name?: string }> }).toMatchObject({
      toolCalls: [{ name: "read_file" }]
    });

    const observedComplete = service.completeTurn("turn-tool-observe", {
      sessionId: session.sessionId,
      query: "读取设计文档里的工具观察链路",
      answer: "read_file 返回 ok，工具观察已写入 raw turn。",
      reasoningSummary: "Validated observed tool payload before completing the turn.",
      usage: { inputTokens: 12, outputTokens: 8 },
      sourceMemoryIds: [complete.l1MemoryId]
    });
    expect(observedComplete.rawTurnId).toBe(before.rawTurnId);
    expect(observedComplete.l1MemoryIds).toHaveLength(1);

    const completedToolRow = db.db.prepare(
      `SELECT user_text, assistant_text, reasoning_summary, tool_calls_json,
              tool_results_json, source_memory_ids_json, usage_json,
              message_payload_json, status
       FROM raw_turns
       WHERE id = ?`
    ).get(before.rawTurnId) as {
      user_text: string | null;
      assistant_text: string | null;
      reasoning_summary: string | null;
      tool_calls_json: string;
      tool_results_json: string;
      source_memory_ids_json: string;
      usage_json: string;
      message_payload_json: string;
      status: string;
    };
    expect(completedToolRow.user_text).toBe("读取设计文档里的工具观察链路");
    expect(completedToolRow.assistant_text).toBe("read_file 返回 ok，工具观察已写入 raw turn。");
    expect(completedToolRow.reasoning_summary).toContain("Validated observed tool payload");
    expect(JSON.parse(completedToolRow.tool_calls_json)).toHaveLength(1);
    expect(JSON.parse(completedToolRow.tool_results_json)).toHaveLength(1);
    expect(JSON.parse(completedToolRow.source_memory_ids_json)).toEqual([complete.l1MemoryId]);
    expect(JSON.parse(completedToolRow.usage_json)).toMatchObject({ inputTokens: 12, outputTokens: 8 });
    expect(JSON.parse(completedToolRow.message_payload_json)).toMatchObject({
      last_observation: { phase: "complete" },
      turn_complete: {
        source_memory_ids: [complete.l1MemoryId]
      }
    });
    expect(completedToolRow.status).toBe("succeeded");

    const observedTrace = db.db.prepare(
      `SELECT memory_value, properties_json
       FROM memories
       WHERE id = ?`
    ).get(observedComplete.l1MemoryIds[0]) as {
      memory_value: string;
      properties_json: string;
    };
    expect(observedTrace.memory_value).toContain("Tool calls:");
    expect(observedTrace.memory_value).toContain("read_file");
    const observedTraceInternal = (JSON.parse(observedTrace.properties_json) as {
      internal_info: {
        source_memory_ids?: string[];
        trace?: {
          tool_calls?: Array<{ name?: string }>;
        };
      };
    }).internal_info;
    expect(observedTraceInternal.source_memory_ids).toEqual([complete.l1MemoryId]);
    expect(observedTraceInternal.trace?.tool_calls?.[0]?.name).toBe("read_file");

    const observedL1MemoryId = observedComplete.l1MemoryIds[0];
    if (!observedL1MemoryId) {
      throw new Error("expected observed complete to create an L1 memory");
    }
    const observedDetail = service.getMemory(observedL1MemoryId) as {
      refs?: {
        rawTurn?: {
          reasoningSummary?: string;
        };
      };
    };
    expect(observedDetail.refs?.rawTurn?.reasoningSummary).toContain("Validated observed tool payload");

    const compact = service.compactSession(session.sessionId, {
      summary: "compact summary for design alignment",
      sourceMemoryIds: [complete.l1MemoryId],
      sourceTurnIds: [complete.turnId],
      tokenEstimate: 64
    });
    if (!compact.rawTurnId || !compact.l1MemoryId) {
      throw new Error("expected compactSession to create raw turn and L1 memory");
    }
    const compactRow = db.db.prepare(
      `SELECT assistant_text, message_payload_json
       FROM raw_turns
       WHERE id = ?`
    ).get(compact.rawTurnId) as {
      assistant_text: string;
      message_payload_json: string;
    } | undefined;
    expect(compactRow?.assistant_text).toBe("compact summary for design alignment");
    const compactPayload = JSON.parse(compactRow!.message_payload_json) as {
      compact?: {
        contextPacketId?: string;
        sourceMemoryIds?: string[];
        tokenEstimate?: number;
      };
    };
    expect(compactPayload.compact?.contextPacketId).toBe(compact.contextPacketId);
    expect(compactPayload.compact?.sourceMemoryIds).toEqual([complete.l1MemoryId]);
    expect(compactPayload.compact?.tokenEstimate).toBe(64);

    const compactDetail = service.getMemory(compact.l1MemoryId);
    const refs = compactDetail.metadata.refs as {
      rawTurn?: {
        rawTurnId?: string;
        assistantText?: string;
      };
    };
    expect(refs.rawTurn?.rawTurnId).toBe(compact.rawTurnId);
    expect(refs.rawTurn?.assistantText).toBe("compact summary for design alignment");
    const compactTraceRow = db.db.prepare(
      `SELECT memory_value, properties_json
       FROM memories
       WHERE id = ?`
    ).get(compact.l1MemoryId) as { memory_value: string; properties_json: string };
    const compactTrace = (JSON.parse(compactTraceRow.properties_json) as {
      internal_info: { trace: { priority?: number } };
    }).internal_info.trace;
    expect(compactTraceRow.memory_value).toContain("Priority: 0.5");
    expect(compactTrace.priority).toBe(0.5);

    expect(compact.changeSeq).toBeGreaterThan(0);
    expect(compact.syncCursor).toMatch(/^cur_/);
    const compactLatestChange = db.db.prepare(
      `SELECT seq, kind, op, source
       FROM memory_change_log
       WHERE namespace_id = (
         SELECT namespace_id
         FROM memory_change_log
         WHERE entity_id = ?
         ORDER BY seq ASC
         LIMIT 1
       )
       ORDER BY seq DESC
       LIMIT 1`
    ).get(compact.rawTurnId) as { seq: number; kind: string; op: string; source: string };
    expect(compact.changeSeq).toBe(compactLatestChange.seq);
    expect(compactLatestChange).toMatchObject({
      kind: "job",
      op: "queued",
      source: "worker.evolution_jobs"
    });
    const compactL3Job = db.db.prepare(
      `SELECT target_memory_id, payload_json
       FROM evolution_jobs
       WHERE job_type = 'l3_abstraction'
         AND json_extract(payload_json, '$.rawTurnId') = ?`
    ).get(compact.rawTurnId) as { target_memory_id: string | null; payload_json: string } | undefined;
    expect(compactL3Job?.target_memory_id).toBeNull();
    expect(JSON.parse(compactL3Job!.payload_json)).toMatchObject({
      reason: "manual_compaction",
      targetKind: "policy_cluster",
      sourceMemoryId: compact.l1MemoryId,
      episodeId: expect.stringMatching(/^episode_/),
      rawTurnId: compact.rawTurnId
    });

    const compactWithoutL1 = service.compactSession(session.sessionId, {
      summary: "compact summary without l1 materialization",
      createL1: false
    });
    expect(compactWithoutL1.l1MemoryId).toBeUndefined();
    expect(compactWithoutL1.rawTurnId).toMatch(/^raw_/);
    expect(compactWithoutL1.rawTurnId).not.toBe(compact.rawTurnId);
    expect(compactWithoutL1.changeSeq).toBeGreaterThan(compact.changeSeq!);
    expect(compactWithoutL1.syncCursor).toMatch(/^cur_/);
    const compactWithoutL1LatestChange = db.db.prepare(
      `SELECT MAX(seq) AS seq
       FROM memory_change_log
       WHERE namespace_id = (
         SELECT namespace_id
         FROM memory_change_log
         WHERE entity_id = ?
         ORDER BY seq ASC
         LIMIT 1
       )`
    ).get(compactWithoutL1.rawTurnId) as { seq: number };
    expect(compactWithoutL1.changeSeq).toBe(compactWithoutL1LatestChange.seq);

    const start = service.subagentStart({
      sessionId: session.sessionId,
      subagentId: "researcher",
      task: "summarize memory-service-branch design",
      metadata: { source: "memory-service-branch" }
    });
    expect(start.rawTurnId).toMatch(/^raw_/);
    expect(start.changeSeq).toBeGreaterThan(0);
    expect(start.syncCursor.startsWith("cur_")).toBe(true);
    const subagentStartChange = db.db.prepare(
      `SELECT kind, op, source
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq DESC
       LIMIT 1`
    ).get(start.rawTurnId) as { kind: string; op: string; source: string };
    expect(subagentStartChange).toEqual({
      kind: "raw_turn",
      op: "created",
      source: "subagent.start"
    });
    const secondStart = service.subagentStart({
      sessionId: session.sessionId,
      subagentId: "researcher",
      task: "run a second alignment scan",
      metadata: { source: "memory-service-branch" }
    });
    expect(secondStart.rawTurnId).toMatch(/^raw_/);
    expect(secondStart.rawTurnId).not.toBe(start.rawTurnId);
    expect(secondStart.changeSeq).toBeGreaterThan(start.changeSeq);
    const subagentComplete = service.subagentComplete({
      sessionId: session.sessionId,
      subagentId: "researcher",
      result: "subagent completed alignment scan",
      summary: "alignment scan done",
      metadata: { source: "memory-service-branch" }
    });
    expect(subagentComplete.changeSeq).toBeGreaterThan(start.changeSeq);
    expect(subagentComplete.syncCursor.startsWith("cur_")).toBe(true);
    const subagentRow = db.db.prepare(
      `SELECT message_payload_json
       FROM raw_turns
       WHERE id = ?`
    ).get(subagentComplete.rawTurnId) as { message_payload_json: string } | undefined;
    const subagentPayload = JSON.parse(subagentRow!.message_payload_json) as {
      subagentComplete?: { metadata?: Record<string, unknown>; summary?: string };
    };
    expect(subagentPayload.subagentComplete?.metadata).toMatchObject({ source: "memory-service-branch" });
    expect(subagentPayload.subagentComplete?.summary).toBe("alignment scan done");
    const subagentCompleteChange = db.db.prepare(
      `SELECT kind, op, source
       FROM memory_change_log
       WHERE entity_id = ?
         AND source = 'subagent.complete'
       ORDER BY seq DESC
       LIMIT 1`
    ).get(subagentComplete.rawTurnId) as { kind: string; op: string; source: string };
    expect(subagentCompleteChange).toEqual({
      kind: "raw_turn",
      op: "updated",
      source: "subagent.complete"
    });

    const auditCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM audit_logs
       WHERE session_id = ?`
    ).get(session.sessionId) as { count: number };
    expect(auditCount.count).toBeGreaterThanOrEqual(2);
    db.close();
  });
});
