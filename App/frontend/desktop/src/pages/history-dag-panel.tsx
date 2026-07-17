import { useMemo, useState } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type NodeProps, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X } from "lucide-react";
import type { HistoryDagPayload, HistoryDagPayloadNode } from "../api/memmy-agent-client.js";
import {
  TASK_SOURCE_BOTTOM_HANDLE,
  TASK_TARGET_TOP_HANDLE,
  layoutHistoryDag,
  type HistoryDagFinishFlowNode,
  type HistoryDagFlowNode
} from "./history-dag-layout.js";

const HISTORY_DAG_PANEL_HEIGHT = "min(420px, calc(100vh - 180px))";
const HISTORY_DAG_HEADER_HEIGHT = 58;
const HISTORY_DAG_GRAPH_HEIGHT = `calc(${HISTORY_DAG_PANEL_HEIGHT} - ${HISTORY_DAG_HEADER_HEIGHT}px)`;
const historyDagNodeTypes: NodeTypes = {
  historyDag: HistoryDagNodeView,
  finish: HistoryDagFinishNodeView
};

export type HistoryDagPanelState =
  | { open: false }
  | { open: true; loading: true; content: string; error: null; payload: null }
  | { open: true; loading: false; content: string; error: string | null; payload: HistoryDagPayload | null };

export type HistoryDagPanelLabels = {
  currentTask: string;
  nodeCount: string;
  edgeCount: string;
  activePath: string;
  none: string;
  noDag: string;
  selectNode: string;
  refs: string;
  noRefs: string;
  finishTitle: string;
};

