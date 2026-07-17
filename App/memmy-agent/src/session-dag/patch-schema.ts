import { normalizeImportance } from "./importance.js";
import {
  EDGE_TYPES,
  NODE_KINDS,
  NODE_STATUSES,
  SOURCE_REF_TYPES,
  type AddEdgePatchOp,
  type AddNodePatchOp,
  type DagDetailJson,
  type DagBuilderContext,
  type DagEdgeType,
  type DagNodeKind,
  type DagNodeStatus,
  type DagPatch,
  type DagPatchOp,
  type DagSourceRef,
  type UpdateNodePatchOp,
} from "./types.js";

const DETAIL_KEYS: Record<DagNodeKind, Set<string>> = {
  task: new Set(["scope", "acceptance", "constraints", "result"]),
  subtask: new Set(["tool", "commands", "tests", "errors", "result"]),
  decision: new Set(["basis", "alternatives", "supersedes"]),
};

const ADD_NODE_KEYS = new Set(["op", "temp_id", "kind", "status", "title", "summary", "importance", "detail_json", "source_refs"]);
const UPDATE_NODE_KEYS = new Set(["op", "node_id", "title", "summary", "status", "importance", "detail_json", "source_refs"]);
const ADD_EDGE_KEYS = new Set(["op", "source_id", "target_id", "type"]);
const TEMP_ID_PATTERN = /^n(?:0|[1-9]\d*)$/;

export type DagPatchValidationOptions = {
  contextNodeKinds?: Record<string, DagNodeKind>;
};

export class DagPatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagPatchValidationError";
  }
}

export function validateDagPatch(input: unknown, options: DagPatchValidationOptions = {}): DagPatch {
  if (!isRecord(input)) throw new DagPatchValidationError("DAG patch must be an object");
  rejectUnknownTopLevelKeys(input);
  const opsInput = input.ops;
  if (!Array.isArray(opsInput)) throw new DagPatchValidationError("DAG patch ops must be an array");

  const contextNodeKinds = options.contextNodeKinds ?? {};
  const knownExistingIds = new Set(Object.keys(contextNodeKinds));
  const tempKinds = new Map<string, DagNodeKind>();
  const ops: DagPatchOp[] = [];
  let nextTempOrdinal = 0;

  for (const [index, rawOp] of opsInput.entries()) {
    if (!isRecord(rawOp)) throw new DagPatchValidationError(`DAG patch op ${index} must be an object`);
    const op = stringField(rawOp, "op");
    if (op === "add_node") {
      const add = validateAddNode(rawOp, index, `n${nextTempOrdinal}`);
      nextTempOrdinal += 1;
      if (tempKinds.has(add.temp_id) || knownExistingIds.has(add.temp_id)) {
        throw new DagPatchValidationError(`DAG patch op ${index} has duplicate temp_id`);
      }
      tempKinds.set(add.temp_id, add.kind);
      ops.push(add);
    } else if (op === "update_node") {
      const update = validateUpdateNode(rawOp, index, contextNodeKinds);
      if (!knownExistingIds.has(update.node_id)) {
        if (TEMP_ID_PATTERN.test(update.node_id)) {
          throw new DagPatchValidationError(
            `DAG patch op ${index} update_node.node_id cannot reference temp_id ${update.node_id}; use only ids from dag_context.nodes`,
          );
        }
        throw new DagPatchValidationError(`DAG patch op ${index} references node outside builder context`);
      }
      ops.push(update);
    } else if (op === "add_edge") {
      const edge = validateAddEdge(rawOp, index, knownExistingIds, tempKinds);
      ops.push(edge);
    } else {
      throw new DagPatchValidationError(`DAG patch op ${index} has unsupported op`);
    }
  }

  validateAddedNodeConnectivity(ops, contextNodeKinds);
  return { ops };
}

