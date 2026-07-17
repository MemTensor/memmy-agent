import type { DagGraph, HistoryDagPayload } from "./types.js";

export const HISTORY_DAG_AGENT_UI_KEY = "agentUi";

export function buildHistoryDagPayload(graph: DagGraph): HistoryDagPayload {
  return {
    sessionKey: graph.sessionKey,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      status: node.status,
      title: node.title,
      summary: node.summary,
      importance: node.importance,
      createdBy: node.created_by,
      updatedBy: node.updated_by,
      sourceRefs: node.source_refs,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      type: edge.type,
      createdBy: edge.created_by,
    })),
    activePathNodeIds: graph.activePathNodeIds,
    activePathEdgeIds: graph.activePathEdgeIds,
    snapshotText: graph.snapshotText ?? "",
  };
}

export function renderHistoryDagSummary(graph: DagGraph): string {
  const currentTask = graph.activePathNodeIds
    .map((id) => graph.nodes.find((node) => node.id === id))
    .find((node) => node?.kind === "task");
  const fallbackTask = graph.nodes
    .filter((node) => node.kind === "task" && node.status !== "frozen")
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
  const task = currentTask ?? fallbackTask;
  if (!graph.nodes.length) {
    return [
      "摘要：当前 session 还没有已生成的 DAG。",
      "节点数：0",
      "边数：0",
      "当前任务：无",
      "激活路径节点数：0",
      "",
      "完整 DAG、节点详情、边和证据请在 GUI 中查看。",
    ].join("\n");
  }
  return [
    "摘要：当前 session 已生成 DAG。",
    `节点数：${graph.nodes.length}`,
    `边数：${graph.edges.length}`,
    `当前任务：${task?.title ?? "无"}`,
    `激活路径节点数：${graph.activePathNodeIds.length}`,
    "",
    "完整 DAG、节点详情、边和证据请在 GUI 中查看。",
  ].join("\n");
}
