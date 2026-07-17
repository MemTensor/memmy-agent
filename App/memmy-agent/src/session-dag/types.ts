export const NODE_KINDS = ["task", "subtask", "decision"] as const;
export type DagNodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = ["active", "done", "failed", "blocked", "frozen"] as const;
export type DagNodeStatus = (typeof NODE_STATUSES)[number];

export const EDGE_TYPES = ["decomposes", "continues", "blocks", "supersedes"] as const;
export type DagEdgeType = (typeof EDGE_TYPES)[number];

export const BUILD_MODES = ["llm_patch", "deterministic_fallback"] as const;
export type DagBuildMode = (typeof BUILD_MODES)[number];

export const WRITE_SOURCES = ["llm_patch", "deterministic_fallback", "repair"] as const;
export type DagWriteSource = (typeof WRITE_SOURCES)[number];

export const TURN_STATUSES = ["pending", "running", "retry", "done", "blocked"] as const;
export type DagTurnStatus = (typeof TURN_STATUSES)[number];

export const SOURCE_REF_TYPES = ["file", "artifact", "url"] as const;
export type DagSourceRefType = (typeof SOURCE_REF_TYPES)[number];

export type DagDetailJson = Record<string, unknown>;

export type DagSourceRef = {
  type: DagSourceRefType;
  title: string;
  turn_id?: string;
  path?: string;
  line?: number;
  artifact_path?: string;
  url?: string;
};

export type DagNode = {
  id: string;
  session_key: string;
  kind: DagNodeKind;
  status: DagNodeStatus;
  title: string;
  summary: string;
  detail_json: DagDetailJson;
  importance: number;
  created_turn_id: string | null;
  updated_turn_id: string | null;
  first_message_index: number;
  last_message_index: number;
  source_refs: DagSourceRef[];
  created_by: DagWriteSource;
  updated_by: DagWriteSource;
  created_at: string;
  updated_at: string;
};

export type DagEdge = {
  id: string;
  source_id: string;
  target_id: string;
  type: DagEdgeType;
  created_turn_id: string | null;
  created_by: DagWriteSource;
  created_at: string;
};

export type DagPathSelection = {
  nodeIds: string[];
  edgeIds: string[];
};

export type DagTurn = {
  turn_id: string;
  message_start: number;
  message_end: number;
  user_text: string;
  assistant_text: string;
  created_at: string;
  updated_at: string;
  dag_status: DagTurnStatus;
  build_mode: DagBuildMode | null;
  attempt_count: number;
  running_started_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  processed_at: string | null;
};

export type DagSnapshotRecord = {
  id: string;
  turn_id: string | null;
  summary_mode: "dag";
  snapshot_text: string;
  snapshot_json: Record<string, unknown>;
  token_estimate: number;
  created_at: string;
};

export type DagGraph = {
  sessionKey: string;
  nodes: DagNode[];
  edges: DagEdge[];
  activePathNodeIds: string[];
  activePathEdgeIds: string[];
  snapshotText?: string;
};

export type DagContextNode = Pick<
  DagNode,
  | "id"
  | "kind"
  | "status"
  | "title"
  | "summary"
  | "importance"
  | "created_by"
  | "updated_by"
  | "source_refs"
  | "updated_turn_id"
  | "first_message_index"
  | "last_message_index"
>;

export type DagBuilderContext = {
  root_task_id: string | null;
  nodes: DagContextNode[];
  edges: Array<Pick<DagEdge, "source_id" | "target_id" | "type">>;
  active_path: string[];
  active_path_edges: Array<Pick<DagEdge, "id" | "source_id" | "target_id" | "type">>;
};

export type AddNodePatchOp = {
  op: "add_node";
  temp_id: string;
  kind: DagNodeKind;
  status: DagNodeStatus;
  title: string;
  summary: string;
  importance: number;
  detail_json?: DagDetailJson;
  source_refs?: DagSourceRef[];
};

export type UpdateNodePatchOp = {
  op: "update_node";
  node_id: string;
  title?: string;
  summary?: string;
  status?: DagNodeStatus;
  importance?: number;
  detail_json?: DagDetailJson;
  source_refs?: DagSourceRef[];
};

export type AddEdgePatchOp = {
  op: "add_edge";
  source_id: string;
  target_id: string;
  type: DagEdgeType;
};

export type DagPatchOp = AddNodePatchOp | UpdateNodePatchOp | AddEdgePatchOp;

export type DagPatch = {
  ops: DagPatchOp[];
};

export type DagTurnInput = {
  turn_id: string;
  message_start: number;
  message_end: number;
  user_text?: string;
  assistant_text?: string;
};

export type HistoryDagPayloadNode = {
  id: string;
  kind: DagNodeKind;
  status: DagNodeStatus;
  title: string;
  summary: string;
  importance: number;
  createdBy: DagWriteSource;
  updatedBy: DagWriteSource;
  sourceRefs: DagSourceRef[];
};

export type HistoryDagPayloadEdge = {
  id: string;
  source_id: string;
  target_id: string;
  type: DagEdgeType;
  createdBy: DagWriteSource;
};

export type HistoryDagPayload = {
  sessionKey: string;
  nodes: HistoryDagPayloadNode[];
  edges: HistoryDagPayloadEdge[];
  activePathNodeIds: string[];
  activePathEdgeIds: string[];
  snapshotText: string;
};
