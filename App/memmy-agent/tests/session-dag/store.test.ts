import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateMessageTokens } from "../../src/core/session/manager.js";
import { safeSessionDagKey, sessionDagDbPath } from "../../src/session-dag/paths.js";
import { renderHistoryDagSummary, buildHistoryDagPayload } from "../../src/session-dag/render.js";
import { buildDagSnapshotText, DagSnapshotBuilder } from "../../src/session-dag/snapshot.js";
import { deriveActivePath, deriveActivePathSelection, SessionDagStore } from "../../src/session-dag/store.js";
import type { DagEdge, DagGoalContext, DagGraph, DagNode } from "../../src/session-dag/types.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-dag-"));
  roots.push(root);
  return root;
}

function makeStore(sessionKey = "websocket:chat/1"): SessionDagStore {
  const root = tmpRoot();
  return new SessionDagStore({
    sessionKey,
    dbPath: sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: root }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionDagStore", () => {
  it("uses one safe SQLite path per session", () => {
    const root = tmpRoot();
    expect(safeSessionDagKey("websocket:chat/1")).toBe("websocket_chat_1");
    expect(sessionDagDbPath("websocket:chat/1", { MEMMY_AGENT_SESSION_DAG_DIR: root })).toBe(
      path.join(root, "websocket_chat_1.sqlite"),
    );
  });

  it("applies patch operations in one session-local DAG", () => {
    const store = makeStore();
    try {
      const result = store.applyPatch({
        turn: {
          turn_id: "turn-1",
          message_start: 0,
          message_end: 4,
          user_text: "实现 DAG",
          assistant_text: "已完成第一步",
        },
        buildMode: "llm_patch",
        patch: {
          ops: [
            {
              op: "add_node",
              temp_id: "task",
              kind: "task",
              status: "active",
              title: "实现上下文 DAG",
              summary: "为 session 构建任务状态图",
              importance: 95,
            },
            {
              op: "add_node",
              temp_id: "subtask",
              kind: "subtask",
              status: "active",
              title: "落 SQLite store",
              summary: "实现 schema、patch 和事务写入",
              importance: 88,
              detail_json: { commands: ["npm test"], files: ["src/session-dag/store.ts"], unsupported: "drop" },
              source_refs: [{ type: "file", path: "src/session-dag/store.ts", title: "store 实现" }],
            },
            {
              op: "add_edge",
              source_id: "task",
              target_id: "subtask",
              type: "decomposes",
            },
          ],
        },
      });

      const graph = store.readGraphForHistoryDag();
      expect(Object.values(result.nodeIds)).toHaveLength(2);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.activePathNodeIds.map((id) => graph.nodes.find((node) => node.id === id)?.title)).toEqual([
        "实现上下文 DAG",
        "落 SQLite store",
      ]);
      const subtask = graph.nodes.find((node) => node.kind === "subtask")!;
      expect(subtask.detail_json).toEqual({ commands: ["npm test"] });
      expect(subtask.source_refs).toEqual([
        { type: "file", path: "src/session-dag/store.ts", title: "store 实现", turn_id: "turn-1" },
      ]);
      expect(store.getMeta("last_processed_turn_id")).toBe("turn-1");
      expect(store.getTurn("turn-1")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
    } finally {
      store.close();
    }
  });

  it("updates nodes with partial semantics, source ref append and shallow detail merge", () => {
    const store = makeStore();
    try {
      const first = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "deterministic_fallback",
        patch: {
          ops: [
            {
              op: "add_node",
              temp_id: "task",
              kind: "task",
              status: "active",
              title: "目标",
              summary: "初始目标",
              importance: 50,
            },
            {
              op: "add_node",
              temp_id: "subtask",
              kind: "subtask",
              status: "active",
              title: "粗任务",
              summary: "兜底生成",
              importance: 50,
              detail_json: { commands: ["npm test"], files: ["a.ts"] },
            },
            { op: "add_edge", source_id: "task", target_id: "subtask", type: "decomposes" },
          ],
        },
      });
      const subtaskId = first.nodeIds.subtask;
      store.applyPatch({
        turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            {
              op: "update_node",
              node_id: subtaskId,
              status: "done",
              summary: "已由 LLM 修正为准确任务",
              importance: 82,
              detail_json: { result: "完成", errors: ["曾失败"] },
              source_refs: [
                { type: "file", path: "a.ts", title: "重复证据" },
                { type: "file", path: "b.ts", title: "新增证据" },
              ],
            },
          ],
        },
      });

      const subtask = store.readGraphForHistoryDag().nodes.find((node) => node.id === subtaskId)!;
      expect(subtask).toMatchObject({
        status: "done",
        summary: "已由 LLM 修正为准确任务",
        importance: 82,
        created_by: "deterministic_fallback",
        updated_by: "llm_patch",
      });
      expect(subtask.detail_json).toEqual({ commands: ["npm test"], result: "完成", errors: ["曾失败"] });
      expect(subtask.source_refs).toEqual([
        { type: "file", path: "a.ts", title: "重复证据", turn_id: "turn-2" },
        { type: "file", path: "b.ts", title: "新增证据", turn_id: "turn-2" },
      ]);
    } finally {
      store.close();
    }
  });

  it("enforces supersedes source direction and cycle rejection", () => {
    const store = makeStore();
    try {
      const ids = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "task", kind: "task", status: "active", title: "根任务", summary: "任务根节点", importance: 85 },
            { op: "add_node", temp_id: "old", kind: "subtask", status: "active", title: "旧任务", summary: "旧路线", importance: 70 },
            { op: "add_node", temp_id: "next", kind: "subtask", status: "active", title: "新任务", summary: "新路线", importance: 80 },
            { op: "add_edge", source_id: "task", target_id: "old", type: "decomposes" },
            { op: "add_edge", source_id: "old", target_id: "next", type: "continues" },
          ],
        },
      }).nodeIds;

      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "add_edge", source_id: ids.next, target_id: ids.old, type: "continues" }] },
        }),
      ).toThrow(/cycle/);

      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-3", message_start: 4, message_end: 6 },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "add_edge", source_id: ids.old, target_id: ids.next, type: "supersedes" }] },
        }),
      ).toThrow(/supersedes source node must be frozen/);

      store.applyPatch({
        turn: { turn_id: "turn-4", message_start: 6, message_end: 8 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "update_node", node_id: ids.old, status: "frozen" },
            { op: "add_edge", source_id: ids.old, target_id: ids.next, type: "supersedes" },
          ],
        },
      });

      expect(store.readGraphForHistoryDag().edges.map((edge) => edge.type).sort()).toEqual(["continues", "decomposes", "supersedes"]);
    } finally {
      store.close();
    }
  });

  it("rolls back isolated added subtask", () => {
    const store = makeStore();
    try {
      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
          buildMode: "llm_patch",
          patch: {
            ops: [
              {
                op: "add_node",
                temp_id: "orphan",
                kind: "subtask",
                status: "active",
                title: "孤立子任务",
                summary: "没有挂到 task root",
                importance: 70,
              },
            ],
          },
        }),
      ).toThrow(/is not reachable from a task/);

      expect(store.readGraphForHistoryDag().nodes).toHaveLength(0);
      expect(store.readGraphForHistoryDag().edges).toHaveLength(0);
      expect(store.getTurn("turn-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("allows connected added subtask", () => {
    const store = makeStore();
    try {
      store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "task", kind: "task", status: "active", title: "任务", summary: "任务根", importance: 80 },
            { op: "add_node", temp_id: "subtask", kind: "subtask", status: "done", title: "子任务", summary: "已连接", importance: 70 },
            { op: "add_edge", source_id: "task", target_id: "subtask", type: "decomposes" },
          ],
        },
      });

      const graph = store.readGraphForHistoryDag();
      expect(graph.nodes.map((node) => node.title).sort()).toEqual(["任务", "子任务"]);
      expect(graph.edges).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects a direct task switch without closing and linking the old root, and rolls back the turn", () => {
    const store = makeStore("websocket:invalid-task-switch");
    try {
      store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "add_node", temp_id: "task", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 }] },
      });

      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "add_node", temp_id: "next", kind: "task", status: "active", title: "新任务", summary: "新任务", importance: 90 }] },
        }),
      ).toThrow(/at most one active or blocked task/);

      expect(store.readGraphForHistoryDag().nodes.map((node) => node.title)).toEqual(["旧任务"]);
      expect(store.readGraphForHistoryDag().edges).toHaveLength(0);
      expect(store.getTurn("turn-2")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("commits a valid direct task switch and enforces status-to-edge mapping", () => {
    const store = makeStore("websocket:valid-task-switch");
    try {
      const oldTaskId = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "add_node", temp_id: "task", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 }] },
      }).nodeIds.task;

      const result = store.applyPatch({
        turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "update_node", node_id: oldTaskId, status: "done" },
            { op: "add_node", temp_id: "next", kind: "task", status: "active", title: "新任务", summary: "新任务", importance: 90 },
            { op: "add_edge", source_id: oldTaskId, target_id: "next", type: "continues" },
          ],
        },
      });
      const graph = store.readGraphForHistoryDag();
      expect(graph.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: oldTaskId, status: "done" }),
        expect.objectContaining({ id: result.nodeIds.next, status: "active" }),
      ]));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        source_id: oldTaskId,
        target_id: result.nodeIds.next,
        type: "continues",
      }));

      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-3", message_start: 4, message_end: 6 },
          buildMode: "llm_patch",
          patch: {
            ops: [
              { op: "update_node", node_id: result.nodeIds.next, status: "frozen" },
              { op: "add_node", temp_id: "third", kind: "task", status: "active", title: "第三个任务", summary: "第三个任务", importance: 90 },
              { op: "add_edge", source_id: result.nodeIds.next, target_id: "third", type: "continues" },
            ],
          },
        }),
      ).toThrow(/status frozen conflicts with edge type continues/);
      expect(store.getTurn("turn-3")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("repairs a legacy open task chain once using done and continues metadata", () => {
    const root = tmpRoot();
    const sessionKey = "websocket:legacy-done-transition";
    const dbPath = sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: root });
    let store = new SessionDagStore({ sessionKey, dbPath });
    const ids = store.applyPatch({
      turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "add_node", temp_id: "old", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 },
          { op: "add_node", temp_id: "done", kind: "subtask", status: "done", title: "已完成", summary: "已有结果", importance: 70 },
          { op: "add_edge", source_id: "old", target_id: "done", type: "decomposes" },
        ],
      },
    }).nodeIds;
    insertLegacyTask(store, { id: "legacy-new-task", turnId: "turn-2", messageStart: 2, title: "新任务" });
    store.db.prepare("DELETE FROM dag_meta WHERE key='task_transition_repair_v1'").run();
    store.close();

    store = new SessionDagStore({ sessionKey, dbPath });
    const repaired = store.readGraphForHistoryDag();
    const repairedEdge = repaired.edges.find((edge) => edge.source_id === ids.old && edge.target_id === "legacy-new-task");
    expect(repaired.nodes.find((node) => node.id === ids.old)).toMatchObject({ status: "done", updated_by: "repair" });
    expect(repaired.nodes.find((node) => node.id === "legacy-new-task")).toMatchObject({ status: "active" });
    expect(repairedEdge).toMatchObject({ type: "continues", created_by: "repair", created_turn_id: "turn-2" });
    expect(store.getMeta("task_transition_repair_v1")).toBe("done");
    const edgeCount = repaired.edges.length;
    store.close();

    store = new SessionDagStore({ sessionKey, dbPath });
    expect(store.readGraphForHistoryDag().edges).toHaveLength(edgeCount);
    expect(store.readGraphForHistoryDag().activePathNodeIds[0]).toBe("legacy-new-task");
    store.close();
  });

  it("repairs an unfinished legacy task with frozen and supersedes", () => {
    const root = tmpRoot();
    const sessionKey = "websocket:legacy-frozen-transition";
    const dbPath = sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: root });
    let store = new SessionDagStore({ sessionKey, dbPath });
    const ids = store.applyPatch({
      turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "add_node", temp_id: "old", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 },
          { op: "add_node", temp_id: "open", kind: "subtask", status: "blocked", title: "未完成", summary: "仍被阻塞", importance: 70 },
          { op: "add_edge", source_id: "old", target_id: "open", type: "decomposes" },
        ],
      },
    }).nodeIds;
    insertLegacyTask(store, { id: "legacy-replacement", turnId: "turn-2", messageStart: 2, title: "替代任务" });
    store.db.prepare("DELETE FROM dag_meta WHERE key='task_transition_repair_v1'").run();
    store.close();

    store = new SessionDagStore({ sessionKey, dbPath });
    const repaired = store.readGraphForHistoryDag();
    expect(repaired.nodes.find((node) => node.id === ids.old)).toMatchObject({ status: "frozen", updated_by: "repair" });
    expect(repaired.edges).toContainEqual(expect.objectContaining({
      source_id: ids.old,
      target_id: "legacy-replacement",
      type: "supersedes",
      created_by: "repair",
    }));
    store.close();
  });

  it("leaves an existing valid task transition unchanged during legacy repair", () => {
    const root = tmpRoot();
    const sessionKey = "websocket:valid-legacy-transition";
    const dbPath = sessionDagDbPath(sessionKey, { MEMMY_AGENT_SESSION_DAG_DIR: root });
    let store = new SessionDagStore({ sessionKey, dbPath });
    const oldTaskId = store.applyPatch({
      turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
      buildMode: "llm_patch",
      patch: { ops: [{ op: "add_node", temp_id: "old", kind: "task", status: "active", title: "旧任务", summary: "旧任务", importance: 90 }] },
    }).nodeIds.old;
    const transition = store.applyPatch({
      turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
      buildMode: "llm_patch",
      patch: {
        ops: [
          { op: "update_node", node_id: oldTaskId, status: "done" },
          { op: "add_node", temp_id: "next", kind: "task", status: "active", title: "新任务", summary: "新任务", importance: 90 },
          { op: "add_edge", source_id: oldTaskId, target_id: "next", type: "continues" },
        ],
      },
    });
    const originalEdgeId = transition.edgeIds[0];
    store.db.prepare("DELETE FROM dag_meta WHERE key='task_transition_repair_v1'").run();
    store.close();

    store = new SessionDagStore({ sessionKey, dbPath });
    const graph = store.readGraphForHistoryDag();
    expect(graph.nodes.find((node) => node.id === oldTaskId)).toMatchObject({ status: "done", updated_by: "llm_patch" });
    expect(graph.edges.filter((edge) => edge.source_id === oldTaskId && edge.target_id === transition.nodeIds.next)).toEqual([
      expect.objectContaining({ id: originalEdgeId, type: "continues", created_by: "llm_patch" }),
    ]);
    expect(store.getMeta("task_transition_repair_v1")).toBe("done");
    store.close();
  });

  it("keeps the completed five-node path and its four edges identical for every consumer", () => {
    const store = makeStore("websocket:completed-path");
    try {
      const result = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 10 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "task", kind: "task", status: "active", title: "调整 maxTokens 配置", summary: "确认并修改模型 token 上限", importance: 95 },
            { op: "add_node", temp_id: "step1", kind: "subtask", status: "done", title: "定位配置文件", summary: "找到 config.yaml", importance: 70 },
            { op: "add_node", temp_id: "step2", kind: "decision", status: "done", title: "确认配置字段", summary: "确认 maxTokens 字段", importance: 75 },
            { op: "add_node", temp_id: "step3", kind: "subtask", status: "done", title: "核对生效范围", summary: "确认字段作用于当前模型", importance: 72 },
            { op: "add_node", temp_id: "step4", kind: "subtask", status: "done", title: "指导修改 config.yaml 中的 maxTokens 配置", summary: "给出确定修改方法", importance: 80 },
            { op: "add_edge", source_id: "task", target_id: "step1", type: "decomposes" },
            { op: "add_edge", source_id: "step1", target_id: "step2", type: "continues" },
            { op: "add_edge", source_id: "step2", target_id: "step3", type: "continues" },
            { op: "add_edge", source_id: "step3", target_id: "step4", type: "continues" },
          ],
        },
      });

      const expectedNodeIds = ["task", "step1", "step2", "step3", "step4"].map((key) => result.nodeIds[key]);
      const graph = store.readGraphForHistoryDag();
      const context = store.readBuilderContext(2);
      const snapshot = new DagSnapshotBuilder(store).build({ tokenBudget: 2000 });
      const payload = buildHistoryDagPayload(graph);

      expect(graph.activePathNodeIds).toEqual(expectedNodeIds);
      expect(graph.activePathEdgeIds).toEqual(result.edgeIds);
      expect(graph.activePathEdgeIds.map((edgeId) => {
        const edge = graph.edges.find((item) => item.id === edgeId)!;
        return [edge.source_id, edge.target_id];
      })).toEqual(expectedNodeIds.slice(0, -1).map((sourceId, index) => [sourceId, expectedNodeIds[index + 1]]));
      expect(context.active_path).toEqual(expectedNodeIds);
      expect(context.active_path_edges.map((edge) => edge.id)).toEqual(result.edgeIds);
      expect(context.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(expectedNodeIds));
      expect(snapshot.snapshot_json).toMatchObject({
        activePathNodeIds: expectedNodeIds,
        activePathEdgeIds: result.edgeIds,
      });
      expect(payload.activePathNodeIds).toEqual(expectedNodeIds);
      expect(payload.activePathEdgeIds).toEqual(result.edgeIds);
    } finally {
      store.close();
    }
  });

  it.each(["active", "paused", "blocked", "usage_limited", "budget_limited"] as const)(
    "locks an unfinished Goal task while status is %s",
    (status) => {
      const store = makeStore(`websocket:goal-lock-${status}`);
      try {
        const goal = goalContext("goal-1", status);
        const taskId = store.applyPatch({
          turn: { turn_id: "turn-1", message_start: 0, message_end: 2, goal_context: goal },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "add_node", temp_id: "goal-task", kind: "task", status: "active", title: "Goal", summary: "持续目标", importance: 95 }] },
        }).nodeIds["goal-task"];

        expect(store.readGraphForHistoryDag().nodes.find((node) => node.id === taskId)).toMatchObject({
          goal_id: "goal-1",
          status: "active",
        });
        expect(() => store.applyPatch({
          turn: { turn_id: "turn-2", message_start: 2, message_end: 4, goal_context: goal },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "update_node", node_id: taskId, status: "done" }] },
        })).toThrow(/Unfinished Goal turn cannot close its task/);
        expect(() => store.applyPatch({
          turn: { turn_id: "turn-3", message_start: 4, message_end: 6, goal_context: goal },
          buildMode: "llm_patch",
          patch: { ops: [{ op: "add_node", temp_id: "next-task", kind: "task", status: "active", title: "错误切换", summary: "不能切换", importance: 80 }] },
        })).toThrow(/cannot create a second task/);
        expect(store.getTurn("turn-2")).toBeNull();
        expect(store.getTurn("turn-3")).toBeNull();
      } finally {
        store.close();
      }
    },
  );

  it("completes a Goal task as done and then restores ordinary task transitions", () => {
    const store = makeStore("websocket:goal-complete-transition");
    try {
      const activeGoal = goalContext("goal-1", "active");
      const taskId = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2, goal_context: activeGoal },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "add_node", temp_id: "goal-task", kind: "task", status: "active", title: "Goal", summary: "完成目标", importance: 95 }] },
      }).nodeIds["goal-task"];

      expect(() => store.applyPatch({
        turn: { turn_id: "turn-bad", message_start: 2, message_end: 4, goal_context: goalContext("goal-1", "completed") },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "update_node", node_id: taskId, status: "failed" }] },
      })).toThrow(/only close its task as done/);

      store.applyPatch({
        turn: { turn_id: "turn-2", message_start: 2, message_end: 4, goal_context: goalContext("goal-1", "completed") },
        buildMode: "llm_patch",
        patch: { ops: [] },
      });
      expect(store.readGraphForHistoryDag().nodes.find((node) => node.id === taskId)?.status).toBe("done");

      const next = store.applyPatch({
        turn: { turn_id: "turn-3", message_start: 4, message_end: 6 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "next-task", kind: "task", status: "active", title: "普通任务", summary: "Goal 后的新问题", importance: 80 },
            { op: "add_edge", source_id: taskId, target_id: "next-task", type: "continues" },
          ],
        },
      });
      expect(store.readGraphForHistoryDag().edges).toContainEqual(expect.objectContaining({
        source_id: taskId,
        target_id: next.nodeIds["next-task"],
        type: "continues",
      }));
    } finally {
      store.close();
    }
  });

  it("freezes a cleared open Goal task before switching to an ordinary task", () => {
    const store = makeStore("websocket:goal-clear-transition");
    try {
      const taskId = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2, goal_context: goalContext("goal-1", "active") },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "add_node", temp_id: "goal-task", kind: "task", status: "active", title: "Goal", summary: "随后 Clear", importance: 95 }] },
      }).nodeIds["goal-task"];

      const next = store.applyPatch({
        turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "update_node", node_id: taskId, status: "frozen" },
            { op: "add_node", temp_id: "next-task", kind: "task", status: "active", title: "普通任务", summary: "Clear 后的新问题", importance: 80 },
            { op: "add_edge", source_id: taskId, target_id: "next-task", type: "supersedes" },
          ],
        },
      });
      const graph = store.readGraphForHistoryDag();
      expect(graph.nodes.find((node) => node.id === taskId)).toMatchObject({ status: "frozen", goal_id: "goal-1" });
      expect(graph.activePathNodeIds[0]).toBe(next.nodeIds["next-task"]);
    } finally {
      store.close();
    }
  });

  it("keeps a side_branch and all of its successors out of the Goal active path", () => {
    const store = makeStore("websocket:goal-side-branch");
    try {
      const result = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 8, goal_context: goalContext("goal-1", "active") },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "goal-task", kind: "task", status: "active", title: "Goal", summary: "主目标", importance: 95 },
            { op: "add_node", temp_id: "main", kind: "subtask", status: "active", title: "主路径", summary: "继续目标", importance: 60 },
            { op: "add_node", temp_id: "branch", kind: "decision", status: "blocked", title: "旁支", summary: "无关问题", importance: 100 },
            { op: "add_node", temp_id: "branch-next", kind: "subtask", status: "blocked", title: "旁支后继", summary: "仍属旁支", importance: 100 },
            { op: "add_edge", source_id: "goal-task", target_id: "main", type: "decomposes" },
            { op: "add_edge", source_id: "goal-task", target_id: "branch", type: "side_branch" },
            { op: "add_edge", source_id: "branch", target_id: "branch-next", type: "continues" },
          ],
        },
      });
      const graph = store.readGraphForHistoryDag();
      expect(graph.activePathNodeIds).toEqual([result.nodeIds["goal-task"], result.nodeIds.main]);
      expect(graph.activePathNodeIds).not.toContain(result.nodeIds.branch);
      expect(graph.activePathNodeIds).not.toContain(result.nodeIds["branch-next"]);
      expect(store.readBuilderContext(20).nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
        result.nodeIds.branch,
        result.nodeIds["branch-next"],
      ]));
    } finally {
      store.close();
    }
  });

  it("rejects a side_branch that does not start at the current Goal task and rolls back", () => {
    const store = makeStore("websocket:goal-side-branch-source");
    try {
      const first = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2, goal_context: goalContext("goal-1", "active") },
        buildMode: "llm_patch",
        patch: { ops: [{ op: "add_node", temp_id: "goal-task", kind: "task", status: "active", title: "Goal 1", summary: "第一个目标", importance: 95 }] },
      });
      store.applyPatch({
        turn: { turn_id: "turn-2", message_start: 2, message_end: 4, goal_context: goalContext("goal-1", "completed") },
        buildMode: "llm_patch",
        patch: { ops: [] },
      });
      const second = store.applyPatch({
        turn: { turn_id: "turn-3", message_start: 4, message_end: 6, goal_context: goalContext("goal-2", "active") },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "goal-task-2", kind: "task", status: "active", title: "Goal 2", summary: "第二个目标", importance: 95 },
            { op: "add_edge", source_id: first.nodeIds["goal-task"], target_id: "goal-task-2", type: "continues" },
          ],
        },
      });

      expect(() => store.applyPatch({
        turn: { turn_id: "turn-4", message_start: 6, message_end: 8, goal_context: goalContext("goal-2", "active") },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "branch", kind: "subtask", status: "done", title: "错误旁支", summary: "从旧 Goal 发出", importance: 40 },
            { op: "add_edge", source_id: first.nodeIds["goal-task"], target_id: "branch", type: "side_branch" },
          ],
        },
      })).toThrow(/current Goal task/);
      expect(store.getTurn("turn-4")).toBeNull();
      expect(store.readGraphForHistoryDag().nodes.map((node) => node.title)).not.toContain("错误旁支");
      expect(store.readGraphForHistoryDag().activePathNodeIds[0]).toBe(second.nodeIds["goal-task-2"]);
    } finally {
      store.close();
    }
  });

  it("selects the blocked frontier before an active branch inside the current task", () => {
    const nodes = [
      dagNode("task", "task", "active"),
      dagNode("active", "subtask", "active", { importance: 95 }),
      dagNode("blocked", "subtask", "blocked", { importance: 20 }),
    ];
    const edges = [
      dagEdge("edge-active", "task", "active", "decomposes"),
      dagEdge("edge-blocked", "task", "blocked", "decomposes"),
    ];

    expect(deriveActivePathSelection(nodes, edges)).toEqual({
      nodeIds: ["task", "blocked"],
      edgeIds: ["edge-blocked"],
    });
  });

  it("keeps path selection inside the chosen task subgraph", () => {
    const nodes = [
      dagNode("old-task", "task", "done", { updatedAt: "2026-07-10T10:00:00.000Z" }),
      dagNode("old-blocked", "subtask", "blocked", { importance: 100 }),
      dagNode("current-task", "task", "active", { updatedAt: "2026-07-10T09:00:00.000Z" }),
      dagNode("current-done", "subtask", "done", { lastMessageIndex: 20 }),
    ];
    const edges = [
      dagEdge("old-edge", "old-task", "old-blocked", "decomposes"),
      dagEdge("task-transition", "old-task", "current-task", "continues"),
      dagEdge("current-edge", "current-task", "current-done", "decomposes"),
    ];

    expect(deriveActivePathSelection(nodes, edges)).toEqual({
      nodeIds: ["current-task", "current-done"],
      edgeIds: ["current-edge"],
    });
  });

  it("backtracks through the progress chain and returns the exact parallel edge", () => {
    const nodes = [
      dagNode("task", "task", "active"),
      dagNode("previous", "subtask", "done"),
      dagNode("blocked", "subtask", "blocked"),
    ];
    const edges = [
      dagEdge("root-previous", "task", "previous", "decomposes"),
      dagEdge("root-blocked", "task", "blocked", "decomposes"),
      dagEdge("parallel-continues", "previous", "blocked", "continues"),
      dagEdge("parallel-blocks", "previous", "blocked", "blocks"),
    ];
    const selection = deriveActivePathSelection(nodes, edges);

    expect(selection).toEqual({
      nodeIds: ["task", "previous", "blocked"],
      edgeIds: ["root-previous", "parallel-blocks"],
    });
    expect(deriveActivePath(nodes, edges)).toEqual(selection.nodeIds);
  });

  it("renders only the active path and terminal task summaries in deterministic sections", () => {
    const graph: DagGraph = {
      sessionKey: "websocket:snapshot-projection",
      nodes: [
        dagNode("failed-child", "subtask", "failed", { importance: 100 }),
        dagNode("done-task", "task", "done", { importance: 90, updatedAt: "2026-07-10T09:00:00.000Z" }),
        dagNode("outside-active", "subtask", "active", { importance: 100 }),
        dagNode("active-task", "task", "active", { importance: 95 }),
        dagNode("frozen-child", "decision", "frozen", { importance: 100 }),
        dagNode("path-blocked", "subtask", "blocked", { importance: 82 }),
        dagNode("failed-task", "task", "failed", { importance: 80 }),
        dagNode("done-child", "decision", "done", { importance: 100 }),
        dagNode("frozen-task", "task", "frozen", { importance: 90, updatedAt: "2026-07-10T10:00:00.000Z" }),
        dagNode("path-decision", "decision", "done", { importance: 85 }),
      ],
      edges: [
        dagEdge("path-task-decision", "active-task", "path-decision", "decomposes"),
        dagEdge("path-decision-blocked", "path-decision", "path-blocked", "continues"),
        dagEdge("done-child-edge", "done-task", "done-child", "decomposes"),
        dagEdge("failed-child-edge", "failed-task", "failed-child", "decomposes"),
        dagEdge("frozen-child-edge", "frozen-task", "frozen-child", "decomposes"),
      ],
      activePathNodeIds: ["active-task", "path-decision", "path-blocked"],
      activePathEdgeIds: ["path-task-decision", "path-decision-blocked"],
    };

    const snapshot = buildDagSnapshotText(graph);

    expect(snapshot.text.match(/^[a-z_]+:$/gm)).toEqual([
      "current_active_path:",
      "completed_tasks:",
      "frozen_or_failed_tasks:",
    ]);
    expect(snapshot.text).not.toContain("frozen_or_failed_branches:");
    expect(snapshot.text).not.toContain("additional_important_nodes:");
    expect(snapshot.text.indexOf("active-task")).toBeLessThan(snapshot.text.indexOf("path-decision"));
    expect(snapshot.text.indexOf("path-decision")).toBeLessThan(snapshot.text.indexOf("path-blocked"));
    expect(snapshot.text).toContain("[task done importance=90] done-task");
    expect(snapshot.text).toContain("[task frozen importance=90] frozen-task");
    expect(snapshot.text).toContain("[task failed importance=80] failed-task");
    for (const excluded of ["done-child", "failed-child", "frozen-child", "outside-active"]) {
      expect(snapshot.text).not.toContain(excluded);
    }
    expect(snapshot.json).toEqual({
      sessionKey: graph.sessionKey,
      nodeIds: ["active-task", "path-decision", "path-blocked", "frozen-task", "done-task", "failed-task"],
      activePathNodeIds: graph.activePathNodeIds,
      activePathEdgeIds: graph.activePathEdgeIds,
    });
    expect(snapshot.tokenEstimate).toBe(estimateMessageTokens({ role: "system", content: snapshot.text }));
  });

  it("keeps snapshot node ids valid without changing the original active path metadata", () => {
    const graph: DagGraph = {
      sessionKey: "websocket:snapshot-dangling-path",
      nodes: [
        dagNode("terminal-on-path", "task", "failed"),
        dagNode("old-frozen", "task", "frozen", { importance: 60 }),
      ],
      edges: [],
      activePathNodeIds: ["missing-node", "terminal-on-path"],
      activePathEdgeIds: ["missing-edge"],
    };

    const snapshot = buildDagSnapshotText(graph);

    expect(snapshot.text).not.toContain("missing-node");
    expect(snapshot.text.match(/^- \[task failed importance=70\] terminal-on-path$/gm)).toHaveLength(1);
    expect(snapshot.json).toEqual({
      sessionKey: graph.sessionKey,
      nodeIds: ["terminal-on-path", "old-frozen"],
      activePathNodeIds: ["missing-node", "terminal-on-path"],
      activePathEdgeIds: ["missing-edge"],
    });
  });

  it("uses a global terminal-task ranking and stops at the first over-budget candidate", () => {
    const graph = snapshotRankingGraph();
    const firstAndShortCandidate: DagGraph = {
      ...graph,
      nodes: graph.nodes.filter((node) =>
        node.id === "active-task" || node.id === "done-high" || node.id === "failed-short",
      ),
    };
    const tokenBudget = buildDagSnapshotText(firstAndShortCandidate).tokenEstimate;

    const snapshot = buildDagSnapshotText(graph, tokenBudget);

    expect(snapshot.json.nodeIds).toEqual(["active-task", "done-high"]);
    expect(snapshot.text).toContain("done-high");
    expect(snapshot.text).not.toContain("frozen-new");
    expect(snapshot.text).not.toContain("failed-short");
    expect(buildDagSnapshotText(firstAndShortCandidate, tokenBudget).json.nodeIds).toEqual([
      "active-task",
      "done-high",
      "failed-short",
    ]);

    const activePathOverBudget = buildDagSnapshotText(graph, 1);
    expect(activePathOverBudget.json.nodeIds).toEqual(["active-task"]);
    expect(activePathOverBudget.tokenEstimate).toBeGreaterThan(1);
  });

  it.each([
    ["omitted", undefined],
    ["zero", 0],
    ["negative", -1],
  ])("includes every terminal task when the token budget is %s", (_label, tokenBudget) => {
    const snapshot = buildDagSnapshotText(snapshotRankingGraph(), tokenBudget);

    expect(snapshot.json.nodeIds).toEqual([
      "active-task",
      "done-high",
      "frozen-new",
      "done-old",
      "task-a",
      "task-b",
      "failed-short",
    ]);
  });

  it("does not enforce reachability when this patch adds no child node", () => {
    const store = makeStore();
    try {
      const ids = store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "task", kind: "task", status: "active", title: "任务", summary: "任务根", importance: 80 },
          ],
        },
      }).nodeIds;

      expect(() =>
        store.applyPatch({
          turn: { turn_id: "turn-2", message_start: 2, message_end: 4 },
          buildMode: "llm_patch",
          patch: {
            ops: [
              { op: "update_node", node_id: ids.task, title: "更新后的任务" },
            ],
          },
        }),
      ).not.toThrow();

      expect(store.readGraphForHistoryDag().nodes).toContainEqual(expect.objectContaining({ id: ids.task, title: "更新后的任务" }));
    } finally {
      store.close();
    }
  });

  it("renders history-dag summary, payload and snapshot from stored fields", () => {
    const store = makeStore("websocket:dag-render");
    try {
      store.applyPatch({
        turn: { turn_id: "turn-1", message_start: 0, message_end: 2 },
        buildMode: "llm_patch",
        patch: {
          ops: [
            { op: "add_node", temp_id: "task", kind: "task", status: "active", title: "设计 DAG", summary: "设计上下文 DAG", importance: 94 },
            { op: "add_node", temp_id: "decision", kind: "decision", status: "done", title: "证据不建节点", summary: "source_refs 只保存外部引用", importance: 82 },
            { op: "add_node", temp_id: "subtask", kind: "subtask", status: "blocked", title: "接压缩", summary: "等待 DAG 追平", importance: 88 },
            { op: "add_edge", source_id: "task", target_id: "decision", type: "decomposes" },
            { op: "add_edge", source_id: "decision", target_id: "subtask", type: "continues" },
          ],
        },
      });
      const snapshot = new DagSnapshotBuilder(store).build({ tokenBudget: 2000 });
      const graph = store.readGraphForHistoryDag();
      const payload = buildHistoryDagPayload(graph);
      const summary = renderHistoryDagSummary(graph);

      expect(snapshot.snapshot_text).toContain("[Working Memory DAG Snapshot]");
      expect(snapshot.snapshot_text).toContain("[task active importance=94] 设计 DAG");
      expect(summary).toContain("节点数：3");
      expect(summary).toContain("当前任务：设计 DAG");
      expect(payload).toMatchObject({
        sessionKey: "websocket:dag-render",
        activePathNodeIds: graph.activePathNodeIds,
        activePathEdgeIds: graph.activePathEdgeIds,
      });
      expect(payload.nodes).toHaveLength(3);
      expect(payload.edges).toHaveLength(2);
      expect(payload.edges[0]).toMatchObject({ source_id: expect.any(String), target_id: expect.any(String) });
    } finally {
      store.close();
    }
  });
});

