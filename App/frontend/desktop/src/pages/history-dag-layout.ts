import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { HistoryDagPayload, HistoryDagPayloadNode } from "../api/memmy-agent-client.js";

export type HistoryDagLayout = {
  nodes: HistoryDagLayoutNode[];
  edges: Edge[];
  width: number;
  height: number;
};

export type HistoryDagNodeData = HistoryDagPayloadNode & Record<string, unknown>;

export type FinishNodeData = {
  id: string;
  kind: "finish";
  status: "done";
  title: string;
  summary: string;
  importance: number;
  sourceRefs: [];
};

export type HistoryDagFlowNode = Node<HistoryDagNodeData, "historyDag">;
export type HistoryDagFinishFlowNode = Node<FinishNodeData, "finish">;
export type HistoryDagLayoutNode = HistoryDagFlowNode | HistoryDagFinishFlowNode;

export type HistoryDagLayoutOptions = {
  finishTitle?: string;
};

type DoneTaskAnchorCandidate = {
  node: HistoryDagPayloadNode;
  distance: number;
  terminal: boolean;
};

export const TASK_SOURCE_BOTTOM_HANDLE = "task-source-bottom";
export const TASK_TARGET_TOP_HANDLE = "task-target-top";

const NODE_WIDTH = 236;
const NODE_HEIGHT = 86;
const X_GAP = 104;
const ROW_GAP = 28;
const LANE_GAP = 76;
const LEFT = 32;
const TOP = 28;
const FINISH_NODE_WIDTH = 88;
const FINISH_NODE_HEIGHT = 44;

export function layoutHistoryDag(payload: HistoryDagPayload, options: HistoryDagLayoutOptions = {}): HistoryDagLayout {
  const nodesById = new Map(payload.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of payload.edges) {
    if (!nodesById.has(edge.source_id) || !nodesById.has(edge.target_id)) continue;
    const childList = children.get(edge.source_id) ?? [];
    childList.push(edge.target_id);
    children.set(edge.source_id, childList);
    const parentList = incoming.get(edge.target_id) ?? [];
    parentList.push(edge.source_id);
    incoming.set(edge.target_id, parentList);
  }

  const tasks = payload.nodes.filter((node) => node.kind === "task");
  const initialRoots = tasks.length ? tasks : payload.nodes.filter((node) => !incoming.has(node.id)).slice(0, 1);
  const depthByNode = new Map<string, number>();
  const rowByNode = new Map<string, number>();
  const yByNode = new Map<string, number>();
  const assigned = new Set<string>();
  const payloadOrder = new Map(payload.nodes.map((node, index) => [node.id, index]));
  const taskIds = new Set(tasks.map((node) => node.id));
  let laneTop = TOP;

  const roots = initialRoots.length ? initialRoots : payload.nodes.slice(0, 1);
  for (const root of roots) {
    laneTop = layoutComponent(root.id, laneTop, children, incoming, payloadOrder, taskIds, assigned, depthByNode, rowByNode, yByNode);
  }
  for (const node of payload.nodes) {
    if (assigned.has(node.id)) continue;
    laneTop = layoutComponent(node.id, laneTop, children, incoming, payloadOrder, taskIds, assigned, depthByNode, rowByNode, yByNode);
  }

  const activePath = new Set(payload.activePathNodeIds);
  const flowNodes: HistoryDagLayoutNode[] = payload.nodes.map((node) => {
    const depth = depthByNode.get(node.id) ?? 0;
    return {
      id: node.id,
      type: "historyDag",
      position: {
        x: LEFT + depth * (NODE_WIDTH + X_GAP),
        y: yByNode.get(node.id) ?? TOP
      },
      data: node as HistoryDagNodeData,
      draggable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      className: nodeClassName(node, activePath.has(node.id)),
      style: {
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      }
    };
  });

  const activePathPairs = new Set(
    payload.activePathNodeIds
      .slice(0, -1)
      .map((source, index) => `${source}->${payload.activePathNodeIds[index + 1]}`)
  );
  const activePathEdgeIds = payload.activePathEdgeIds === undefined
    ? null
    : new Set(payload.activePathEdgeIds);
  const flowEdges: Edge[] = payload.edges.map((edge) => {
    const active = activePathEdgeIds
      ? activePathEdgeIds.has(edge.id)
      : activePathPairs.has(`${edge.source_id}->${edge.target_id}`);
    const isTaskTransition = isTaskTransitionEdge(edge, nodesById);
    return {
      id: edge.id,
      source: edge.source_id,
      target: edge.target_id,
      sourceHandle: isTaskTransition ? TASK_SOURCE_BOTTOM_HANDLE : undefined,
      targetHandle: isTaskTransition ? TASK_TARGET_TOP_HANDLE : undefined,
      type: "default",
      animated: active,
      className: edgeClassName(edge.type, active),
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        strokeWidth: edge.type === "blocks" || edge.type === "supersedes" ? 1.6 : 2,
        strokeDasharray: edge.type === "supersedes" ? "5 5" : undefined
      }
    };
  });

  for (const task of tasks.filter((node) => node.status === "done")) {
    const anchor = doneTaskAnchor(task, payload.nodes, payload.edges, payloadOrder) ?? task;
    const depth = finishDepthForAnchor(anchor, flowNodes, depthByNode, yByNode);
    const finishId = `finish:${task.id}`;
    flowNodes.push({
      id: finishId,
      type: "finish",
      position: {
        x: LEFT + depth * (NODE_WIDTH + X_GAP),
        y: yByNode.get(anchor.id) ?? yByNode.get(task.id) ?? TOP
      },
      data: {
        id: finishId,
        kind: "finish",
        status: "done",
        title: options.finishTitle ?? "Finished",
        summary: task.summary,
        importance: task.importance,
        sourceRefs: []
      },
      draggable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      className: "history-dag-node history-dag-node-finish",
      style: { width: FINISH_NODE_WIDTH, height: FINISH_NODE_HEIGHT }
    });
    flowEdges.push({
      id: `finish-edge:${task.id}`,
      source: anchor.id,
      target: finishId,
      type: "default",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: "history-dag-edge-finish",
      selectable: false
    });
  }

  const maxX = flowNodes.reduce((max, node) => Math.max(max, node.position.x + nodeWidth(node)), NODE_WIDTH);
  const maxY = flowNodes.reduce((max, node) => Math.max(max, node.position.y + nodeHeight(node)), NODE_HEIGHT);
  return {
    nodes: flowNodes,
    edges: flowEdges,
    width: Math.max(720, maxX + LEFT),
    height: Math.max(360, maxY + TOP)
  };
}

