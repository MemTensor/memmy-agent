import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDagConfig } from "../../src/config/schema.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { SessionDagBuilder } from "../../src/session-dag/builder.js";
import { sessionDagDbPath, sessionDagDebugLogPath } from "../../src/session-dag/paths.js";
import { SessionDagQueueManager } from "../../src/session-dag/queue.js";
import { SessionDagStore } from "../../src/session-dag/store.js";
import { SessionDagUsageReporter } from "../../src/session-dag/usage.js";

const roots: string[] = [];
let oldDagDir: string | undefined;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-dag-builder-"));
  roots.push(root);
  return root;
}

function makeSession(root: string, key: string, metadata: Record<string, any> = {}): { sessions: SessionManager; session: Session } {
  const sessions = new SessionManager(path.join(root, "sessions"));
  const session = new Session({ key, metadata });
  session.addMessage("user", "请实现 DAG store");
  session.addMessage("assistant", "", {
    tool_calls: [{ id: "call_1", function: { name: "apply_patch", arguments: "{\"file\":\"store.ts\"}" } }],
  });
  session.addMessage("tool", "patch applied", { tool_call_id: "call_1", name: "apply_patch" });
  session.addMessage("assistant", "已完成 DAG store。");
  sessions.save(session);
  return { sessions, session };
}

