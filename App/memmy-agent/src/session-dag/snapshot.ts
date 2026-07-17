import { estimateMessageTokens } from "../core/session/manager.js";
import { deriveActivePathSelection, selectRootTask, SessionDagStore } from "./store.js";
import type { DagEdge, DagGraph, DagNode, DagSnapshotRecord } from "./types.js";

export type DagSnapshotBuildOptions = {
  tokenBudget?: number;
  turnId?: string | null;
};

export class DagSnapshotBuilder {
  constructor(private readonly store: SessionDagStore) {}

  build(options: DagSnapshotBuildOptions = {}): DagSnapshotRecord {
    const graph = this.store.readGraphForHistoryDag();
    const snapshot = buildDagSnapshotText(graph, options.tokenBudget);
    return this.store.createSnapshot(
      options.turnId ?? this.store.getMeta("last_processed_turn_id"),
      snapshot.text,
      snapshot.json,
      snapshot.tokenEstimate,
    );
  }
}

export function buildDagSnapshotText(graph: DagGraph, tokenBudget?: number): { text: string; json: Record<string, unknown>; tokenEstimate: number } {
  const selected = selectSnapshotNodes(graph, tokenBudget);
  const text = renderSnapshotText(graph, selected);
  return {
    text,
    json: {
      sessionKey: graph.sessionKey,
      nodeIds: [...selected],
      activePathNodeIds: graph.activePathNodeIds,
      activePathEdgeIds: graph.activePathEdgeIds,
    },
    tokenEstimate: estimateMessageTokens({ role: "system", content: text }),
  };
}

function selectSnapshotNodes(graph: DagGraph, tokenBudget?: number): Set<string> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = new Set<string>();
  const root = selectRootTask(graph.nodes);
  if (root) selected.add(root.id);
  for (const id of graph.activePathNodeIds) selected.add(id);
  for (const node of graph.nodes) {
    if (node.status === "active" || node.status === "blocked") selected.add(node.id);
  }
  for (const node of graph.nodes) {
    if (node.status === "failed" || node.status === "frozen") selected.add(node.id);
  }
  const ranked = graph.nodes
    .filter((node) => !selected.has(node.id))
    .sort((left, right) => right.importance - left.importance || String(right.updated_at).localeCompare(String(left.updated_at)));
  for (const node of ranked) {
    selected.add(node.id);
    if (tokenBudget && tokenBudget > 0) {
      const text = renderSnapshotText(graph, selected);
      const estimate = estimateMessageTokens({ role: "system", content: text });
      if (estimate > tokenBudget) {
        selected.delete(node.id);
        break;
      }
    }
  }
  for (const id of [...selected]) {
    if (!nodesById.has(id)) selected.delete(id);
  }
  return selected;
}

function renderSnapshotText(graph: DagGraph, selected: Set<string>): string {
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const activePath = graph.activePathNodeIds
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is DagNode => node != null)
    .filter((node) => selected.has(node.id));
  const completedTasks = nodes
    .filter((node) => node.kind === "task" && node.status === "done" && !activePath.some((item) => item.id === node.id))
    .sort(byImportance);
  const failedOrFrozen = nodes
    .filter((node) => node.status === "failed" || node.status === "frozen")
    .sort(byImportance);
  const activeIds = new Set(activePath.map((node) => node.id));
  const additional = nodes
    .filter((node) => !activeIds.has(node.id) && node.kind !== "task" && node.status !== "failed" && node.status !== "frozen")
    .sort(byImportance);

  const lines = ["[Working Memory DAG Snapshot]", "", "current_active_path:"];
  if (activePath.length) appendNodeList(lines, activePath, graph.edges, "  ");
  else lines.push("- (none)");

  lines.push("", "completed_tasks:");
  if (completedTasks.length) appendNodeList(lines, completedTasks, graph.edges, "  ");
  else lines.push("- (none)");

  lines.push("", "frozen_or_failed_branches:");
  if (failedOrFrozen.length) appendNodeList(lines, failedOrFrozen, graph.edges, "  ");
  else lines.push("- (none)");

  lines.push("", "additional_important_nodes:");
  if (additional.length) appendNodeList(lines, additional, graph.edges, "  ");
  else lines.push("- (none)");

  return lines.join("\n");
}

function appendNodeList(lines: string[], nodes: DagNode[], edges: DagEdge[], indent: string): void {
  void edges;
  for (const node of nodes) {
    lines.push(`- [${node.kind} ${node.status} importance=${node.importance}] ${node.title}`);
    lines.push(`${indent}summary: ${node.summary}`);
    if (node.source_refs.length) {
      lines.push(`${indent}refs:`);
      for (const ref of node.source_refs) {
        if (ref.type === "file") lines.push(`${indent}- file ${ref.path}${ref.line ? `:${ref.line}` : ""}`);
        else if (ref.type === "artifact") lines.push(`${indent}- artifact ${ref.artifact_path}`);
        else lines.push(`${indent}- url ${ref.url}`);
      }
    }
  }
}

function byImportance(left: DagNode, right: DagNode): number {
  return right.importance - left.importance || String(right.updated_at).localeCompare(String(left.updated_at));
}

export function refreshGraphActivePath(graph: Omit<DagGraph, "activePathNodeIds" | "activePathEdgeIds">): DagGraph {
  const activePath = deriveActivePathSelection(graph.nodes, graph.edges);
  return { ...graph, activePathNodeIds: activePath.nodeIds, activePathEdgeIds: activePath.edgeIds };
}
