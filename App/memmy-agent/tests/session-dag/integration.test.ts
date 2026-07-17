import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdHistoryDag } from "../../src/command/builtin.js";
import { CommandContext } from "../../src/command/router.js";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { Consolidator, MemoryStore } from "../../src/core/agent-runtime/memory.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { LLMResponse } from "../../src/providers/base.js";
import { sessionDagDbPath } from "../../src/session-dag/paths.js";
import { DagSnapshotBuilder } from "../../src/session-dag/snapshot.js";
import { SessionDagStore } from "../../src/session-dag/store.js";

const roots: string[] = [];

function tmpRoot(prefix = "memmy-session-dag-integration-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function provider(): any {
  return {
    generation: { maxTokens: 100 },
    chat: vi.fn(async () => new LLMResponse({ content: "ok" })),
    chatWithRetry: vi.fn(async () => new LLMResponse({ content: "summary" })),
    estimatePromptTokens: vi.fn(() => [2000, "test"]),
    getDefaultModel: () => "test-model",
  };
}

function seedGraph(store: SessionDagStore, messageEnd = 4): void {
  store.applyPatch({
    turn: {
      turn_id: "turn-1",
      message_start: 0,
      message_end: messageEnd,
      user_text: "设计 DAG",
      assistant_text: "已完成",
    },
    buildMode: "llm_patch",
    patch: {
      ops: [
        {
          op: "add_node",
          temp_id: "n0",
          kind: "task",
          status: "active",
          title: "设计 DAG",
          summary: "设计 session 级 DAG",
          importance: 94,
        },
        {
          op: "add_node",
          temp_id: "n1",
          kind: "subtask",
          status: "done",
          title: "完成 store",
          summary: "完成 SQLite store",
          importance: 80,
        },
        { op: "add_edge", source_id: "n0", target_id: "n1", type: "decomposes" },
      ],
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Session DAG integration", () => {
  it("AgentLoop enqueues the saved turn range after session persistence", async () => {
    const root = tmpRoot();
    const p = provider();
    const queue = {
      enqueueSavedTurn: vi.fn(),
    };
    const loop = new AgentLoop({
      workspace: root,
      sessionDir: path.join(root, "sessions"),
      provider: p,
      model: "test-model",
      contextWindowTokens: 0,
      sessionDagQueue: queue as any,
    });

    await loop.processDirect("hello", { sessionKey: "cli:dag-loop" });

    expect(queue.enqueueSavedTurn).toHaveBeenCalledTimes(1);
    expect(queue.enqueueSavedTurn).toHaveBeenCalledWith(
      "cli:dag-loop",
      expect.objectContaining({
        turn_id: expect.any(String),
        message_start: 0,
        message_end: 2,
        user_text: "hello",
        assistant_text: "summary",
      }),
    );
  });

  it("/history-dag returns compact text plus GUI payload", async () => {
    const root = tmpRoot();
    const sessionKey = "cli:history-dag";
    const store = new SessionDagStore({
      sessionKey,
      dbPath: sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: path.join(root, "dag") }),
    });
    seedGraph(store);
    store.close();
    const oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
    try {
      const msg = new InboundMessage({ channel: "cli", chatId: "direct", senderId: "user", content: "/history-dag", sessionKey });
      const outbound = await cmdHistoryDag(new CommandContext({
        msg,
        session: new Session({ key: sessionKey }),
        key: sessionKey,
        raw: "/history-dag",
        loop: { config: { sessionDag: { enabled: true } } } as any,
      }));

      expect(outbound.content).toContain("节点数：2");
      expect(outbound.metadata.renderAs).toBe("historyDag");
      expect(outbound.metadata.agentUi.historyDag).toMatchObject({
        sessionKey,
        nodes: expect.arrayContaining([expect.objectContaining({ title: "设计 DAG" })]),
        edges: expect.arrayContaining([expect.objectContaining({ type: "decomposes" })]),
        activePathEdgeIds: [expect.any(String)],
      });
    } finally {
      if (oldDagDir === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
      else process.env.MEMMY_AGENT_SESSION_DAG_DIR = oldDagDir;
    }
  });

  it("repairs a legacy task switch before returning the history payload and next snapshot", async () => {
    const root = tmpRoot();
    const dagDir = path.join(root, "dag");
    const sessionKey = "cli:legacy-history-dag";
    const dbPath = sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: dagDir });
    const seedStore = new SessionDagStore({ sessionKey, dbPath });
    const ids = seedStore.applyPatch({
      turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "add_node", temp_id: "old", kind: "task", status: "active", title: "制作 PPT", summary: "制作并交付 PPT", importance: 90 },
          { op: "add_node", temp_id: "done", kind: "subtask", status: "done", title: "交付 PPT", summary: "PPT 已完成", importance: 80 },
          { op: "add_edge", source_id: "old", target_id: "done", type: "decomposes" },
        ],
      },
    }).nodeIds;
    seedStore.upsertTurn({ turn_id: "turn-2", message_start: 2, message_end: 4 });
    const nextCreatedAt = new Date(Date.now() + 2000).toISOString();
    seedStore.db.prepare(
      `INSERT INTO dag_nodes (
        id, session_key, kind, status, title, summary, detail_json, importance,
        created_turn_id, updated_turn_id, first_message_index, last_message_index,
        source_refs_json, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 'task', 'active', ?, ?, '{}', 90, 'turn-2', 'turn-2', 2, 4, '[]', 'llm_patch', 'llm_patch', ?, ?)`,
    ).run("legacy-next-task", sessionKey, "查询演唱会", "查询巡演场次", nextCreatedAt, nextCreatedAt);
    seedStore.db.prepare("DELETE FROM dag_meta WHERE key='task_transition_repair_v1'").run();
    seedStore.close();

    const oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = dagDir;
    try {
      const msg = new InboundMessage({ channel: "cli", chatId: "direct", senderId: "user", content: "/history-dag", sessionKey });
      const outbound = await cmdHistoryDag(new CommandContext({
        msg,
        session: new Session({ key: sessionKey }),
        key: sessionKey,
        raw: "/history-dag",
        loop: { config: { sessionDag: { enabled: true } } } as any,
      }));
      const payload = outbound.metadata.agentUi.historyDag;

      expect(outbound.metadata.renderAs).toBe("historyDag");
      expect(payload.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ids.old, status: "done" }),
        expect.objectContaining({ id: "legacy-next-task", status: "active" }),
      ]));
      expect(payload.edges).toContainEqual(expect.objectContaining({
        source_id: ids.old,
        target_id: "legacy-next-task",
        type: "continues",
      }));
      expect(payload.activePathNodeIds).toEqual(["legacy-next-task"]);

      const repairedStore = new SessionDagStore({ sessionKey, dbPath });
      try {
        const graph = repairedStore.readGraphForHistoryDag();
        const snapshot = new DagSnapshotBuilder(repairedStore).build({ tokenBudget: 2000 });
        expect(payload.nodes).toHaveLength(graph.nodes.length);
        expect(payload.edges).toHaveLength(graph.edges.length);
        expect(snapshot.snapshot_text).toContain("completed_tasks:");
        expect(snapshot.snapshot_text).toContain("[task done importance=90] 制作 PPT");
      } finally {
        repairedStore.close();
      }
    } finally {
      if (oldDagDir === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
      else process.env.MEMMY_AGENT_SESSION_DAG_DIR = oldDagDir;
    }
  });

  it("/history-dag returns disabled text when session DAG is disabled", async () => {
    const sessionKey = "cli:history-dag-disabled";
    const msg = new InboundMessage({ channel: "cli", chatId: "direct", senderId: "user", content: "/history-dag", sessionKey });

    const outbound = await cmdHistoryDag(new CommandContext({
      msg,
      session: new Session({ key: sessionKey }),
      key: sessionKey,
      raw: "/history-dag",
      loop: { config: { sessionDag: { enabled: false } } } as any,
    }));

    expect(outbound.content).toBe("Session DAG is disabled.");
    expect(outbound.metadata).toMatchObject({ renderAs: "text" });
    expect(outbound.metadata.agentUi).toBeUndefined();
  });

  it("DAG compaction writes deterministic snapshot and advances replay cursor after catchup", async () => {
    const root = tmpRoot();
    const sessionKey = "cli:dag-compact";
    const sessions = new SessionManager(path.join(root, "sessions"));
    const session = new Session({ key: sessionKey });
    session.messages = [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    sessions.save(session);
    const storePath = sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: path.join(root, "dag") });
    const seedStore = new SessionDagStore({ sessionKey, dbPath: storePath });
    seedGraph(seedStore, session.messages.length);
    seedStore.close();
    const queue = { waitUntilProcessed: vi.fn(async () => true) };
    const p = provider();
    const consolidator = new Consolidator({
      store: new MemoryStore(root),
      provider: p,
      model: "test-model",
      sessions,
      contextWindowTokens: 1000,
      maxCompletionTokens: 100,
      consolidationRatio: 0.5,
      buildMessages: ({ history }: any) => history,
      getToolDefinitions: () => [],
      summaryMode: "dag",
      dagQueue: queue as any,
      dagCatchupTimeoutMs: 10,
      createDagStore: (key) => new SessionDagStore({ sessionKey: key, dbPath: storePath }),
    });
    consolidator.safetyBuffer = 0;
    const archive = vi.spyOn(consolidator, "archive");

    const result = await consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: 2 });

    expect(result).toMatchObject({ started: true, changed: true, error: null });
    expect(queue.waitUntilProcessed).toHaveBeenCalledWith(sessionKey, "turn-1", 10);
    expect(archive).not.toHaveBeenCalled();
    expect(session.lastConsolidated).toBe(4);
    expect(session.metadata.lastSummary).toMatchObject({
      mode: "dag",
      text: expect.stringContaining("[Working Memory DAG Snapshot]"),
      dagSnapshotId: expect.stringMatching(/^s_/),
    });
  });

  it("DAG mode does not run idle text compaction", async () => {
    const root = tmpRoot();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const session = new Session({ key: "cli:dag-idle" });
    session.messages = [{ role: "user", content: "old" }, { role: "assistant", content: "reply" }];
    sessions.save(session);
    const consolidator = new Consolidator({
      store: new MemoryStore(root),
      provider: provider(),
      model: "test-model",
      sessions,
      contextWindowTokens: 1000,
      summaryMode: "dag",
    });
    const archive = vi.spyOn(consolidator, "archive");

    await expect(consolidator.compactIdleSession("cli:dag-idle", 1)).resolves.toBeNull();

    expect(archive).not.toHaveBeenCalled();
    expect(sessions.getOrCreate("cli:dag-idle").lastConsolidated).toBe(0);
  });
});