export function HistoryDagPanel(props: {
  state: HistoryDagPanelState;
  closeLabel: string;
  loadingLabel: string;
  labels: HistoryDagPanelLabels;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = useMemo(
    () => props.state.open && !props.state.loading && props.state.payload ? layoutHistoryDag(props.state.payload, { finishTitle: props.labels.finishTitle }) : null,
    [props.labels.finishTitle, props.state]
  );
  const selectedNode = props.state.open && props.state.payload && selectedId
    ? props.state.payload.nodes.find((node) => node.id === selectedId) ?? null
    : null;

  if (!props.state.open) return null;

  const payload = !props.state.loading ? props.state.payload : null;
  const taskNodes = payload?.nodes.filter((node) => node.kind === "task") ?? [];
  const latestTask = taskNodes[taskNodes.length - 1];

  return (
    <div
      role="dialog"
      aria-label="History DAG"
      className="history-dag-panel rounded-card border border-border-stone/40 bg-background-paper shadow-xl overflow-hidden"
      style={{ width: "100%", height: HISTORY_DAG_PANEL_HEIGHT }}
    >
      <div className="history-dag-panel-header h-[58px] flex items-center gap-3 border-b px-3 bg-background-paper">
        <div
          className="min-w-0 flex-1 grid items-center gap-3 text-[11px] text-text-ink/60"
          style={{ gridTemplateColumns: "minmax(0, 1fr) repeat(3, minmax(56px, max-content))" }}
        >
          <Metric label={props.labels.currentTask} value={latestTask?.title ?? props.labels.none} />
          <Metric label={props.labels.nodeCount} value={String(payload?.nodes.length ?? 0)} />
          <Metric label={props.labels.edgeCount} value={String(payload?.edges.length ?? 0)} />
          <Metric label={props.labels.activePath} value={String(payload?.activePathNodeIds.length ?? 0)} />
        </div>
        <button
          type="button"
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={props.onClose}
          className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-btn text-text-ink/45 hover:bg-canvas-oat/70 hover:text-text-ink/70 transition-all cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      <div className="relative min-h-0" style={{ height: HISTORY_DAG_GRAPH_HEIGHT }}>
        <div className="h-full overflow-x-auto overflow-y-hidden bg-canvas-oat/25 history-dag-flow-scope">
          {props.state.loading ? (
            <PanelText>{props.loadingLabel}</PanelText>
          ) : props.state.error ? (
            <PanelText>{props.state.error}</PanelText>
          ) : layout && payload ? (
            <div style={{ width: layout.width, minWidth: "100%", height: "100%" }}>
              <ReactFlow
                nodes={layout.nodes}
                edges={layout.edges}
                nodeTypes={historyDagNodeTypes}
                fitView
                minZoom={0.35}
                maxZoom={1.4}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                onNodeClick={(_, node) => {
                  if (!String(node.id).startsWith("finish:")) setSelectedId(String(node.id));
                }}
                onPaneClick={() => setSelectedId(null)}
              >
                <Background gap={20} size={1} />
                <MiniMap pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          ) : (
            <PanelText>{props.state.content || props.labels.noDag}</PanelText>
          )}
        </div>

        {selectedNode ? (
          <div
            className="absolute right-3 top-3 w-[280px] max-h-[180px] overflow-auto rounded-card border border-border-stone/40 bg-background-paper/95 shadow-lg"
            style={{ maxWidth: "calc(100% - 24px)" }}
          >
            <NodeDetail node={selectedNode} labels={props.labels} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HistoryDagNodeView(props: NodeProps<HistoryDagFlowNode>) {
  const node = props.data;
  return (
    <div className="history-dag-node-card" data-kind={node.kind} data-status={node.status}>
      <Handle type="target" position={Position.Left} className="history-dag-node-handle" />
      {node.kind === "task" ? (
        <Handle id={TASK_TARGET_TOP_HANDLE} type="target" position={Position.Top} className="history-dag-node-handle" />
      ) : null}
      <div className="history-dag-node-meta">
        <span className="history-dag-node-kind">{node.kind}</span>
        <span className="history-dag-node-status">{node.status}</span>
      </div>
      <div className="history-dag-node-title" title={node.title}>{node.title}</div>
      <Handle type="source" position={Position.Right} className="history-dag-node-handle" />
      {node.kind === "task" ? (
        <Handle id={TASK_SOURCE_BOTTOM_HANDLE} type="source" position={Position.Bottom} className="history-dag-node-handle" />
      ) : null}
    </div>
  );
}

function HistoryDagFinishNodeView(props: NodeProps<HistoryDagFinishFlowNode>) {
  return (
    <div className="history-dag-node-card history-dag-node-card-finish">
      <Handle type="target" position={Position.Left} className="history-dag-node-handle" />
      <span>{props.data.title}</span>
      <Handle type="source" position={Position.Right} className="history-dag-node-handle" />
    </div>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 inline-flex items-center gap-1 whitespace-nowrap">
      <span className="shrink-0 text-text-ink/40">{props.label}：</span>
      <span className="min-w-0 truncate font-medium text-text-ink/75">{props.value}</span>
    </div>
  );
}

function PanelText(props: { children: string }) {
  return (
    <pre className="m-3 whitespace-pre-wrap break-words text-[11px] leading-5 font-mono text-text-ink/70">
      {props.children}
    </pre>
  );
}

function NodeDetail(props: { node: HistoryDagPayloadNode | null; labels: HistoryDagPanelLabels }) {
  if (!props.node) {
    return <div className="p-3 text-xs text-text-ink/50">{props.labels.selectNode}</div>;
  }
  return (
    <div className="p-3 text-xs text-text-ink/65 space-y-3">
      <div>
        <div className="text-[11px] uppercase text-text-ink/35">{props.node.kind} · {props.node.status} · importance {props.node.importance}</div>
        <div className="mt-1 space-y-1 leading-5">
          <p><span className="font-medium text-text-ink/70">title：</span>{props.node.title}</p>
          <p><span className="font-medium text-text-ink/70">summary：</span>{props.node.summary}</p>
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase text-text-ink/35">{props.labels.refs}</div>
        {props.node.sourceRefs.length ? (
          <ul className="mt-1 space-y-1">
            {props.node.sourceRefs.map((ref, index) => (
              <li key={`${ref.type}:${index}`} className="rounded-btn bg-canvas-oat/50 px-2 py-1">
                <span className="font-medium">{ref.title}</span>
                <span className="block truncate text-text-ink/45">{ref.path ?? ref.artifact_path ?? ref.url}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-1 text-text-ink/45">{props.labels.noRefs}</div>
        )}
      </div>
    </div>
  );
}