function readDebugRecords(sessionKey: string): any[] {
  return fs
    .readFileSync(sessionDagDebugLogPath(sessionKey), "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForQueueDrain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  if (oldDagDir === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
  else process.env.MEMMY_AGENT_SESSION_DAG_DIR = oldDagDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Session DAG builder and queue", () => {
  it("builds a patch from turn messages and DAG context", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:builder";
    const { sessions, session } = makeSession(root, sessionKey, { webui: true });
    const store = new SessionDagStore({ sessionKey, dbPath: sessionDagDbPath(sessionKey) });
    const provider: any = {
      spec: { name: "openai" },
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify({
          ops: [
            {
              op: "add_node",
              temp_id: "n0",
              kind: "task",
              status: "active",
              title: "实现 DAG store",
              summary: "实现 session 级 DAG SQLite store",
              importance: 94,
            },
            {
              op: "add_node",
              temp_id: "n1",
              kind: "subtask",
              status: "done",
              title: "完成 store 事务",
              summary: "已实现 patch 落库和事务写入",
              importance: 86,
            },
            { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
          ],
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })),
    };
    const recorder = { recordAgentChatUsage: vi.fn(async () => true) };
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      usageReporter: new SessionDagUsageReporter(recorder),
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-1", message_start: 0, message_end: session.messages.length });

    try {
      await builder.buildAndApply(store.getTurn("turn-1")!);

      const call = provider.chatWithRetry.mock.calls[0]?.[0] as any;
      const systemPrompt = String(call.messages[0]?.content ?? "");
      const payload = JSON.parse(call.messages[1].content);
      expect(call.reasoningEffort).toBe("none");
      expect(systemPrompt).toContain("add_node required fields");
      expect(systemPrompt).toContain("summary");
      expect(systemPrompt).toContain("meaningless small talk");
      expect(systemPrompt).toContain("summary must preserve the useful answer or conclusion");
      expect(systemPrompt).toContain('Use exactly "n0", "n1", "n2"');
      expect(systemPrompt).toContain("n0/n1/n2 are invalid here");
      expect(systemPrompt).toContain("Temporary ids are patch-local");
      expect(systemPrompt).toContain("Do not create orphan subtask or decision nodes.");
      expect(systemPrompt).toContain("Every new subtask or decision must be connected by add_edge so it is reachable from a task root.");
      expect(systemPrompt).toContain('For add_node with kind="task", status must be "active" or "blocked"');
      expect(systemPrompt).toContain("Node kind meanings");
      expect(systemPrompt).toContain("Edge type meanings");
      expect(systemPrompt).toContain("done/failed task -> next task");
      expect(systemPrompt).toContain("frozen task -> replacement task");
      expect(systemPrompt).toContain("Adding a task while dag_context.root_task_id exists is a task switch");
      expect(systemPrompt).toContain("dag_context.active_path and dag_context.active_path_edges");
      expect(systemPrompt).toContain("latest completed subtask/decision");
      expect(systemPrompt).toContain("Subtask granularity rules");
      expect(systemPrompt).toContain("same main tool for the same purpose");
      expect(systemPrompt).toContain(
        "If a subtask encounters tool-call errors or trial-and-error during execution, record them in detail_json.errors even if the subtask later succeeds.",
      );
      expect(systemPrompt).toContain(
        "Work using a different main tool, using the same main tool for a clearly different goal, or moving into a different execution phase normally creates a different subtask connected with continues.",
      );
      expect(systemPrompt).toContain(
        "If a subtask fails and work switches to a different method, mark the old subtask as failed, create a new subtask for the new method, and connect them with a continues edge.",
      );
      expect(systemPrompt).toContain("source_refs rules");
      expect(systemPrompt).toContain("importance rules");
      expect(systemPrompt).toContain("add_edge required fields");
      expect(systemPrompt).toContain("source_id");
      expect(systemPrompt).toContain("target_id");
      expect(systemPrompt).toContain("Do not add source_refs to task nodes");
      expect(systemPrompt).not.toContain("Controlled values");
      expect(systemPrompt).not.toContain("must never use source_id or target_id");
      expect(payload.turn_messages.messages).toHaveLength(4);
      expect(payload.turn_messages.messages[1].tool_calls[0]).toMatchObject({
        tool_call_id: "call_1",
        tool_name: "apply_patch",
      });
      expect(payload.dag_context).toMatchObject({ root_task_id: null, nodes: [], edges: [], active_path: [], active_path_edges: [] });
      expect(store.readGraphForHistoryDag().nodes.map((node) => node.title).sort()).toEqual(["完成 store 事务", "实现 DAG store"]);
      const debugRecords = readDebugRecords(sessionKey);
      expect(debugRecords).toHaveLength(1);
      expect(debugRecords[0]).toMatchObject({
        version: 1,
        sessionKey,
        turnId: "turn-1",
        attempt: 1,
        messageRange: { start: 0, end: session.messages.length },
        provider: "openai",
        model: "test-model",
        request: {
          userPayload: {
            turn_messages: { turn_id: "turn-1", message_start: 0, message_end: session.messages.length },
            dag_context: { root_task_id: null, nodes: [], edges: [], active_path: [], active_path_edges: [] },
          },
          dagContextNodeCount: 0,
          dagContextEdgeCount: 0,
          turnMessageCount: 4,
        },
        parse: { ok: true, opsCount: 3 },
        validation: { ok: true },
        apply: { ok: true, edgeIds: expect.any(Array) },
        error: null,
      });
      expect(debugRecords[0].request.systemPrompt).toContain("add_node required fields");
      expect(debugRecords[0].response.content).toContain("\"ops\"");
      expect(debugRecords[0].validation.normalizedPatch).toEqual(debugRecords[0].validation.validatedPatch);
      expect(Object.values(debugRecords[0].apply.nodeIds)).toHaveLength(2);
      expect(recorder.recordAgentChatUsage).toHaveBeenCalledWith(expect.objectContaining({
        operation: "session_dag_builder",
        operationId: "session-dag-builder:websocket:builder:turn-1:attempt:1",
        metadata: expect.objectContaining({
          turnId: "turn-1",
          contextNodeCount: 0,
        }),
      }));
    } finally {
      store.close();
    }
  });

  it("normalizes an omitted old-task closure and transition without an extra provider call", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:normalize-task-switch";
    const { sessions, session } = makeSession(root, sessionKey);
    const store = new SessionDagStore({ sessionKey });
    const seed = store.applyPatch({
      turn: { turn_id: "turn-seed", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "add_node", temp_id: "old", kind: "task", status: "active", title: "制作 PPT", summary: "制作环保主题 PPT", importance: 90 },
          { op: "add_node", temp_id: "done", kind: "subtask", status: "done", title: "交付 PPT", summary: "已完成并交付", importance: 80 },
          { op: "add_edge", source_id: "old", target_id: "done", type: "decomposes" },
        ],
      },
    }).nodeIds;
    const rawPatch = {
      ops: [
        {
          op: "add_node",
          temp_id: "n0",
          kind: "task",
          status: "active",
          title: "查询演唱会场次",
          summary: "核实巡演场次",
          importance: 90,
        },
        {
          op: "add_node",
          temp_id: "n1",
          kind: "subtask",
          status: "done",
          title: "核实巡演",
          summary: "已核实巡演信息",
          importance: 75,
        },
        { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
      ],
    };
    const provider: any = {
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify(rawPatch),
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      })),
    };
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-switch", message_start: 0, message_end: session.messages.length });

    try {
      await builder.buildAndApply(store.getTurn("turn-switch")!);

      const graph = store.readGraphForHistoryDag();
      const newTask = graph.nodes.find((node) => node.title === "查询演唱会场次")!;
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
      expect(graph.nodes.find((node) => node.id === seed.old)).toMatchObject({ status: "done" });
      expect(newTask).toMatchObject({ kind: "task", status: "active" });
      expect(graph.nodes.filter((node) => node.kind === "task" && (node.status === "active" || node.status === "blocked"))).toHaveLength(1);
      expect(graph.edges).toContainEqual(expect.objectContaining({
        source_id: seed.old,
        target_id: newTask.id,
        type: "continues",
      }));
      expect(store.getTurn("turn-switch")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });

      const [record] = readDebugRecords(sessionKey);
      expect(record.parse.parsedPatch).toEqual(rawPatch);
      expect(record.validation.parsedPatch).toEqual(rawPatch);
      expect(record.validation.normalizedPatch.ops).toEqual(expect.arrayContaining([
        { op: "update_node", node_id: seed.old, status: "done" },
        { op: "add_edge", source_id: seed.old, target_id: "n0", type: "continues" },
      ]));
    } finally {
      store.close();
    }
  });

  it("retries explicit task-transition conflicts and falls back without creating a second task", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "cli:conflicting-task-switch";
    const { sessions, session } = makeSession(root, sessionKey);
    const seedStore = new SessionDagStore({ sessionKey });
    const seed = seedStore.applyPatch({
      turn: { turn_id: "turn-seed", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "add_node", temp_id: "old", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 },
          { op: "add_node", temp_id: "done", kind: "subtask", status: "done", title: "旧结果", summary: "已有结果", importance: 70 },
          { op: "add_edge", source_id: "old", target_id: "done", type: "decomposes" },
        ],
      },
    }).nodeIds;
    seedStore.close();
    const conflictingPatch = {
      ops: [
        { op: "update_node", node_id: seed.old, status: "done" },
        { op: "add_node", temp_id: "n0", kind: "task", status: "active", title: "冲突新任务", summary: "冲突新任务", importance: 90 },
        { op: "add_edge", source_id: seed.old, target_id: "n0", type: "supersedes" },
      ],
    };
    const provider: any = {
      chatWithRetry: vi.fn(async (request: any) => {
        if (provider.chatWithRetry.mock.calls.length > 1) {
          const payload = JSON.parse(request.messages[1].content);
          expect(payload.previous_patch_error.instruction).toContain("fix both the old root terminal status");
          expect(payload.previous_patch_error.instruction).toContain("do not evade the error");
          expect(payload.previous_patch_error.message).toContain("conflicts with edge type supersedes");
        }
        return { content: JSON.stringify(conflictingPatch), usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }),
    };
    const queue = new SessionDagQueueManager({
      config: new SessionDagConfig({ debugLog: true, maxUpdateAttempts: 2, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
      sessions,
      provider: () => provider,
      model: () => "test-model",
    });

    queue.enqueueSavedTurn(sessionKey, {
      turn_id: "turn-conflict",
      message_start: 0,
      message_end: session.messages.length,
      user_text: "切换任务",
      assistant_text: "已处理",
    });

    const processed = await queue.waitUntilProcessed(sessionKey, "turn-conflict", 10000);
    const store = new SessionDagStore({ sessionKey });
    try {
      const graph = store.readGraphForHistoryDag();
      expect(processed).toBe(true);
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
      expect(graph.nodes.filter((node) => node.kind === "task")).toHaveLength(1);
      expect(graph.nodes.find((node) => node.id === seed.old)).toMatchObject({ status: "active" });
      expect(graph.nodes.map((node) => node.title)).not.toContain("冲突新任务");
      expect(store.getTurn("turn-conflict")).toMatchObject({ dag_status: "done", build_mode: "deterministic_fallback" });
    } finally {
      store.close();
      await waitForQueueDrain();
      queue.closeAll();
    }
  });

  it.each([
    {
      name: "skipped temp_id ordinal",
      rejectedPatch: {
        ops: [
          {
            op: "add_node",
            temp_id: "n1",
            kind: "task",
            status: "active",
            title: "实现 DAG store",
            summary: "实现 session 级 DAG SQLite store",
            importance: 90,
          },
        ],
      },
      errorPattern: /temp_id must be n0/,
    },
    {
      name: "same-patch update_node temp id",
      rejectedPatch: {
        ops: [
          {
            op: "add_node",
            temp_id: "n0",
            kind: "task",
            status: "active",
            title: "实现 DAG store",
            summary: "实现 session 级 DAG SQLite store",
            importance: 90,
          },
          { op: "update_node", node_id: "n0", status: "done" },
        ],
      },
      errorPattern: /update_node\.node_id cannot reference temp_id n0/,
    },
  ])("passes the previous schema error into a retry so the patch can be corrected: $name", async ({ rejectedPatch, errorPattern }) => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "cli:retry-error";
    const { sessions, session } = makeSession(root, sessionKey);
    let callNumber = 0;
    const provider: any = {
      chatWithRetry: vi.fn(async (request: any) => {
        callNumber += 1;
        if (callNumber === 1) {
          return {
            content: JSON.stringify(rejectedPatch),
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        const payload = JSON.parse(request.messages[1].content);
        expect(payload.previous_patch_error).toMatchObject({
          attempt_count: 1,
          current_temp_id_rule:
            "For this attempt, new add_node temp_id values must be exactly n0, n1, n2 in add_node order. Rewrite all temp ids and matching add_edge source_id/target_id references to this format.",
        });
        expect(payload.previous_patch_error.instruction).toContain("First read previous_patch_error.message");
        expect(payload.previous_patch_error.instruction).toContain("n0, n1, n2");
        expect(payload.previous_patch_error.instruction).toContain("add_edge source_id/target_id references");
        expect(payload.previous_patch_error.instruction).toContain("update_node.node_id uses only ids copied from dag_context.nodes");
        expect(payload.previous_patch_error.instruction).toContain("Do not fix a malformed patch by dropping edges");
        expect(payload.previous_patch_error.message).toMatch(errorPattern);
        return {
          content: JSON.stringify({
            ops: [
              {
                op: "add_node",
                temp_id: "n0",
                kind: "task",
                status: "active",
                title: "实现 DAG store",
                summary: "实现 session 级 DAG SQLite store",
                importance: 90,
              },
              {
                op: "add_node",
                temp_id: "n1",
                kind: "subtask",
                status: "done",
                title: "完成 store 事务",
                summary: "完成 DAG store 的事务写入",
                importance: 80,
              },
              { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
            ],
          }),
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      }),
    };
    const queue = new SessionDagQueueManager({
      config: new SessionDagConfig({ maxUpdateAttempts: 2, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
      sessions,
      provider: () => provider,
      model: () => "test-model",
    });

    queue.enqueueSavedTurn(sessionKey, {
      turn_id: "turn-retry",
      message_start: 0,
      message_end: session.messages.length,
      user_text: "请实现 DAG store",
      assistant_text: "已完成 DAG store。",
    });

    const processed = await queue.waitUntilProcessed(sessionKey, "turn-retry", 10000);
    const store = new SessionDagStore({ sessionKey });
    try {
      const graph = store.readGraphForHistoryDag();
      expect(processed).toBe(true);
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
      for (const [request] of provider.chatWithRetry.mock.calls) {
        expect(request.reasoningEffort).toBe("none");
      }
      expect(store.getTurn("turn-retry")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
      expect(graph.nodes.map((node) => node.title).sort()).toEqual(["完成 store 事务", "实现 DAG store"]);
      expect(graph.edges).toHaveLength(1);
    } finally {
      store.close();
      await waitForQueueDrain();
      queue.closeAll();
    }
  });

  it("rejects retry patches that drop edges for newly added subtasks", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "cli:retry-dropped-edge";
    const { sessions, session } = makeSession(root, sessionKey);
    let callNumber = 0;
    const provider: any = {
      chatWithRetry: vi.fn(async () => {
        callNumber += 1;
        if (callNumber === 1) {
          return {
            content: JSON.stringify({
              ops: [
                {
                  add_node: {
                    op: "add_node",
                    temp_id: "n0",
                    kind: "subtask",
                    status: "active",
                    title: "孤立子任务",
                    summary: "格式错误但原本包含边",
                    importance: 75,
                  },
                },
                {
                  add_edge: {
                    op: "add_edge",
                    source_id: "n_existing",
                    target_id: "n0",
                    type: "continues",
                  },
                },
              ],
            }),
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        return {
          content: JSON.stringify({
            ops: [
              {
                op: "add_node",
                temp_id: "n0",
                kind: "subtask",
                status: "active",
                title: "孤立子任务",
                summary: "retry 修正格式时丢掉了边",
                importance: 75,
              },
            ],
          }),
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      }),
    };
    const queue = new SessionDagQueueManager({
      config: new SessionDagConfig({ maxUpdateAttempts: 2, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
      sessions,
      provider: () => provider,
      model: () => "test-model",
    });

    queue.enqueueSavedTurn(sessionKey, {
      turn_id: "turn-retry-dropped-edge",
      message_start: 0,
      message_end: session.messages.length,
      user_text: "请实现 DAG store",
      assistant_text: "已完成 DAG store。",
    });

    const processed = await queue.waitUntilProcessed(sessionKey, "turn-retry-dropped-edge", 10000);
    const store = new SessionDagStore({ sessionKey });
    try {
      const graph = store.readGraphForHistoryDag();
      expect(processed).toBe(true);
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
      expect(store.getTurn("turn-retry-dropped-edge")).toMatchObject({ dag_status: "done", build_mode: "deterministic_fallback" });
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.nodes.every((node) => node.created_by === "deterministic_fallback")).toBe(true);
      expect(graph.nodes.map((node) => node.title)).not.toContain("孤立子任务");
    } finally {
      store.close();
      await waitForQueueDrain();
      queue.closeAll();
    }
  });

  it("writes an audit record for an empty but valid patch", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:empty-patch";
    const { sessions, session } = makeSession(root, sessionKey);
    const store = new SessionDagStore({ sessionKey });
    const provider: any = {
      spec: { name: "openai" },
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify({ ops: [] }),
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        finishReason: "stop",
      })),
    };
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-empty", message_start: 0, message_end: session.messages.length });

    try {
      await builder.buildAndApply(store.getTurn("turn-empty")!);

      expect(store.getTurn("turn-empty")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
      expect(store.readGraphForHistoryDag().nodes).toHaveLength(0);
      const records = readDebugRecords(sessionKey);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        response: { content: "{\"ops\":[]}", finishReason: "stop", reasoning: null },
        parse: { ok: true, opsCount: 0, parsedPatch: { ops: [] } },
        validation: { ok: true },
        apply: { ok: true, nodeIds: {}, edgeIds: [] },
        error: null,
      });
    } finally {
      store.close();
    }
  });

  it("writes unified reasoning fields to the builder audit record", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:reasoning";
    const { sessions, session } = makeSession(root, sessionKey);
    const store = new SessionDagStore({ sessionKey });
    const provider: any = {
      spec: { name: "openai" },
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify({ ops: [] }),
        finishReason: "stop",
        usage: { completion_tokens_details: { reasoning_tokens: 12 } },
        reasoningContent: "why empty ops",
        thinkingBlocks: [{ type: "thinking", text: "inspect turn" }],
      })),
    };
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-reasoning", message_start: 0, message_end: session.messages.length });

    try {
      await builder.buildAndApply(store.getTurn("turn-reasoning")!);

      const records = readDebugRecords(sessionKey);
      expect(records).toHaveLength(1);
      expect(records[0].response).toMatchObject({
        content: "{\"ops\":[]}",
        finishReason: "stop",
        usage: { completion_tokens_details: { reasoning_tokens: 12 } },
        reasoning: {
          reasoningContent: "why empty ops",
          thinkingBlocks: [{ type: "thinking", text: "inspect turn" }],
        },
      });
    } finally {
      store.close();
    }
  });

  it("does not read provider raw response fields for builder audit records", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:raw-response-fields";
    const { sessions, session } = makeSession(root, sessionKey);
    const store = new SessionDagStore({ sessionKey });
    const provider: any = {
      spec: { name: "openai" },
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify({ ops: [] }),
        finishReason: "stop",
        finish_reason: "raw_stop",
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        reasoningContent: "unified reasoning",
        reasoning_content: "raw reasoning",
      })),
    };
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-raw-fields", message_start: 0, message_end: session.messages.length });

    try {
      await builder.buildAndApply(store.getTurn("turn-raw-fields")!);

      const records = readDebugRecords(sessionKey);
      expect(records).toHaveLength(1);
      expect(records[0].response.finishReason).toBe("stop");
      expect(records[0].response.reasoning).toEqual({ reasoningContent: "unified reasoning" });
      expect(JSON.stringify(records[0].response)).not.toContain("raw_stop");
      expect(JSON.stringify(records[0].response.reasoning)).not.toContain("raw reasoning");
    } finally {
      store.close();
    }
  });

  it("does not fail the builder when the debug log cannot be written", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "websocket:debug-write-failure";
    const { sessions, session } = makeSession(root, sessionKey);
    const store = new SessionDagStore({ sessionKey });
    const provider: any = {
      chatWithRetry: vi.fn(async () => ({
        content: JSON.stringify({ ops: [] }),
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      })),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fsPromises, "appendFile").mockRejectedValueOnce(new Error("debug disk full"));
    const builder = new SessionDagBuilder({
      sessionKey,
      sessions,
      store,
      provider,
      model: "test-model",
      maxBuilderContextNodes: 40,
      debugLog: true,
    });
    store.upsertTurn({ turn_id: "turn-debug-fail", message_start: 0, message_end: session.messages.length });

    try {
      await expect(builder.buildAndApply(store.getTurn("turn-debug-fail")!)).resolves.toBeUndefined();

      expect(store.getTurn("turn-debug-fail")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
      expect(warn).toHaveBeenCalledWith("[session-dag] failed to write builder debug log", expect.any(Error));
    } finally {
      store.close();
    }
  });

  it("queue falls back deterministically after the retry budget and keeps turn order", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    const sessionKey = "cli:fallback";
    const { sessions, session } = makeSession(root, sessionKey);
    const provider: any = {
      chatWithRetry: vi.fn(async () => ({
        content: null,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        reasoningContent: "why parse failed",
      })),
    };
    const queue = new SessionDagQueueManager({
      config: new SessionDagConfig({ debugLog: true, maxUpdateAttempts: 1, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
      sessions,
      provider: () => provider,
      model: () => "test-model",
    });

    queue.enqueueSavedTurn(sessionKey, {
      turn_id: "turn-1",
      message_start: 0,
      message_end: session.messages.length,
      user_text: "请实现 DAG store",
      assistant_text: "已完成 DAG store。",
    });

    const processed = await queue.waitUntilProcessed(sessionKey, "turn-1", 5000);
    const store = new SessionDagStore({ sessionKey });
    try {
      const graph = store.readGraphForHistoryDag();
      expect(processed).toBe(true);
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
      expect(store.getTurn("turn-1")).toMatchObject({ dag_status: "done", build_mode: "deterministic_fallback" });
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.some((node) => node.created_by === "deterministic_fallback")).toBe(true);
      expect(store.getMeta("last_processed_turn_id")).toBe("turn-1");
      const records = readDebugRecords(sessionKey);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        response: { content: null, reasoning: { reasoningContent: "why parse failed" } },
        parse: { ok: false },
        error: { stage: "parse" },
      });
      expect(records[0].parse.error).toContain("non-string");
    } finally {
      store.close();
      await waitForQueueDrain();
      queue.closeAll();
    }
  });
});
