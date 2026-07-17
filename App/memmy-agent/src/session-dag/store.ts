import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeImportance } from "./importance.js";
import { dedupeSourceRefs, sanitizeDetailJson, sanitizeSourceRefs } from "./patch-schema.js";
import { sessionDagDbPath } from "./paths.js";
import {
  type AddEdgePatchOp,
  type AddNodePatchOp,
  type DagBuildMode,
  type DagBuilderContext,
  type DagContextNode,
  type DagDetailJson,
  type DagEdge,
  type DagGraph,
  type DagNode,
  type DagPathSelection,
  type DagPatch,
  type DagSnapshotRecord,
  type DagTurn,
  type DagTurnInput,
  type DagTurnStatus,
  type DagWriteSource,
  type UpdateNodePatchOp,
} from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TASK_TRANSITION_REPAIR_META_KEY = "task_transition_repair_v1";

export type SessionDagStoreOptions = {
  sessionKey: string;
  dbPath?: string;
  readonly?: boolean;
};

export type ApplyDagPatchOptions = {
  turn: DagTurnInput;
  patch: DagPatch;
  buildMode: DagBuildMode;
  writeSource?: DagWriteSource;
};

type DagNodeRow = Omit<DagNode, "detail_json" | "source_refs"> & {
  detail_json: string;
  source_refs_json: string;
};

type DagEdgeRow = DagEdge;

type DagTurnRow = DagTurn;

export class SessionDagStore {
  readonly sessionKey: string;
  readonly dbPath: string;
  readonly db: Database.Database;