function layoutComponent(
  rootId: string,
  laneTop: number,
  children: Map<string, string[]>,
  incoming: Map<string, string[]>,
  payloadOrder: Map<string, number>,
  taskIds: Set<string>,
  assigned: Set<string>,
  depthByNode: Map<string, number>,
  rowByNode: Map<string, number>,
  yByNode: Map<string, number>
): number {
  const component = reachableFrom(rootId, children, taskIds, assigned);
  if (!component.size) return laneTop;

  const localDepth = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const depth = localDepth.get(id) ?? 0;
    for (const childId of children.get(id) ?? []) {
      if (!component.has(childId)) continue;
      const nextDepth = depth + 1;
      if (nextDepth > (localDepth.get(childId) ?? -1)) {
        localDepth.set(childId, nextDepth);
        queue.push(childId);
      }
    }
  }

  const ids = [...component].sort((left, right) => {
    const depthDiff = (localDepth.get(left) ?? 0) - (localDepth.get(right) ?? 0);
    if (depthDiff !== 0) return depthDiff;
    return (payloadOrder.get(left) ?? 0) - (payloadOrder.get(right) ?? 0);
  });
  const occupiedRowsByDepth = new Map<number, Set<number>>();
  let maxRow = 0;

  for (const id of ids) {
    const depth = localDepth.get(id) ?? 0;
    const occupiedRows = occupiedRowsByDepth.get(depth) ?? new Set<number>();
    occupiedRowsByDepth.set(depth, occupiedRows);
    const parentRows = (incoming.get(id) ?? [])
      .map((parentId) => rowByNode.get(parentId))
      .filter((row): row is number => row != null);
    const preferredRow = parentRows.length ? Math.min(...parentRows) : 0;
    let row = preferredRow;
    while (occupiedRows.has(row)) row += 1;
    occupiedRows.add(row);
    maxRow = Math.max(maxRow, row);
    assigned.add(id);
    depthByNode.set(id, depth);
    rowByNode.set(id, row);
    yByNode.set(id, laneTop + row * (NODE_HEIGHT + ROW_GAP));
  }

  return laneTop + (maxRow + 1) * (NODE_HEIGHT + ROW_GAP) + LANE_GAP;
}