export function normalizeDagTaskTransition(patch: DagPatch, dagContext: DagBuilderContext): DagPatch {
  const addedTasks = patch.ops.filter((op): op is AddNodePatchOp => op.op === "add_node" && op.kind === "task");
  if (addedTasks.length > 1) {
    throw new DagPatchValidationError("DAG patch may add at most one task");
  }
  const addedTask = addedTasks[0];
  if (!addedTask || !dagContext.root_task_id) return patch;

  const rootTaskId = dagContext.root_task_id;
  const rootTask = dagContext.nodes.find((node) => node.id === rootTaskId);
  if (!rootTask || rootTask.kind !== "task") {
    throw new DagPatchValidationError("DAG task transition root_task_id must reference a task in dag_context.nodes");
  }

  const contextKinds = new Map(dagContext.nodes.map((node) => [node.id, node.kind]));
  const addedKinds = new Map(
    patch.ops
      .filter((op): op is AddNodePatchOp => op.op === "add_node")
      .map((op) => [op.temp_id, op.kind]),
  );
  const taskEdges = patch.ops.filter((op): op is AddEdgePatchOp => {
    if (op.op !== "add_edge") return false;
    const isTaskToTask =
      nodeKind(op.source_id, contextKinds, addedKinds) === "task" &&
      nodeKind(op.target_id, contextKinds, addedKinds) === "task";
    return isTaskToTask || op.target_id === addedTask.temp_id;
  });
  for (const edge of taskEdges) {
    if (edge.source_id !== rootTaskId || edge.target_id !== addedTask.temp_id) {
      throw new DagPatchValidationError("DAG task transition must connect current root_task_id directly to the new task");
    }
    if (edge.type !== "continues" && edge.type !== "supersedes") {
      throw new DagPatchValidationError("DAG task transition edge type must be continues or supersedes");
    }
  }
  if (taskEdges.length > 1) {
    throw new DagPatchValidationError("DAG task transition must contain exactly one task-to-task edge");
  }

  const rootUpdates = patch.ops.filter(
    (op): op is UpdateNodePatchOp => op.op === "update_node" && op.node_id === rootTaskId,
  );
  const explicitStatuses = [...new Set(rootUpdates.flatMap((op) => (op.status ? [op.status] : [])))];
  if (explicitStatuses.length > 1) {
    throw new DagPatchValidationError("DAG task transition has conflicting root task status updates");
  }
  const explicitStatus = explicitStatuses[0];
  if (explicitStatus === "active" || explicitStatus === "blocked") {
    throw new DagPatchValidationError("DAG task transition must close the old root task");
  }

  const explicitEdgeType = taskEdges[0]?.type;
  let resolvedStatus: DagNodeStatus;
  if (explicitStatus) {
    resolvedStatus = explicitStatus;
  } else if (explicitEdgeType) {
    if (isTerminalTaskStatus(rootTask.status)) {
      resolvedStatus = rootTask.status;
    } else {
      resolvedStatus = explicitEdgeType === "continues" ? "done" : "frozen";
    }
  } else if (isTerminalTaskStatus(rootTask.status)) {
    resolvedStatus = rootTask.status;
  } else {
    const descendants = dagContext.nodes.filter((node) => node.kind !== "task");
    const hasDoneDescendant = descendants.some((node) => node.status === "done");
    const hasOpenDescendant = descendants.some((node) => node.status === "active" || node.status === "blocked");
    resolvedStatus = rootTask.status === "active" && hasDoneDescendant && !hasOpenDescendant ? "done" : "frozen";
  }

  const resolvedEdgeType = taskTransitionEdgeType(resolvedStatus);
  if (explicitEdgeType && explicitEdgeType !== resolvedEdgeType) {
    throw new DagPatchValidationError(
      `DAG task transition status ${resolvedStatus} conflicts with edge type ${explicitEdgeType}`,
    );
  }

  const shouldWriteStatus = Boolean(explicitStatus) || !isTerminalTaskStatus(rootTask.status);
  const rootUpdate = mergeRootUpdates(rootTaskId, rootUpdates);
  if (shouldWriteStatus) {
    rootUpdate.status = resolvedStatus;
  }

  const transitionEdge: AddEdgePatchOp = {
    op: "add_edge",
    source_id: rootTaskId,
    target_id: addedTask.temp_id,
    type: resolvedEdgeType,
  };
  const taskEdgeSet = new Set<DagPatchOp>(taskEdges);
  return {
    ops: [
      ...(rootUpdates.length || shouldWriteStatus ? [rootUpdate] : []),
      ...patch.ops.filter((op) => op.op !== "add_edge" && !(op.op === "update_node" && op.node_id === rootTaskId)),
      ...patch.ops.filter((op) => op.op === "add_edge" && !taskEdgeSet.has(op)),
      transitionEdge,
    ],
  };
}

export function sanitizeDetailJson(kind: DagNodeKind, detail: unknown): DagDetailJson {
  if (!isRecord(detail)) return {};
  const allowed = DETAIL_KEYS[kind];
  const out: DagDetailJson = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!allowed.has(key)) continue;
    if (!isJsonValue(value)) continue;
    out[key] = value;
  }
  return out;
}