  constructor(options: SessionDagStoreOptions) {
    this.sessionKey = options.sessionKey;
    this.dbPath = options.dbPath ?? sessionDagDbPath(options.sessionKey);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { readonly: options.readonly ?? false });
    this.configure();
    if (!options.readonly) {
      this.initSchema();
      this.repairTaskTransitionsOnce();
    }
  }

  close(): void {
    this.db.close();
  }

  upsertTurn(input: DagTurnInput): DagTurn {
    if (!Number.isInteger(input.message_start) || !Number.isInteger(input.message_end) || input.message_end <= input.message_start) {
      throw new Error("invalid DAG turn message range");
    }
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO dag_turns (
        turn_id, message_start, message_end, user_text, assistant_text, created_at, updated_at, dag_status
      ) VALUES (
        @turn_id, @message_start, @message_end, @user_text, @assistant_text, @now, @now, 'pending'
      )
      ON CONFLICT(turn_id) DO UPDATE SET
        message_start=excluded.message_start,
        message_end=excluded.message_end,
        user_text=excluded.user_text,
        assistant_text=excluded.assistant_text,
        updated_at=excluded.updated_at`,
    ).run({
      turn_id: input.turn_id,
      message_start: input.message_start,
      message_end: input.message_end,
      user_text: input.user_text ?? "",
      assistant_text: input.assistant_text ?? "",
      now,
    });
    return this.getTurn(input.turn_id)!;
  }

  getTurn(turnId: string): DagTurn | null {
    const row = this.db.prepare("SELECT * FROM dag_turns WHERE turn_id = ?").get(turnId) as DagTurnRow | undefined;
    return row ?? null;
  }

  listTurns(statuses?: DagTurnStatus[]): DagTurn[] {
    if (!statuses?.length) return this.db.prepare("SELECT * FROM dag_turns ORDER BY message_start ASC").all() as DagTurn[];
    const placeholders = statuses.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM dag_turns WHERE dag_status IN (${placeholders}) ORDER BY message_start ASC`).all(...statuses) as DagTurn[];
  }

  claimNextTurn(now = new Date()): DagTurn | null {
    const iso = now.toISOString();
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE dag_turns SET dag_status='retry', running_started_at=NULL, updated_at=? WHERE dag_status='running'").run(iso);
      const row = this.db.prepare(
        `SELECT * FROM dag_turns
         WHERE dag_status IN ('pending', 'retry', 'blocked')
           AND (next_retry_at IS NULL OR next_retry_at <= ? OR dag_status = 'blocked')
         ORDER BY message_start ASC
         LIMIT 1`,
      ).get(iso) as DagTurnRow | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE dag_turns SET dag_status='running', running_started_at=?, updated_at=? WHERE turn_id=?").run(iso, iso, row.turn_id);
      return this.getTurn(row.turn_id);
    });
    return transaction();
  }

  markTurnRetry(turnId: string, error: string, nextRetryAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE dag_turns
       SET dag_status='retry',
           attempt_count=attempt_count + 1,
           running_started_at=NULL,
           next_retry_at=?,
           last_error=?,
           updated_at=?
       WHERE turn_id=?`,
    ).run(nextRetryAt, truncate(error, 2000), now, turnId);
  }

  markTurnBlocked(turnId: string, error: string, nextRetryAt: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE dag_turns
       SET dag_status='blocked',
           running_started_at=NULL,
           next_retry_at=?,
           last_error=?,
           updated_at=?
       WHERE turn_id=?`,
    ).run(nextRetryAt, truncate(error, 2000), now, turnId);
  }

  markTurnDone(turnId: string, buildMode: DagBuildMode): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE dag_turns
       SET dag_status='done',
           build_mode=?,
           running_started_at=NULL,
           next_retry_at=NULL,
           last_error=NULL,
           processed_at=?,
           updated_at=?
       WHERE turn_id=?`,
    ).run(buildMode, now, now, turnId);
    this.setMeta("last_processed_turn_id", turnId);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM dag_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO dag_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  applyPatch(options: ApplyDagPatchOptions): { nodeIds: Record<string, string>; edgeIds: string[] } {
    const writeSource = options.writeSource ?? options.buildMode;
    const transaction = this.db.transaction(() => {
      const prePatchRoot = selectRootTask(this.readNodes());
      this.upsertTurn(options.turn);
      const tempNodeIds: Record<string, string> = {};
      const edgeIds: string[] = [];
      const addedChildNodeIds: string[] = [];
      const addedTaskNodeIds: string[] = [];
      const now = new Date().toISOString();

      for (const op of options.patch.ops) {
        if (op.op === "add_node") {
          const id = this.insertNode(op, options.turn, writeSource, now);
          tempNodeIds[op.temp_id] = id;
          if (op.kind === "task") addedTaskNodeIds.push(id);
          else addedChildNodeIds.push(id);
        } else if (op.op === "update_node") {
          this.updateNode(op, options.turn, writeSource, now);
        } else {
          const id = this.insertEdge(op, tempNodeIds, options.turn.turn_id, writeSource, now);
          if (id) edgeIds.push(id);
        }
      }

      this.assertAddedChildNodesReachableFromTaskRoot(addedChildNodeIds);
      this.assertTaskTransitionIntegrity(prePatchRoot?.id ?? null, addedTaskNodeIds);
      this.markTurnDone(options.turn.turn_id, options.buildMode);
      return { nodeIds: tempNodeIds, edgeIds };
    });
    return transaction();
  }

  readGraphForHistoryDag(): DagGraph {
    const nodes = this.readNodes();
    const edges = this.readEdges();
    const latest = this.readLatestSnapshotText();
    const activePath = deriveActivePathSelection(nodes, edges);
    return {
      sessionKey: this.sessionKey,
      nodes,
      edges,
      activePathNodeIds: activePath.nodeIds,
      activePathEdgeIds: activePath.edgeIds,
      snapshotText: latest ?? "",
    };
  }

  readBuilderContext(maxNodes: number): DagBuilderContext {
    const nodes = this.readNodes();
    const edges = this.readEdges();
    if (!nodes.length) {
      return { root_task_id: null, nodes: [], edges: [], active_path: [], active_path_edges: [] };
    }
    const activePath = deriveActivePathSelection(nodes, edges);
    const rootId = activePath.nodeIds[0] ?? null;
    const descendants = rootId ? taskSubgraphNodeIds(rootId, nodes, edges) : new Set<string>();
    const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const mandatory = new Set<string>(activePath.nodeIds);
    for (const node of nodes) {
      if (!descendants.has(node.id)) continue;
      if (node.status === "active" || node.status === "blocked" || node.status === "failed") mandatory.add(node.id);
    }
    const ranked = nodes
      .filter((node) => descendants.has(node.id))
      .sort((left, right) => {
        const importance = right.importance - left.importance;
        if (importance !== 0) return importance;
        return String(right.updated_at).localeCompare(String(left.updated_at));
      });
    const selected = new Set<string>([...mandatory]);
    for (const node of ranked) {
      if (selected.size >= maxNodes) break;
      selected.add(node.id);
    }
    const contextNodes = nodes.filter((node) => selected.has(node.id)).map(toContextNode);
    return {
      root_task_id: rootId,
      nodes: contextNodes,
      edges: edges
        .filter((edge) => selected.has(edge.source_id) && selected.has(edge.target_id))
        .map((edge) => ({ source_id: edge.source_id, target_id: edge.target_id, type: edge.type })),
      active_path: activePath.nodeIds,
      active_path_edges: activePath.edgeIds
        .map((edgeId) => edgesById.get(edgeId))
        .filter((edge): edge is DagEdge => edge != null)
        .map((edge) => ({ id: edge.id, source_id: edge.source_id, target_id: edge.target_id, type: edge.type })),
    };
  }

  createSnapshot(turnId: string | null, snapshotText: string, snapshotJson: Record<string, unknown>, tokenEstimate: number): DagSnapshotRecord {
    const record: DagSnapshotRecord = {
      id: `s_${newSortableId()}`,
      turn_id: turnId,
      summary_mode: "dag",
      snapshot_text: snapshotText,
      snapshot_json: snapshotJson,
      token_estimate: Math.max(0, Math.trunc(tokenEstimate)),
      created_at: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO dag_snapshots(id, turn_id, summary_mode, snapshot_text, snapshot_json, token_estimate, created_at)
       VALUES(@id, @turn_id, @summary_mode, @snapshot_text, @snapshot_json, @token_estimate, @created_at)`,
    ).run({
      ...record,
      snapshot_json: JSON.stringify(snapshotJson),
    });
    return record;
  }

  private configure(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  private repairTaskTransitionsOnce(): void {
    const transaction = this.db.transaction(() => {
      if (this.getMeta(TASK_TRANSITION_REPAIR_META_KEY) === "done") return;

      const nodes = this.readNodes();
      const edges = this.readEdges();
      const tasks = nodes
        .filter((node) => node.kind === "task")
        .sort((left, right) => {
          const messageIndex = left.first_message_index - right.first_message_index;
          if (messageIndex !== 0) return messageIndex;
          const createdAt = String(left.created_at).localeCompare(String(right.created_at));
          return createdAt || left.id.localeCompare(right.id);
        });

      for (let index = 0; index < tasks.length - 1; index += 1) {
        const oldTask = tasks[index];
        const nextTask = tasks[index + 1];
        const directEdges = edges.filter((edge) => edge.source_id === oldTask.id && edge.target_id === nextTask.id);
        if (
          directEdges.length > 1 ||
          directEdges.some((edge) => edge.type !== "continues" && edge.type !== "supersedes")
        ) {
          console.warn(`[session-dag] skipped ambiguous task transition repair ${oldTask.id} -> ${nextTask.id}`);
          continue;
        }

        const existingTransition = directEdges[0];
        let repairedStatus = oldTask.status;
        if (oldTask.status === "active" || oldTask.status === "blocked") {
          if (existingTransition) {
            repairedStatus = existingTransition.type === "continues" ? "done" : "frozen";
          } else {
            const descendantIds = taskSubgraphNodeIds(oldTask.id, nodes, edges);
            const descendants = nodes.filter((node) => node.kind !== "task" && descendantIds.has(node.id));
            const hasDoneDescendant = descendants.some((node) => node.status === "done");
            const hasOpenDescendant = descendants.some((node) => node.status === "active" || node.status === "blocked");
            repairedStatus = oldTask.status === "active" && hasDoneDescendant && !hasOpenDescendant ? "done" : "frozen";
          }
        }
        const expectedType = taskTransitionTypeForStatus(repairedStatus);
        if (existingTransition && existingTransition.type !== expectedType) {
          console.warn(`[session-dag] skipped conflicting task transition repair ${oldTask.id} -> ${nextTask.id}`);
          continue;
        }
        if (!existingTransition && this.wouldCreateCycle(oldTask.id, nextTask.id)) {
          console.warn(`[session-dag] skipped cyclic task transition repair ${oldTask.id} -> ${nextTask.id}`);
          continue;
        }

        if (repairedStatus !== oldTask.status) {
          this.db.prepare(
            `UPDATE dag_nodes
             SET status=?, updated_turn_id=?, updated_by='repair', updated_at=?
             WHERE id=? AND session_key=?`,
          ).run(repairedStatus, nextTask.created_turn_id, nextTask.created_at, oldTask.id, this.sessionKey);
          oldTask.status = repairedStatus;
          oldTask.updated_turn_id = nextTask.created_turn_id;
          oldTask.updated_by = "repair";
          oldTask.updated_at = nextTask.created_at;
        }
        if (!existingTransition) {
          const repairedEdge: DagEdge = {
            id: `e_${newSortableId()}`,
            source_id: oldTask.id,
            target_id: nextTask.id,
            type: expectedType,
            created_turn_id: nextTask.created_turn_id,
            created_by: "repair",
            created_at: nextTask.created_at,
          };
          this.db.prepare(
            `INSERT INTO dag_edges(id, source_id, target_id, type, created_turn_id, created_by, created_at)
             VALUES(@id, @source_id, @target_id, @type, @created_turn_id, @created_by, @created_at)`,
          ).run(repairedEdge);
          edges.push(repairedEdge);
        }
      }

      this.setMeta(TASK_TRANSITION_REPAIR_META_KEY, "done");
    });
    transaction();
  }

  private insertNode(op: AddNodePatchOp, turn: DagTurnInput, writeSource: DagWriteSource, now: string): string {
    const id = `n_${newSortableId()}`;
    const detail = sanitizeDetailJson(op.kind, op.detail_json);
    const sourceRefs = sanitizeSourceRefs(op.source_refs, turn.turn_id);
    this.db.prepare(
      `INSERT INTO dag_nodes (
        id, session_key, kind, status, title, summary, detail_json, importance,
        created_turn_id, updated_turn_id, first_message_index, last_message_index,
        source_refs_json, created_by, updated_by, created_at, updated_at
      ) VALUES (
        @id, @session_key, @kind, @status, @title, @summary, @detail_json, @importance,
        @turn_id, @turn_id, @first_message_index, @last_message_index,
        @source_refs_json, @write_source, @write_source, @now, @now
      )`,
    ).run({
      id,
      session_key: this.sessionKey,
      kind: op.kind,
      status: op.status,
      title: op.title,
      summary: op.summary,
      detail_json: JSON.stringify(detail),
      importance: op.importance,
      turn_id: turn.turn_id,
      first_message_index: turn.message_start,
      last_message_index: turn.message_end,
      source_refs_json: JSON.stringify(sourceRefs),
      write_source: writeSource,
      now,
    });
    return id;
  }

  private updateNode(op: UpdateNodePatchOp, turn: DagTurnInput, writeSource: DagWriteSource, now: string): void {
    const node = this.getNode(op.node_id);
    if (!node) throw new Error(`DAG node ${op.node_id} not found`);
    const nextDetail = op.detail_json
      ? { ...node.detail_json, ...sanitizeDetailJson(node.kind, op.detail_json) }
      : node.detail_json;
    const nextRefs = op.source_refs
      ? dedupeSourceRefs([...node.source_refs, ...sanitizeSourceRefs(op.source_refs, turn.turn_id)])
      : node.source_refs;
    const importance = "importance" in op ? normalizeImportance(op.importance) : node.importance;
    if (importance == null) throw new Error("invalid DAG importance");
    this.db.prepare(
      `UPDATE dag_nodes
       SET title=@title,
           summary=@summary,
           status=@status,
           detail_json=@detail_json,
           importance=@importance,
           updated_turn_id=@turn_id,
           last_message_index=MAX(last_message_index, @last_message_index),
           source_refs_json=@source_refs_json,
           updated_by=@write_source,
           updated_at=@now
       WHERE id=@id`,
    ).run({
      id: node.id,
      title: op.title ?? node.title,
      summary: op.summary ?? node.summary,
      status: op.status ?? node.status,
      detail_json: JSON.stringify(nextDetail),
      importance,
      turn_id: turn.turn_id,
      last_message_index: turn.message_end,
      source_refs_json: JSON.stringify(nextRefs),
      write_source: writeSource,
      now,
    });
  }

  private insertEdge(op: AddEdgePatchOp, tempNodeIds: Record<string, string>, turnId: string, writeSource: DagWriteSource, now: string): string | null {
    const sourceId = tempNodeIds[op.source_id] ?? op.source_id;
    const targetId = tempNodeIds[op.target_id] ?? op.target_id;
    if (sourceId === targetId) throw new Error("DAG edge self-loop rejected");
    if (!this.getNode(sourceId) || !this.getNode(targetId)) throw new Error("DAG edge references unknown node");
    if (op.type === "supersedes") {
      const source = this.getNode(sourceId);
      if (source?.status !== "frozen") throw new Error("supersedes source node must be frozen");
    }
    if (this.edgeExists(sourceId, targetId, op.type)) return null;
    if (this.wouldCreateCycle(sourceId, targetId)) throw new Error("DAG edge would create a cycle");
    const id = `e_${newSortableId()}`;
    this.db.prepare(
      `INSERT INTO dag_edges(id, source_id, target_id, type, created_turn_id, created_by, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sourceId, targetId, op.type, turnId, writeSource, now);
    return id;
  }

  private getNode(id: string): DagNode | null {
    const row = this.db.prepare("SELECT * FROM dag_nodes WHERE id=? AND session_key=?").get(id, this.sessionKey) as DagNodeRow | undefined;
    return row ? parseNodeRow(row) : null;
  }

  private readNodes(): DagNode[] {
    const rows = this.db.prepare("SELECT * FROM dag_nodes WHERE session_key=? ORDER BY created_at ASC, id ASC").all(this.sessionKey) as DagNodeRow[];
    return rows.map(parseNodeRow);
  }

  private readEdges(): DagEdge[] {
    return this.db.prepare("SELECT * FROM dag_edges ORDER BY created_at ASC, id ASC").all() as DagEdgeRow[];
  }

  private edgeExists(sourceId: string, targetId: string, type: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM dag_edges WHERE source_id=? AND target_id=? AND type=? LIMIT 1").get(sourceId, targetId, type);
    return Boolean(row);
  }

  private wouldCreateCycle(sourceId: string, targetId: string): boolean {
    const row = this.db.prepare(
      `WITH RECURSIVE reach(id) AS (
        SELECT target_id FROM dag_edges WHERE source_id = ?
        UNION
        SELECT dag_edges.target_id
        FROM dag_edges
        JOIN reach ON dag_edges.source_id = reach.id
      )
      SELECT 1 FROM reach WHERE id = ? LIMIT 1`,
    ).get(targetId, sourceId);
    return Boolean(row);
  }

  private assertAddedChildNodesReachableFromTaskRoot(addedChildNodeIds: string[]): void {
    if (!addedChildNodeIds.length) return;
    const nodes = this.readNodes();
    const edges = this.readEdges();
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const childrenBySource = new Map<string, string[]>();
    for (const edge of edges) {
      if (!nodesById.has(edge.source_id) || !nodesById.has(edge.target_id)) continue;
      const children = childrenBySource.get(edge.source_id) ?? [];
      children.push(edge.target_id);
      childrenBySource.set(edge.source_id, children);
    }

    const reachable = new Set<string>();
    const queue = nodes.filter((node) => node.kind === "task").map((node) => node.id);
    while (queue.length) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      queue.push(...(childrenBySource.get(id) ?? []));
    }

    for (const id of addedChildNodeIds) {
      if (reachable.has(id)) continue;
      const node = nodesById.get(id);
      throw new Error(`DAG added ${node?.kind ?? "child"} node ${id} is not reachable from a task`);
    }
  }

  private assertTaskTransitionIntegrity(prePatchRootId: string | null, addedTaskNodeIds: string[]): void {
    if (addedTaskNodeIds.length > 1) throw new Error("DAG patch may add at most one task");

    const nodes = this.readNodes();
    const edges = this.readEdges();
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const openTasks = nodes.filter(
      (node) => node.kind === "task" && (node.status === "active" || node.status === "blocked"),
    );
    if (openTasks.length > 1) throw new Error("DAG session may contain at most one active or blocked task");

    const addedTaskId = addedTaskNodeIds[0];
    if (!addedTaskId) return;
    const addedTask = nodesById.get(addedTaskId);
    if (!addedTask || addedTask.kind !== "task") throw new Error("DAG added task node is missing");
    if (addedTask.status !== "active" && addedTask.status !== "blocked") {
      throw new Error("DAG added task status must be active or blocked");
    }

    const incomingEdges = edges.filter((edge) => edge.target_id === addedTaskId);
    if (!prePatchRootId) {
      if (incomingEdges.some((edge) => nodesById.get(edge.source_id)?.kind === "task")) {
        throw new Error("DAG initial task cannot have a task transition edge");
      }
      return;
    }

    const oldRoot = nodesById.get(prePatchRootId);
    if (!oldRoot || oldRoot.kind !== "task") throw new Error("DAG task transition old root is missing");
    if (oldRoot.status !== "done" && oldRoot.status !== "failed" && oldRoot.status !== "frozen") {
      throw new Error("DAG task transition old root must be done, failed, or frozen");
    }
    if (incomingEdges.length !== 1) {
      throw new Error("DAG task transition new task must have exactly one incoming edge");
    }
    const transition = incomingEdges[0];
    if (transition.source_id !== oldRoot.id || (transition.type !== "continues" && transition.type !== "supersedes")) {
      throw new Error("DAG task transition must connect the old root directly to the new task");
    }
    const expectedType = taskTransitionTypeForStatus(oldRoot.status);
    if (transition.type !== expectedType) {
      throw new Error(`DAG task transition status ${oldRoot.status} conflicts with edge type ${transition.type}`);
    }
  }

  private readLatestSnapshotText(): string | null {
    const row = this.db.prepare("SELECT snapshot_text FROM dag_snapshots ORDER BY created_at DESC LIMIT 1").get() as { snapshot_text: string } | undefined;
    return row?.snapshot_text ?? null;
  }
}

export function deriveActivePath(nodes: DagNode[], edges: DagEdge[]): string[] {
  return deriveActivePathSelection(nodes, edges).nodeIds;
}

export function deriveActivePathSelection(nodes: DagNode[], edges: DagEdge[]): DagPathSelection {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = selectRootTask(nodes);
  if (!root) return { nodeIds: [], edgeIds: [] };

  const subgraphIds = taskSubgraphNodeIds(root.id, nodes, edges);
  const incoming = new Map<string, DagEdge[]>();
  for (const edge of edges) {
    if (!subgraphIds.has(edge.source_id) || !subgraphIds.has(edge.target_id)) continue;
    const list = incoming.get(edge.target_id) ?? [];
    list.push(edge);
    incoming.set(edge.target_id, list);
  }

  const frontier = nodes
    .filter((node) => subgraphIds.has(node.id) && node.kind !== "task" && (node.status === "active" || node.status === "blocked"))
    .sort((left, right) => {
      const status = Number(right.status === "blocked") - Number(left.status === "blocked");
      if (status !== 0) return status;
      const importance = right.importance - left.importance;
      if (importance !== 0) return importance;
      const updated = String(right.updated_at).localeCompare(String(left.updated_at));
      if (updated !== 0) return updated;
      const messageIndex = right.last_message_index - left.last_message_index;
      if (messageIndex !== 0) return messageIndex;
      return left.id.localeCompare(right.id);
    });

  const memo = new Map<string, DagPathSelection | null>();
  for (const node of frontier) {
    const path = pathToRoot(node.id, root.id, byId, incoming, new Set<string>(), memo);
    if (path) return path;
  }

  if (root.status === "failed" || root.status === "frozen") {
    return { nodeIds: [root.id], edgeIds: [] };
  }
  return completedPathFromRoot(root, nodes, edges, subgraphIds) ?? { nodeIds: [root.id], edgeIds: [] };
}

export function selectRootTask(nodes: DagNode[]): DagNode | null {
  const tasks = nodes.filter((node) => node.kind === "task");
  const active = tasks.filter((node) => node.status === "active" || node.status === "blocked");
  const candidates = active.length ? active : tasks.filter((node) => node.status !== "frozen");
  const sorted = [...(candidates.length ? candidates : tasks)].sort((left, right) => {
    const updated = String(right.updated_at).localeCompare(String(left.updated_at));
    if (updated !== 0) return updated;
    const importance = right.importance - left.importance;
    if (importance !== 0) return importance;
    return left.id.localeCompare(right.id);
  });
  return sorted[0] ?? null;
}

function taskTransitionTypeForStatus(status: DagNode["status"]): "continues" | "supersedes" {
  if (status === "done" || status === "failed") return "continues";
  if (status === "frozen") return "supersedes";
  throw new Error(`DAG task transition old root status ${status} is not terminal`);
}

function taskSubgraphNodeIds(rootId: string, nodes: DagNode[], edges: DagEdge[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bySource = new Map<string, DagEdge[]>();
  for (const edge of edges) {
    const list = bySource.get(edge.source_id) ?? [];
    list.push(edge);
    bySource.set(edge.source_id, list);
  }
  const out = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const edge of bySource.get(id) ?? []) {
      const target = byId.get(edge.target_id);
      if (target && target.kind !== "task") queue.push(target.id);
    }
  }
  return out;
}

function pathToRoot(
  nodeId: string,
  rootId: string,
  byId: Map<string, DagNode>,
  incoming: Map<string, DagEdge[]>,
  visiting: Set<string>,
  memo: Map<string, DagPathSelection | null>,
): DagPathSelection | null {
  if (nodeId === rootId) return { nodeIds: [rootId], edgeIds: [] };
  if (memo.has(nodeId)) return memo.get(nodeId) ?? null;
  if (visiting.has(nodeId)) return null;

  const node = byId.get(nodeId);
  if (!node || node.kind === "task") return null;
  visiting.add(nodeId);
  const candidates = (incoming.get(nodeId) ?? [])
    .filter((edge) => isActivePathEdge(edge, node, rootId, byId))
    .sort((left, right) => compareParentEdges(left, right, node, rootId, byId));
  for (const edge of candidates) {
    const prefix = pathToRoot(edge.source_id, rootId, byId, incoming, visiting, memo);
    if (!prefix) continue;
    const path = {
      nodeIds: [...prefix.nodeIds, nodeId],
      edgeIds: [...prefix.edgeIds, edge.id],
    };
    visiting.delete(nodeId);
    memo.set(nodeId, path);
    return path;
  }
  visiting.delete(nodeId);
  memo.set(nodeId, null);
  return null;
}

function isActivePathEdge(edge: DagEdge, target: DagNode, rootId: string, byId: Map<string, DagNode>): boolean {
  const source = byId.get(edge.source_id);
  if (!source || target.kind === "task") return false;
  if (source.id === rootId) return source.kind === "task" && edge.type === "decomposes";
  if (source.kind === "task") return false;
  if (edge.type === "blocks") return target.status === "blocked";
  if (edge.type === "supersedes") return source.status === "frozen";
  return edge.type === "continues" && source.status !== "failed" && source.status !== "frozen";
}

function compareParentEdges(left: DagEdge, right: DagEdge, target: DagNode, rootId: string, byId: Map<string, DagNode>): number {
  const leftSource = byId.get(left.source_id)!;
  const rightSource = byId.get(right.source_id)!;
  const rank = activeParentEdgeRank(left, leftSource, target, rootId) - activeParentEdgeRank(right, rightSource, target, rootId);
  if (rank !== 0) return rank;
  const importance = rightSource.importance - leftSource.importance;
  if (importance !== 0) return importance;
  const updated = String(rightSource.updated_at).localeCompare(String(leftSource.updated_at));
  if (updated !== 0) return updated;
  const created = String(right.created_at).localeCompare(String(left.created_at));
  if (created !== 0) return created;
  const sourceId = leftSource.id.localeCompare(rightSource.id);
  return sourceId || left.id.localeCompare(right.id);
}

function activeParentEdgeRank(edge: DagEdge, source: DagNode, target: DagNode, rootId: string): number {
  if (edge.type === "blocks" && target.status === "blocked") return 0;
  if (edge.type === "supersedes" && source.status === "frozen") return 1;
  if (edge.type === "continues") return 2;
  if (edge.type === "decomposes" && source.id === rootId) return 3;
  return 4;
}

function completedPathFromRoot(
  root: DagNode,
  nodes: DagNode[],
  edges: DagEdge[],
  subgraphIds: Set<string>,
): DagPathSelection | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, DagEdge[]>();
  for (const edge of edges) {
    if (!subgraphIds.has(edge.source_id) || !subgraphIds.has(edge.target_id)) continue;
    const list = outgoing.get(edge.source_id) ?? [];
    list.push(edge);
    outgoing.set(edge.source_id, list);
  }
  const memo = new Map<string, DagPathSelection>();
  const paths = (outgoing.get(root.id) ?? [])
    .filter((edge) => edge.type === "decomposes" && isDoneChild(edge.target_id, byId))
    .map((edge) => {
      const suffix = bestCompletedSuffix(edge.target_id, byId, outgoing, new Set<string>(), memo);
      return {
        nodeIds: [root.id, ...suffix.nodeIds],
        edgeIds: [edge.id, ...suffix.edgeIds],
      };
    });
  return bestCompletedPath(paths, byId);
}

function bestCompletedSuffix(
  nodeId: string,
  byId: Map<string, DagNode>,
  outgoing: Map<string, DagEdge[]>,
  visiting: Set<string>,
  memo: Map<string, DagPathSelection>,
): DagPathSelection {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const self = { nodeIds: [nodeId], edgeIds: [] };
  if (visiting.has(nodeId)) return self;

  visiting.add(nodeId);
  const paths: DagPathSelection[] = [self];
  for (const edge of outgoing.get(nodeId) ?? []) {
    if (edge.type !== "continues" || visiting.has(edge.target_id) || !isDoneChild(edge.target_id, byId)) continue;
    const suffix = bestCompletedSuffix(edge.target_id, byId, outgoing, visiting, memo);
    paths.push({
      nodeIds: [nodeId, ...suffix.nodeIds],
      edgeIds: [edge.id, ...suffix.edgeIds],
    });
  }
  visiting.delete(nodeId);
  const best = bestCompletedPath(paths, byId) ?? self;
  memo.set(nodeId, best);
  return best;
}

function isDoneChild(nodeId: string, byId: Map<string, DagNode>): boolean {
  const node = byId.get(nodeId);
  return node?.kind !== "task" && node?.status === "done";
}

function bestCompletedPath(paths: DagPathSelection[], byId: Map<string, DagNode>): DagPathSelection | null {
  return paths.sort((left, right) => compareCompletedPaths(left, right, byId))[0] ?? null;
}

function compareCompletedPaths(left: DagPathSelection, right: DagPathSelection, byId: Map<string, DagNode>): number {
  const leftTerminal = byId.get(left.nodeIds[left.nodeIds.length - 1]);
  const rightTerminal = byId.get(right.nodeIds[right.nodeIds.length - 1]);
  const messageIndex = (rightTerminal?.last_message_index ?? -1) - (leftTerminal?.last_message_index ?? -1);
  if (messageIndex !== 0) return messageIndex;
  const updated = String(rightTerminal?.updated_at ?? "").localeCompare(String(leftTerminal?.updated_at ?? ""));
  if (updated !== 0) return updated;
  const importance = (rightTerminal?.importance ?? -1) - (leftTerminal?.importance ?? -1);
  if (importance !== 0) return importance;
  const edgeCount = right.edgeIds.length - left.edgeIds.length;
  if (edgeCount !== 0) return edgeCount;
  const nodeIds = left.nodeIds.join("\0").localeCompare(right.nodeIds.join("\0"));
  return nodeIds || left.edgeIds.join("\0").localeCompare(right.edgeIds.join("\0"));
}

function toContextNode(node: DagNode): DagContextNode {
  return {
    id: node.id,
    kind: node.kind,
    status: node.status,
    title: node.title,
    summary: node.summary,
    importance: node.importance,
    created_by: node.created_by,
    updated_by: node.updated_by,
    source_refs: node.source_refs,
    updated_turn_id: node.updated_turn_id,
    first_message_index: node.first_message_index,
    last_message_index: node.last_message_index,
  };
}

function parseNodeRow(row: DagNodeRow): DagNode {
  return {
    ...row,
    detail_json: sanitizeDetailJson(row.kind, parseJsonObject(row.detail_json)),
    source_refs: sanitizeSourceRefs(parseJsonArray(row.source_refs_json), row.updated_turn_id),
  };
}

function parseJsonObject(text: string): DagDetailJson {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DagDetailJson) : {};
  } catch {
    return {};
  }
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function newSortableId(): string {
  const time = Date.now();
  let encoded = "";
  let value = time;
  for (let i = 0; i < 10; i += 1) {
    encoded = CROCKFORD[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  const bytes = randomBytes(10);
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte & 31];
  return `${encoded}${random}`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dag_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dag_turns (
  turn_id TEXT PRIMARY KEY,
  message_start INTEGER NOT NULL,
  message_end INTEGER NOT NULL,
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dag_status TEXT NOT NULL DEFAULT 'pending' CHECK(dag_status IN ('pending', 'running', 'retry', 'done', 'blocked')),
  build_mode TEXT CHECK(build_mode IN ('llm_patch', 'deterministic_fallback')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  running_started_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  processed_at TEXT,
  CHECK(message_end > message_start)
);

CREATE TABLE IF NOT EXISTS dag_nodes (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('task', 'subtask', 'decision')),
  status TEXT NOT NULL CHECK(status IN ('active', 'done', 'failed', 'blocked', 'frozen')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
  importance INTEGER NOT NULL DEFAULT 0 CHECK(importance BETWEEN 0 AND 100),
  created_turn_id TEXT REFERENCES dag_turns(turn_id),
  updated_turn_id TEXT REFERENCES dag_turns(turn_id),
  first_message_index INTEGER NOT NULL DEFAULT 0,
  last_message_index INTEGER NOT NULL DEFAULT 0,
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json)),
  created_by TEXT NOT NULL DEFAULT 'llm_patch' CHECK(created_by IN ('llm_patch', 'deterministic_fallback', 'repair')),
  updated_by TEXT NOT NULL DEFAULT 'llm_patch' CHECK(updated_by IN ('llm_patch', 'deterministic_fallback', 'repair')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(last_message_index >= first_message_index)
);

CREATE TABLE IF NOT EXISTS dag_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES dag_nodes(id),
  target_id TEXT NOT NULL REFERENCES dag_nodes(id),
  type TEXT NOT NULL CHECK(type IN ('decomposes', 'continues', 'blocks', 'supersedes')),
  created_turn_id TEXT REFERENCES dag_turns(turn_id),
  created_by TEXT NOT NULL DEFAULT 'llm_patch' CHECK(created_by IN ('llm_patch', 'deterministic_fallback', 'repair')),
  created_at TEXT NOT NULL,
  UNIQUE(source_id, target_id, type),
  CHECK(source_id <> target_id)
);

CREATE TABLE IF NOT EXISTS dag_snapshots (
  id TEXT PRIMARY KEY,
  turn_id TEXT REFERENCES dag_turns(turn_id),
  summary_mode TEXT NOT NULL CHECK(summary_mode = 'dag'),
  snapshot_text TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dag_turns_status_message_start ON dag_turns(dag_status, message_start);
CREATE INDEX IF NOT EXISTS idx_dag_turns_message_end ON dag_turns(message_end);
CREATE INDEX IF NOT EXISTS idx_dag_nodes_kind_status ON dag_nodes(kind, status);
CREATE INDEX IF NOT EXISTS idx_dag_nodes_importance ON dag_nodes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_dag_edges_source ON dag_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_target ON dag_edges(target_id);
`;