function reachableFrom(rootId: string, children: Map<string, string[]>, taskIds: Set<string>, assigned: Set<string>): Set<string> {
  const reachable = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (assigned.has(id) || reachable.has(id)) continue;
    reachable.add(id);
    for (const childId of children.get(id) ?? []) {
      if (taskIds.has(childId) && childId !== rootId) continue;
      queue.push(childId);
    }
  }
  return reachable;
}

function doneTaskAnchor(
  task: HistoryDagPayloadNode,
  nodes: HistoryDagPayloadNode[],
  edges: HistoryDagPayload["edges"],
  payloadOrder: Map<string, number>
): HistoryDagPayloadNode | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const superseded = new Set(edges.filter((edge) => edge.type === "supersedes").map((edge) => edge.source_id));
  const childMap = new Map<string, string[]>();
  for (const edge of edges) {
    const list = childMap.get(edge.source_id) ?? [];
    list.push(edge.target_id);
    childMap.set(edge.source_id, list);
  }
  const distanceById = new Map<string, number>();
  const queue = (childMap.get(task.id) ?? []).map((id) => ({ id, distance: 1 }));
  const maxDistance = nodes.length;
  while (queue.length) {
    const { id, distance } = queue.shift()!;
    if (distance > maxDistance || distance <= (distanceById.get(id) ?? 0)) continue;
    const node = nodesById.get(id);
    if (!node) continue;
    if (node.kind === "task") continue;
    distanceById.set(id, distance);
    for (const childId of childMap.get(id) ?? []) {
      queue.push({ id: childId, distance: distance + 1 });
    }
  }

  const candidates: DoneTaskAnchorCandidate[] = [];
  for (const [id, distance] of distanceById) {
    const node = nodesById.get(id);
    if (!node || node.status !== "done" || superseded.has(node.id)) continue;
    const terminal = !(childMap.get(node.id) ?? []).some((childId) => {
      const child = nodesById.get(childId);
      return child && child.kind !== "task" && distanceById.has(childId) && !superseded.has(childId);
    });
    candidates.push({ node, distance, terminal });
  }

  const pool = candidates.some((candidate) => candidate.terminal)
    ? candidates.filter((candidate) => candidate.terminal)
    : candidates;
  return pool.sort((left, right) => {
    const distance = right.distance - left.distance;
    if (distance !== 0) return distance;
    const order = (payloadOrder.get(right.node.id) ?? 0) - (payloadOrder.get(left.node.id) ?? 0);
    if (order !== 0) return order;
    return right.node.importance - left.node.importance;
  })[0]?.node ?? null;
}

function finishDepthForAnchor(
  anchor: HistoryDagPayloadNode,
  flowNodes: HistoryDagLayoutNode[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>
): number {
  const anchorY = yByNode.get(anchor.id) ?? TOP;
  let depth = (depthByNode.get(anchor.id) ?? 0) + 1;
  while (flowNodes.some((node) => node.position.x === LEFT + depth * (NODE_WIDTH + X_GAP) && node.position.y === anchorY)) {
    depth += 1;
  }
  return depth;
}

function isTaskTransitionEdge(edge: HistoryDagPayload["edges"][number], nodesById: Map<string, HistoryDagPayloadNode>): boolean {
  return nodesById.get(edge.source_id)?.kind === "task" && nodesById.get(edge.target_id)?.kind === "task";
}

function nodeClassName(node: HistoryDagPayloadNode, active: boolean): string {
  return [
    "history-dag-node",
    `history-dag-node-${node.kind}`,
    `history-dag-node-status-${node.status}`,
    active ? "history-dag-node-active-path" : ""
  ].filter(Boolean).join(" ");
}

function edgeClassName(type: HistoryDagPayload["edges"][number]["type"], active: boolean): string | undefined {
  return [
    type === "supersedes" ? "history-dag-edge-supersedes" : "",
    type === "blocks" ? "history-dag-edge-blocks" : "",
    active ? "history-dag-edge-active-path" : ""
  ].filter(Boolean).join(" ") || undefined;
}

function nodeWidth(node: HistoryDagLayoutNode): number {
  return Number(node.style?.width ?? (node.type === "finish" ? FINISH_NODE_WIDTH : NODE_WIDTH));
}

function nodeHeight(node: HistoryDagLayoutNode): number {
  return Number(node.style?.height ?? (node.type === "finish" ? FINISH_NODE_HEIGHT : NODE_HEIGHT));
}