export function sanitizeSourceRefs(input: unknown, turnId?: string | null): DagSourceRef[] {
  if (!Array.isArray(input)) return [];
  const refs: DagSourceRef[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = stringOrNull(item.type);
    if (!SOURCE_REF_TYPES.includes(type as any)) continue;
    const title = boundedString(item.title, 120);
    if (!title) continue;
    const ref: DagSourceRef = { type: type as DagSourceRef["type"], title };
    const explicitTurnId = boundedString(item.turn_id, 120) ?? boundedString(item.turnId, 120);
    if (explicitTurnId || turnId) ref.turn_id = explicitTurnId ?? turnId ?? undefined;
    const line = integerOrNull(item.line);
    if (line != null && line > 0) ref.line = line;
    if (type === "file") {
      const filePath = boundedString(item.path, 1000);
      if (!filePath) continue;
      ref.path = filePath;
    } else if (type === "artifact") {
      const artifactPath = boundedString(item.artifact_path, 1000) ?? boundedString(item.artifactPath, 1000);
      if (!artifactPath) continue;
      ref.artifact_path = artifactPath;
    } else if (type === "url") {
      const url = boundedString(item.url, 2000);
      if (!url) continue;
      ref.url = url;
    }
    refs.push(ref);
  }
  return dedupeSourceRefs(refs);
}

export function dedupeSourceRefs(refs: DagSourceRef[]): DagSourceRef[] {
  const seen = new Set<string>();
  const out: DagSourceRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.type,
      ref.path ?? "",
      ref.line ?? "",
      ref.artifact_path ?? "",
      ref.url ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function validateAddNode(raw: Record<string, unknown>, index: number, expectedTempId: string): AddNodePatchOp {
  rejectUnknownKeys(raw, ADD_NODE_KEYS, index);
  const kind = enumField(raw, "kind", NODE_KINDS, index);
  const status = enumField(raw, "status", NODE_STATUSES, index);
  if (kind === "task" && status !== "active" && status !== "blocked") {
    throw new DagPatchValidationError(`DAG patch op ${index} task add_node status must be active or blocked`);
  }
  const importance = normalizeImportance(raw.importance);
  if (importance == null) throw new DagPatchValidationError(`DAG patch op ${index} importance must be 0..100`);
  const sourceRefs = sanitizeSourceRefs(raw.source_refs);
  if (kind === "task" && sourceRefs.length) throw new DagPatchValidationError("task nodes cannot include source_refs");
  return {
    op: "add_node",
    temp_id: requiredTempId(raw.temp_id, index, expectedTempId),
    kind,
    status,
    title: requiredBoundedString(raw.title, "title", index, 120),
    summary: requiredBoundedString(raw.summary, "summary", index, 1000),
    importance,
    detail_json: sanitizeDetailJson(kind, raw.detail_json),
    source_refs: sourceRefs,
  };
}

function validateUpdateNode(
  raw: Record<string, unknown>,
  index: number,
  contextNodeKinds: Record<string, DagNodeKind>,
): UpdateNodePatchOp {
  rejectUnknownKeys(raw, UPDATE_NODE_KEYS, index);
  const nodeId = requiredBoundedString(raw.node_id, "node_id", index, 120);
  const kind = contextNodeKinds[nodeId];
  const out: UpdateNodePatchOp = {
    op: "update_node",
    node_id: nodeId,
  };
  if ("title" in raw) out.title = requiredBoundedString(raw.title, "title", index, 120);
  if ("summary" in raw) out.summary = requiredBoundedString(raw.summary, "summary", index, 1000);
  if ("status" in raw) out.status = enumField(raw, "status", NODE_STATUSES, index);
  if ("importance" in raw) {
    const importance = normalizeImportance(raw.importance);
    if (importance == null) throw new DagPatchValidationError(`DAG patch op ${index} importance must be 0..100`);
    out.importance = importance;
  }
  if ("detail_json" in raw) out.detail_json = kind ? sanitizeDetailJson(kind, raw.detail_json) : {};
  if ("source_refs" in raw) {
    const sourceRefs = sanitizeSourceRefs(raw.source_refs);
    if (kind === "task" && sourceRefs.length) throw new DagPatchValidationError("task nodes cannot include source_refs");
    out.source_refs = sourceRefs;
  }
  if (Object.keys(out).length <= 2) throw new DagPatchValidationError(`DAG patch op ${index} update_node has no updates`);
  return out;
}

function validateAddEdge(
  raw: Record<string, unknown>,
  index: number,
  knownExistingIds: Set<string>,
  tempKinds: Map<string, DagNodeKind>,
): AddEdgePatchOp {
  rejectUnknownKeys(raw, ADD_EDGE_KEYS, index);
  const sourceId = requiredBoundedString(raw.source_id, "source_id", index, 120);
  const targetId = requiredBoundedString(raw.target_id, "target_id", index, 120);
  if (sourceId === targetId) throw new DagPatchValidationError(`DAG patch op ${index} creates a self edge`);
  if (!knownExistingIds.has(sourceId) && !tempKinds.has(sourceId)) {
    throw new DagPatchValidationError(`DAG patch op ${index} source_id is unknown`);
  }
  if (!knownExistingIds.has(targetId) && !tempKinds.has(targetId)) {
    throw new DagPatchValidationError(`DAG patch op ${index} target_id is unknown`);
  }
  return {
    op: "add_edge",
    source_id: sourceId,
    target_id: targetId,
    type: enumField(raw, "type", EDGE_TYPES, index),
  };
}

function validateAddedNodeConnectivity(ops: DagPatchOp[], contextNodeKinds: Record<string, DagNodeKind>): void {
  const connected = new Set(Object.keys(contextNodeKinds));
  const addedKinds = new Map<string, DagNodeKind>();
  const edges: AddEdgePatchOp[] = [];

  for (const op of ops) {
    if (op.op === "add_node") {
      addedKinds.set(op.temp_id, op.kind);
      if (op.kind === "task") connected.add(op.temp_id);
    } else if (op.op === "add_edge") {
      edges.push(op);
    }
  }

  if ([...addedKinds.values()].filter((kind) => kind === "task").length > 1) {
    throw new DagPatchValidationError("DAG patch may add at most one task");
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!connected.has(edge.source_id) || connected.has(edge.target_id) || !addedKinds.has(edge.target_id)) continue;
      connected.add(edge.target_id);
      changed = true;
    }
  }

  for (const [tempId, kind] of addedKinds) {
    if (kind === "task" || connected.has(tempId)) continue;
    throw new DagPatchValidationError(`DAG patch add_node temp_id ${tempId} kind ${kind} must be connected by add_edge`);
  }
}