function dagNode(
  id: string,
  kind: DagNode["kind"],
  status: DagNode["status"],
  options: { importance?: number; lastMessageIndex?: number; summary?: string; updatedAt?: string } = {},
): DagNode {
  const updatedAt = options.updatedAt ?? "2026-07-10T08:00:00.000Z";
  return {
    id,
    session_key: "websocket:path-test",
    kind,
    status,
    title: id,
    summary: options.summary ?? `${id} summary`,
    detail_json: {},
    importance: options.importance ?? 70,
    created_turn_id: "turn-1",
    updated_turn_id: "turn-1",
    first_message_index: 0,
    last_message_index: options.lastMessageIndex ?? 10,
    source_refs: [],
    created_by: "llm_patch",
    updated_by: "llm_patch",
    created_at: updatedAt,
    updated_at: updatedAt,
    goal_id: null,
  };
}

function goalContext(goalId: string, status: DagGoalContext["status"]): DagGoalContext {
  return { goalId, objective: `Objective for ${goalId}`, status };
}

function snapshotRankingGraph(): DagGraph {
  return {
    sessionKey: "websocket:snapshot-ranking",
    nodes: [
      dagNode("task-b", "task", "frozen", { importance: 85, updatedAt: "2026-07-10T08:30:00.000Z" }),
      dagNode("failed-short", "task", "failed", { importance: 80, summary: "x" }),
      dagNode("done-old", "task", "done", { importance: 90, updatedAt: "2026-07-10T09:00:00.000Z" }),
      dagNode("outside-decision", "decision", "done", { importance: 100 }),
      dagNode("active-task", "task", "active", { importance: 70 }),
      dagNode("task-a", "task", "done", { importance: 85, updatedAt: "2026-07-10T08:30:00.000Z" }),
      dagNode("frozen-new", "task", "frozen", {
        importance: 90,
        summary: "large terminal summary ".repeat(200),
        updatedAt: "2026-07-10T10:00:00.000Z",
      }),
      dagNode("done-high", "task", "done", { importance: 95 }),
    ],
    edges: [],
    activePathNodeIds: ["active-task"],
    activePathEdgeIds: [],
  };
}

function insertLegacyTask(
  store: SessionDagStore,
  options: { id: string; turnId: string; messageStart: number; title: string },
): void {
  store.upsertTurn({
    turn_id: options.turnId,
    message_start: options.messageStart,
    message_end: options.messageStart + 2,
  });
  const createdAt = new Date(Date.now() + options.messageStart * 1000).toISOString();
  store.db.prepare(
    `INSERT INTO dag_nodes (
      id, session_key, kind, status, title, summary, detail_json, importance,
      created_turn_id, updated_turn_id, first_message_index, last_message_index,
      source_refs_json, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'task', 'active', ?, ?, '{}', 90, ?, ?, ?, ?, '[]', 'llm_patch', 'llm_patch', ?, ?)`,
  ).run(
    options.id,
    store.sessionKey,
    options.title,
    `${options.title} summary`,
    options.turnId,
    options.turnId,
    options.messageStart,
    options.messageStart + 2,
    createdAt,
    createdAt,
  );
}

function dagEdge(
  id: string,
  sourceId: string,
  targetId: string,
  type: DagEdge["type"],
): DagEdge {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type,
    created_turn_id: "turn-1",
    created_by: "llm_patch",
    created_at: "2026-07-10T08:00:00.000Z",
  };
}
