import { estimateMessageTokens } from "../core/session/manager.js";
import { deriveActivePathSelection, SessionDagStore } from "./store.js";
import type { DagGraph, DagNode, DagSnapshotRecord } from "./types.js";

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
  for (const id of graph.activePathNodeIds) {
    if (nodesById.has(id)) selected.add(id);
  }

  const ranked = graph.nodes
    .filter((node) =>
      !selected.has(node.id)
      && node.kind === "task"
      && (node.status === "done" || node.status === "failed" || node.status === "frozen"),
    )
    .sort(byImportance);
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
  return selected;
}

function renderSnapshotText(graph: DagGraph, selected: Set<string>): string {
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const activePath = graph.activePathNodeIds
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is DagNode => node != null)
    .filter((node) => selected.has(node.id));
  const activeIds = new Set(activePath.map((node) => node.id));
  const completedTasks = nodes
    .filter((node) => node.kind === "task" && node.status === "done" && !activeIds.has(node.id))
    .sort(byImportance);
  const frozenOrFailedTasks = nodes
    .filter((node) =>
      node.kind === "task"
      && (node.status === "failed" || node.status === "frozen")
      && !activeIds.has(node.id),
    )
    .sort(byImportance);

  const lines = ["[Working Memory DAG Snapshot]", "", "current_active_path:"];
  if (activePath.length) appendNodeList(lines, activePath, "  ");
  else lines.push("- (none)");

  lines.push("", "completed_tasks:");
  if (completedTasks.length) appendNodeList(lines, completedTasks, "  ");
  else lines.push("- (none)");

  lines.push("", "frozen_or_failed_tasks:");
  if (frozenOrFailedTasks.length) appendNodeList(lines, frozenOrFailedTasks, "  ");
  else lines.push("- (none)");

  return lines.join("\n");
}

function appendNodeList(lines: string[], nodes: DagNode[], indent: string): void {
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
  return right.importance - left.importance
    || compareStrings(String(right.updated_at), String(left.updated_at))
    || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function refreshGraphActivePath(graph: Omit<DagGraph, "activePathNodeIds" | "activePathEdgeIds">): DagGraph {
  const activePath = deriveActivePathSelection(graph.nodes, graph.edges);
  return { ...graph, activePathNodeIds: activePath.nodeIds, activePathEdgeIds: activePath.edgeIds };
}