function nodeKind(
  id: string,
  contextKinds: Map<string, DagNodeKind>,
  addedKinds: Map<string, DagNodeKind>,
): DagNodeKind | undefined {
  return contextKinds.get(id) ?? addedKinds.get(id);
}

function isTerminalTaskStatus(status: DagNodeStatus): status is "done" | "failed" | "frozen" {
  return status === "done" || status === "failed" || status === "frozen";
}

function taskTransitionEdgeType(status: DagNodeStatus): DagEdgeType {
  if (status === "done" || status === "failed") return "continues";
  if (status === "frozen") return "supersedes";
  throw new DagPatchValidationError(`DAG task transition old root status ${status} is not terminal`);
}

function mergeRootUpdates(rootTaskId: string, updates: UpdateNodePatchOp[]): UpdateNodePatchOp {
  const merged: UpdateNodePatchOp = { op: "update_node", node_id: rootTaskId };
  for (const update of updates) {
    if (update.title !== undefined) merged.title = update.title;
    if (update.summary !== undefined) merged.summary = update.summary;
    if (update.status !== undefined) merged.status = update.status;
    if (update.importance !== undefined) merged.importance = update.importance;
    if (update.detail_json !== undefined) merged.detail_json = { ...merged.detail_json, ...update.detail_json };
    if (update.source_refs !== undefined) merged.source_refs = dedupeSourceRefs([...(merged.source_refs ?? []), ...update.source_refs]);
  }
  return merged;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: Set<string>, index: number): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new DagPatchValidationError(`DAG patch op ${index} has unsupported field ${key}`);
  }
}

function rejectUnknownTopLevelKeys(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (key !== "ops") throw new DagPatchValidationError(`DAG patch has unsupported top-level field ${key}`);
  }
}

function stringField(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  return typeof value === "string" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trimEnd() : trimmed;
}

function requiredBoundedString(value: unknown, field: string, index: number, maxLength: number): string {
  const out = boundedString(value, maxLength);
  if (!out) throw new DagPatchValidationError(`DAG patch op ${index} ${field} must be a non-empty string`);
  return out;
}

function requiredTempId(value: unknown, index: number, expectedTempId: string): string {
  const out = requiredBoundedString(value, "temp_id", index, 80);
  if (!TEMP_ID_PATTERN.test(out) || out !== expectedTempId) {
    throw new DagPatchValidationError(`DAG patch op ${index} temp_id must be ${expectedTempId}`);
  }
  return out;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

function enumField<const T extends readonly string[]>(
  raw: Record<string, unknown>,
  field: string,
  values: T,
  index: number,
): T[number] {
  const value = raw[field];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new DagPatchValidationError(`DAG patch op ${index} ${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return Number.isFinite(value as number) || typeof value !== "number";
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}
