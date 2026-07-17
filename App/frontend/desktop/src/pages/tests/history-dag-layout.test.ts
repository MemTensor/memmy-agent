import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import type { HistoryDagPayload } from "../../api/memmy-agent-client.js";
import { TASK_SOURCE_BOTTOM_HANDLE, TASK_TARGET_TOP_HANDLE, layoutHistoryDag } from "../history-dag-layout.js";

describe("layoutHistoryDag", () => {
  it("lays out separate tasks on separate horizontal lanes", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "active"),
      subtask("subtask-1", "active"),
      task("task-2", "active"),
      subtask("subtask-2", "active")
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "task-2", "subtask-2", "decomposes")
    ]));

    const task1 = layout.nodes.find((node) => node.id === "task-1");
    const subtask1 = layout.nodes.find((node) => node.id === "subtask-1");
    const task2 = layout.nodes.find((node) => node.id === "task-2");
    const subtask2 = layout.nodes.find((node) => node.id === "subtask-2");

    expect(subtask1?.position.x).toBeGreaterThan(task1?.position.x ?? 0);
    expect(subtask2?.position.x).toBeGreaterThan(task2?.position.x ?? 0);
    expect(task2?.position.y).toBeGreaterThan(task1?.position.y ?? 0);
    expect(subtask2?.position.y).toBeGreaterThan(subtask1?.position.y ?? 0);
  });

  it("derives a visual finish node for a done task without mutating the payload", () => {
    const payload = historyDagPayload([
      task("task-1", "done"),
      subtask("subtask-1", "done", 55)
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes")
    ]);

    const layout = layoutHistoryDag(payload);

    expect(payload.nodes.map((node) => node.id)).toEqual(["task-1", "subtask-1"]);
    expect(layout.nodes.find((node) => node.id === "finish:task-1")?.type).toBe("finish");
    expect(layout.edges).toContainEqual(expect.objectContaining({
      id: "finish-edge:task-1",
      source: "subtask-1",
      target: "finish:task-1",
      type: "default"
    }));
  });

  it("anchors the finish node to the terminal done descendant instead of the highest-importance descendant", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "done"),
      subtask("subtask-1", "done", 40),
      subtask("subtask-2", "done", 95),
      subtask("subtask-3", "done", 20)
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "subtask-1", "subtask-2", "continues"),
      edge("edge-3", "subtask-2", "subtask-3", "continues")
    ]));

    const finishEdge = layout.edges.find((item) => item.id === "finish-edge:task-1");
    const finishNode = layout.nodes.find((node) => node.id === "finish:task-1");
    const terminalSubtask = layout.nodes.find((node) => node.id === "subtask-3");

    expect(finishEdge).toEqual(expect.objectContaining({
      source: "subtask-3",
      target: "finish:task-1"
    }));
    expect(finishNode?.position.x).toBeGreaterThan(terminalSubtask?.position.x ?? 0);
  });

  it("keeps a completed task finish anchor inside that task instead of the next task graph", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "done"),
      subtask("subtask-1", "done", 30),
      task("task-2", "active"),
      subtask("subtask-2", "done", 100)
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "task-1", "task-2", "continues"),
      edge("edge-3", "task-2", "subtask-2", "decomposes")
    ]));

    expect(layout.edges).toContainEqual(expect.objectContaining({
      id: "finish-edge:task-1",
      source: "subtask-1",
      target: "finish:task-1"
    }));
  });

  it("places the finish node in the first free column to the right of its anchor", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "done"),
      subtask("subtask-1", "done"),
      subtask("subtask-2", "active")
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "subtask-1", "subtask-2", "continues")
    ]));
    const finishNode = layout.nodes.find((node) => node.id === "finish:task-1");
    const anchorNode = layout.nodes.find((node) => node.id === "subtask-1");

    expect(finishNode?.position.x).toBeGreaterThan(anchorNode?.position.x ?? 0);
    expect(layout.nodes.some((node) => (
      node.id !== finishNode?.id
      && node.position.x === finishNode?.position.x
      && node.position.y === finishNode?.position.y
    ))).toBe(false);
  });

  it("uses the legacy node-pair fallback for active path classes when edge ids are absent", () => {
    const layout = layoutHistoryDag({
      ...historyDagPayload([
        task("task-1", "active"),
        subtask("subtask-1", "active")
      ], [
        edge("edge-1", "task-1", "subtask-1", "decomposes")
      ]),
      activePathNodeIds: ["task-1", "subtask-1"]
    });

    const taskNode = layout.nodes.find((node) => node.id === "task-1");
    const subtaskNode = layout.nodes.find((node) => node.id === "subtask-1");
    const activeEdge = layout.edges.find((edge) => edge.id === "edge-1");

    expect(taskNode?.className).toContain("history-dag-node-active-path");
    expect(taskNode?.type).toBe("historyDag");
    expect(taskNode?.sourcePosition).toBe(Position.Right);
    expect(taskNode?.targetPosition).toBe(Position.Left);
    expect(subtaskNode?.className).toContain("history-dag-node-active-path");
    expect(activeEdge?.type).toBe("default");
    expect(activeEdge?.animated).toBe(true);
    expect(activeEdge?.className).toContain("history-dag-edge-active-path");
    expect(activeEdge?.sourceHandle).toBeUndefined();
    expect(activeEdge?.targetHandle).toBeUndefined();
  });

  it("highlights only the exact active edge when parallel edges share both endpoints", () => {
    const layout = layoutHistoryDag({
      ...historyDagPayload([
        task("task-1", "active"),
        subtask("subtask-previous", "done"),
        subtask("subtask-1", "blocked")
      ], [
        edge("edge-root", "task-1", "subtask-previous", "decomposes"),
        edge("edge-continues", "subtask-previous", "subtask-1", "continues"),
        edge("edge-blocks", "subtask-previous", "subtask-1", "blocks")
      ]),
      activePathNodeIds: ["task-1", "subtask-previous", "subtask-1"],
      activePathEdgeIds: ["edge-root", "edge-blocks"]
    });

    const continuesEdge = layout.edges.find((edge) => edge.id === "edge-continues");
    const blocksEdge = layout.edges.find((edge) => edge.id === "edge-blocks");
    expect(continuesEdge?.animated).toBe(false);
    expect(continuesEdge?.className ?? "").not.toContain("history-dag-edge-active-path");
    expect(blocksEdge?.animated).toBe(true);
    expect(blocksEdge?.className).toContain("history-dag-edge-active-path");
  });

  it("does not use the legacy node-pair fallback when active edge ids are explicitly empty", () => {
    const layout = layoutHistoryDag({
      ...historyDagPayload([
        task("task-1", "active"),
        subtask("subtask-1", "active")
      ], [
        edge("edge-1", "task-1", "subtask-1", "decomposes")
      ]),
      activePathNodeIds: ["task-1", "subtask-1"],
      activePathEdgeIds: []
    });

    const edgeItem = layout.edges.find((edge) => edge.id === "edge-1");
    expect(edgeItem?.animated).toBe(false);
    expect(edgeItem?.className ?? "").not.toContain("history-dag-edge-active-path");
  });

  it("connects task transitions from bottom to top handles without changing normal edges", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "done"),
      task("task-2", "active"),
      subtask("subtask-1", "done")
    ], [
      edge("edge-task", "task-1", "task-2", "continues"),
      edge("edge-subtask", "task-2", "subtask-1", "decomposes")
    ]));

    const taskEdge = layout.edges.find((edge) => edge.id === "edge-task");
    const subtaskEdge = layout.edges.find((edge) => edge.id === "edge-subtask");

    expect(taskEdge?.sourceHandle).toBe(TASK_SOURCE_BOTTOM_HANDLE);
    expect(taskEdge?.targetHandle).toBe(TASK_TARGET_TOP_HANDLE);
    expect(taskEdge?.type).toBe("default");
    expect(subtaskEdge?.sourceHandle).toBeUndefined();
    expect(subtaskEdge?.targetHandle).toBeUndefined();
  });

  it("keeps branch nodes at the same depth on separate rows", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "active"),
      subtask("subtask-1", "active"),
      subtask("subtask-2", "blocked")
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "task-1", "subtask-2", "decomposes")
    ]));

    const subtask1 = layout.nodes.find((node) => node.id === "subtask-1");
    const subtask2 = layout.nodes.find((node) => node.id === "subtask-2");

    expect(subtask1?.position.x).toBe(subtask2?.position.x);
    expect(subtask1?.position.y).not.toBe(subtask2?.position.y);
  });

  it("keeps the true graph width for horizontally scrolling wide DAGs", () => {
    const layout = layoutHistoryDag(historyDagPayload([
      task("task-1", "active"),
      subtask("subtask-1", "done"),
      subtask("subtask-2", "done"),
      subtask("subtask-3", "active")
    ], [
      edge("edge-1", "task-1", "subtask-1", "decomposes"),
      edge("edge-2", "subtask-1", "subtask-2", "continues"),
      edge("edge-3", "subtask-2", "subtask-3", "continues")
    ]));

    const lastSubtask = layout.nodes.find((node) => node.id === "subtask-3");

    expect(lastSubtask?.position.x).toBeGreaterThan(720);
    expect(layout.width).toBeGreaterThan(1000);
  });
});

function historyDagPayload(nodes: HistoryDagPayload["nodes"], edges: HistoryDagPayload["edges"]): HistoryDagPayload {
  return {
    sessionKey: "websocket:chat-1",
    nodes,
    edges,
    activePathNodeIds: [],
    snapshotText: ""
  };
}

function task(id: string, status: HistoryDagPayload["nodes"][number]["status"], importance = 70): HistoryDagPayload["nodes"][number] {
  return node(id, "task", status, importance);
}

function subtask(id: string, status: HistoryDagPayload["nodes"][number]["status"], importance = 70): HistoryDagPayload["nodes"][number] {
  return node(id, "subtask", status, importance);
}

function node(
  id: string,
  kind: HistoryDagPayload["nodes"][number]["kind"],
  status: HistoryDagPayload["nodes"][number]["status"],
  importance: number
): HistoryDagPayload["nodes"][number] {
  return {
    id,
    kind,
    status,
    title: id,
    summary: `${id} summary`,
    importance,
    createdBy: "llm_patch",
    updatedBy: "llm_patch",
    sourceRefs: []
  };
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  type: HistoryDagPayload["edges"][number]["type"]
): HistoryDagPayload["edges"][number] {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type,
    createdBy: "llm_patch"
  };
}
