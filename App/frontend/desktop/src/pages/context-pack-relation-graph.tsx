import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Crosshair, ExternalLink } from "lucide-react";
import type { MessageKey } from "../i18n/messages.js";
import {
  layoutMemoryRelationGraph,
  type ContextPackGraph,
  type MemoryRelationFlowNode
} from "./context-pack-relation-graph-layout.js";

type Translate = (key: MessageKey) => string;

const nodeTypes: NodeTypes = { memoryRelation: MemoryRelationNodeView };

export function ContextPackRelationGraph(props: {
  graph: ContextPackGraph;
  anchorId: string;
  t: Translate;
  onBack: () => void;
  onOpenMemory: (memoryId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(props.anchorId);
  const [instance, setInstance] = useState<ReactFlowInstance<MemoryRelationFlowNode> | null>(null);
  const layout = useMemo(
    () => layoutMemoryRelationGraph(props.graph, props.anchorId),
    [props.anchorId, props.graph]
  );
  const nodes = useMemo<MemoryRelationFlowNode[]>(
    () => layout.nodes.map((node) => ({ ...node, selected: node.id === selectedId })),
    [layout.nodes, selectedId]
  );
  const selectedNode = props.graph.nodes.find((node) => node.id === selectedId) ?? null;

  useEffect(() => {
    setSelectedId(props.anchorId);
  }, [props.anchorId, props.graph]);

  function locate(memoryId: string) {
    setSelectedId(memoryId);
    window.requestAnimationFrame(() => {
      void instance?.fitView({ nodes: [{ id: memoryId }], duration: 180, maxZoom: 1.2, padding: 0.45 });
    });
  }

  if (layout.nodes.length === 0) {
    return (
      <div className="context-pack-relation-graph">
        <GraphBackButton t={props.t} onBack={props.onBack} />
        <div className="project-context-pack-dialog__status">{props.t("home.contextPack.graph.empty")}</div>
      </div>
    );
  }

  return (
    <div className="context-pack-relation-graph">
      <div className="context-pack-relation-graph__toolbar">
        <GraphBackButton t={props.t} onBack={props.onBack} />
        <button
          type="button"
          className="context-pack-relation-graph__locate"
          title={props.t("home.contextPack.graph.locate")}
          onClick={() => locate(selectedId)}
        >
          <Crosshair size={14} />
          {props.t("home.contextPack.graph.locate")}
        </button>
      </div>
      <div className="context-pack-relation-graph__canvas">
        <ReactFlow<MemoryRelationFlowNode>
          nodes={nodes}
          edges={layout.edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.35}
          maxZoom={1.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onInit={(flow) => {
            setInstance(flow);
            window.requestAnimationFrame(() => {
              void flow.fitView({ nodes: [{ id: props.anchorId }], maxZoom: 1.1, padding: 0.45 });
            });
          }}
          onNodeClick={(_, node) => locate(String(node.id))}
          onPaneClick={() => setSelectedId(props.anchorId)}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedNode ? (
        <div className="context-pack-relation-graph__selection" aria-live="polite">
          <div>
            <span>{selectedNode.memoryLayer} · {selectedNode.kind}</span>
            <strong>{selectedNode.title}</strong>
            <code>{selectedNode.id}</code>
          </div>
          <button type="button" onClick={() => props.onOpenMemory(selectedNode.id)}>
            <ExternalLink size={14} />
            {props.t("home.contextPack.graph.openMemory")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GraphBackButton(props: { t: Translate; onBack: () => void }) {
  return (
    <button type="button" className="project-context-pack-detail__back" onClick={props.onBack}>
      <ArrowLeft size={15} />
      {props.t("home.contextPack.graph.back")}
    </button>
  );
}

function MemoryRelationNodeView(props: NodeProps<MemoryRelationFlowNode>) {
  return (
    <div
      className="context-pack-relation-node"
      data-layer={props.data.memoryLayer}
      data-anchor={props.data.anchor ? "true" : "false"}
      data-external={props.data.external ? "true" : "false"}
    >
      <Handle type="target" position={Position.Left} className="context-pack-relation-node__handle" />
      <div className="context-pack-relation-node__meta">
        <span>{props.data.memoryLayer}</span>
        <span>{props.data.kind}</span>
      </div>
      <strong title={props.data.title}>{props.data.title}</strong>
      <Handle type="source" position={Position.Right} className="context-pack-relation-node__handle" />
    </div>
  );
}
