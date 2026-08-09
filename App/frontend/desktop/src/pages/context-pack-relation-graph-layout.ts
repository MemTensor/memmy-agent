import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { MemoryListItem, ProjectContextPackOutput } from "@memmy/local-api-contracts";

export type ContextPackGraph = ProjectContextPackOutput["graph"];

export type MemoryRelationNodeData = MemoryListItem & {
  external?: boolean;
  anchor: boolean;
} & Record<string, unknown>;

export type MemoryRelationFlowNode = Node<MemoryRelationNodeData, "memoryRelation">;

export type MemoryRelationLayout = {
  nodes: MemoryRelationFlowNode[];
  edges: Edge[];
  width: number;
  height: number;
};

const LAYERS = ["L1", "L2", "L3", "Skill"] as const;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 72;
const X_GAP = 76;
const Y_GAP = 34;
const LEFT = 28;
const TOP = 28;

export function layoutMemoryRelationGraph(graph: ContextPackGraph, anchorId: string): MemoryRelationLayout {
  const columnCounts = new Map<string, number>();
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodes: MemoryRelationFlowNode[] = graph.nodes.map((node) => {
    const column = Math.max(0, LAYERS.indexOf(node.memoryLayer));
    const row = columnCounts.get(node.memoryLayer) ?? 0;
    columnCounts.set(node.memoryLayer, row + 1);
    return {
      id: node.id,
      type: "memoryRelation",
      position: {
        x: LEFT + column * (NODE_WIDTH + X_GAP),
        y: TOP + row * (NODE_HEIGHT + Y_GAP)
      },
      data: { ...node, anchor: node.id === anchorId },
      draggable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: { width: NODE_WIDTH, height: NODE_HEIGHT }
    };
  });
  const edges: Edge[] = graph.edges
    .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
    .map((edge, index) => ({
      id: `${edge.relation}:${edge.sourceId}:${edge.targetId}:${index}`,
      source: edge.sourceId,
      target: edge.targetId,
      type: "default",
      label: edge.relation,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `context-pack-relation-edge context-pack-relation-edge--${edge.relation}`,
      style: {
        strokeWidth: edge.relation === "supersedes" ? 1.6 : 1.8,
        strokeDasharray: edge.relation === "supersedes" ? "5 4" : undefined
      },
      data: { reason: edge.reason }
    }));
  const maxRows = Math.max(1, ...LAYERS.map((layer) => columnCounts.get(layer) ?? 0));

  return {
    nodes,
    edges,
    width: LEFT * 2 + LAYERS.length * NODE_WIDTH + (LAYERS.length - 1) * X_GAP,
    height: TOP * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * Y_GAP
  };
}
