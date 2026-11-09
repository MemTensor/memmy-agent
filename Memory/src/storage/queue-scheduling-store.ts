import type Database from "better-sqlite3";
import {
  jobPolicyRegistry, JOB_POLICY_VERSION, QUEUE_LANES,
  type QueueLane, UnknownJobPolicyError
} from "../service/worker/job-policy-registry.js";
import { mainQueueEligibility, retryQueueEligibility, type QueueEligibilityOptions } from "./queue-eligibility.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { activePolicyPredicate, pendingPolicyIndex, pendingPolicyPredicate } from "./queue-scheduling-schema.js";
import { JobLeaseLostError } from "./job-lease-context.js";

const logger = createMemoryLogger("worker");
// Repositories may be recreated around one connection. All its selectors must
// observe reclassification, including refreshOne completing before the next slice.
const selectionRevisions = new WeakMap<Database.Database, number>();

export interface SchedulingCandidate {
  queue: "main" | "embedding_retry";
  id: string;
  jobType: string;
  lane: QueueLane;
  enqueueSeq: number;
  basePriority: number;
  firstQueuedAt?: string | null;
  unregistered?: boolean;
}
export interface SchedulingMetadata {
  queueLane?: string | null;
  resourceClass?: string | null;
  enqueueSeq?: number | null;
  firstQueuedAt?: string | null;
  basePriority?: number | null;
  policyVersion?: number | null;
}
interface PolicyRow {
  id: string; job_type: string; payload_json: string; agent_id: string | null;
  memory_layer: string | null; tags_json: string | null; plugin_algorithm: string | null; capture_origin: unknown;
  previous_queue_lane: string | null;
  policy_promotion: string | null;
  status: string;
}
export interface PolicyRefreshResult {
  refreshed: number;
  unknown: Array<{ id: string; jobType: string }>;
  /** Present for active/runnable maintenance; runnable probes may conservatively report an exhausted budget. */
  hasMore?: boolean;
}

/** A metadata projection and read-only candidate adapter; never claims or completes jobs. */
export class QueueSchedulingStore {
  // Cache statements, never eligibility results; each store owns one connection.
  private readonly eligibilityStatements = new Map<string, Database.Statement>();

  constructor(private readonly db: Database.Database) {}

  getDeadlineRevision(): { revision: number; rescanRevision: number } {
    return this.db.prepare("SELECT revision, rescan_revision AS rescanRevision FROM worker_deadline_revision WHERE singleton = 1")
      .get() as { revision: number; rescanRevision: number };
  }

  getSelectionRevision(): number {
    return selectionRevisions.get(this.db) ?? 0;
  }

  isPendingCandidate(candidate: SchedulingCandidate): boolean {
    const table = candidate.queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND enqueue_seq = ?
      AND ${activePolicyPredicate(table)}`).get(candidate.id, candidate.enqueueSeq);
  }

  isEligibleCandidate(candidate: SchedulingCandidate, at: string, options: QueueEligibilityOptions): boolean {
    const condition = candidate.queue === "main" ? mainQueueEligibility(at, options)
      : retryQueueEligibility(Date.parse(at), options.targetMemoryIds);
    const table = candidate.queue === "main" ? "evolution_jobs" : "embedding_retry_queue q";
    const sql = `SELECT 1 FROM ${table} WHERE ${condition.sql} AND id = ? AND enqueue_seq = ?`;
    let statement = this.eligibilityStatements.get(sql);
    if (statement) {
      this.eligibilityStatements.delete(sql);
    } else {
      statement = this.db.prepare(sql);
      // Filters can produce different placeholder counts. Keep the cache bounded.
      if (this.eligibilityStatements.size >= 32) {
        const oldest = this.eligibilityStatements.keys().next().value;
        if (oldest !== undefined) this.eligibilityStatements.delete(oldest);
      }
    }
    this.eligibilityStatements.set(sql, statement);
    return !!statement.get(...condition.params, candidate.id, candidate.enqueueSeq);
  }

  readSnapshot<T>(read: () => T): T {
    return this.db.transaction(read)();
  }

  refreshPolicies(limit = 500): PolicyRefreshResult {
    return this.refreshPendingPolicies(Math.max(0, limit), false, true);
  }

  /** Admission maintenance is independent of eligibility. Even delayed/blocked
   * dirty tasks leave the worklist after one bounded visit; they cannot be scanned
   * again on every refill. Terminal history is absent from the active index. */
  refreshActivePolicies(input: { maxRows?: number; includeRetries?: boolean } = {}): PolicyRefreshResult {
    if (input.maxRows !== undefined && (!Number.isSafeInteger(input.maxRows) || input.maxRows < 0)) {
      throw new RangeError("maxRows must be a non-negative safe integer");
    }
    return this.refreshPendingPolicies(input.maxRows, true, input.includeRetries !== false);
  }

  private refreshPendingPolicies(limit: number | undefined, active: boolean, includeRetries: boolean): PolicyRefreshResult {
    const result: PolicyRefreshResult = { refreshed: 0, unknown: [], ...(active ? { hasMore: false } : {}) };
    if (this.db.readonly) return result;
    return this.db.transaction(() => {
      for (const queue of ["main", "embedding_retry"] as const) {
        if (queue === "embedding_retry" && !includeRetries) continue;
        const table = queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
        const target = queue === "main" ? "q.target_memory_id" : "q.target_id";
        const predicate = `${pendingPolicyPredicate}${active ? ` AND ${activePolicyPredicate(table, "q.")}` : ""}`;
        for (;;) {
          const remaining = limit === undefined ? 200 : Math.min(200, limit - result.refreshed);
          if (remaining === 0) {
            if (active && this.db.prepare(`SELECT 1 FROM ${table} q INDEXED BY ${pendingPolicyIndex(table, active)}
              WHERE ${predicate} LIMIT 1`).get()) result.hasMore = true;
            break;
          }
          const rows = this.db.prepare(`SELECT q.id, q.queue_lane AS previous_queue_lane, q.policy_promotion, q.status,
            ${queue === "main" ? "q.job_type, q.payload_json" : "'embedding_retry' AS job_type, '{}' AS payload_json"},
            m.agent_id, m.memory_layer, m.tags_json,
            json_extract(m.properties_json, '$.internal_info.plugin_algorithm') AS plugin_algorithm,
            json_extract(m.properties_json, '$.internal_info.capture_origin') AS capture_origin
            FROM ${table} q INDEXED BY ${pendingPolicyIndex(table, active)} LEFT JOIN memories m ON m.id = ${target}
            WHERE ${predicate} ORDER BY q.enqueue_seq LIMIT ?`).all(remaining) as PolicyRow[];
          for (const row of rows) this.writePolicy(table, row, result);
          if (rows.length < remaining) break;
        }
      }
      return result;
    })();
  }

  /**
   * Complete the projection for the currently runnable set before real FIFO
   * selection. Callers using maxRows must finish all slices before selecting:
   * an older dirty row may precede an already-classified row in FIFO order.
   * Terminal history, future deadlines and blocked dependencies are skipped.
   */
  refreshRunnablePolicies(input: QueueEligibilityOptions & {
    at: string; includeRetries?: boolean; maxRows?: number;
  }): PolicyRefreshResult {
    if (input.maxRows !== undefined && (!Number.isSafeInteger(input.maxRows) || input.maxRows < 0)) {
      throw new RangeError("maxRows must be a non-negative safe integer");
    }
    const result: PolicyRefreshResult = {
      refreshed: 0, unknown: [], ...(input.maxRows !== undefined ? { hasMore: false } : {})
    };
    if (this.db.readonly) return result;
    const main = mainQueueEligibility(input.at, input);
    const retry = retryQueueEligibility(Date.parse(input.at), input.targetMemoryIds);
    // Start from the event-maintained pending index, then check each dirty ID.
    // Never materialize the whole eligible queue to discover missing metadata.
    return this.db.transaction(() => {
      for (const queue of ["main", "embedding_retry"] as const) {
        if (queue === "embedding_retry" && input.includeRetries === false) continue;
        if ((queue === "main" ? main.sql : retry.sql) === "0") continue;
        const table = queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
        const target = queue === "main" ? "q.target_memory_id" : "q.target_id";
        const ready = queue === "main"
          ? `EXISTS (SELECT 1 FROM evolution_jobs WHERE id = q.id AND (${main.sql}))`
          : retry.sql;
        const parameters = queue === "main" ? main.params : retry.params;
        if (input.maxRows === 0) {
          const found = this.db.prepare(`SELECT 1 FROM ${table} q INDEXED BY ${pendingPolicyIndex(table)}
            WHERE ${pendingPolicyPredicate} AND (${ready}) LIMIT 1`)
            .get(...parameters);
          if (found) { result.hasMore = true; return result; }
          continue;
        }
        for (;;) {
          const remaining = input.maxRows === undefined ? 200 : Math.min(200, input.maxRows - result.refreshed);
          if (remaining === 0) { result.hasMore = true; return result; }
          const rows = this.db.prepare(`SELECT q.id, q.queue_lane AS previous_queue_lane, q.policy_promotion, q.status,
            ${queue === "main" ? "q.job_type, q.payload_json" : "'embedding_retry' AS job_type, '{}' AS payload_json"},
            m.agent_id, m.memory_layer, m.tags_json,
            json_extract(m.properties_json, '$.internal_info.plugin_algorithm') AS plugin_algorithm,
            json_extract(m.properties_json, '$.internal_info.capture_origin') AS capture_origin
            FROM ${table} q INDEXED BY ${pendingPolicyIndex(table)} LEFT JOIN memories m ON m.id = ${target}
            WHERE ${pendingPolicyPredicate} AND (${ready})
            ORDER BY q.enqueue_seq LIMIT ?`).all(...parameters, remaining) as PolicyRow[];
          if (rows.length === 0) break;
          for (const row of rows) this.writePolicy(table, row, result);
        }
      }
      return result;
    })();
  }

  refreshOne(queue: SchedulingCandidate["queue"], id: string): PolicyRefreshResult {
    const result: PolicyRefreshResult = { refreshed: 0, unknown: [] };
    try {
      const table = queue === "main" ? "evolution_jobs" : "embedding_retry_queue";
      const target = queue === "main" ? "q.target_memory_id" : "q.target_id";
      const row = this.db.prepare(`SELECT q.id, q.queue_lane AS previous_queue_lane, q.policy_promotion, q.status,
        ${queue === "main" ? "q.job_type, q.payload_json" : "'embedding_retry' AS job_type, '{}' AS payload_json"},
        m.agent_id, m.memory_layer, m.tags_json,
        json_extract(m.properties_json, '$.internal_info.plugin_algorithm') AS plugin_algorithm,
        json_extract(m.properties_json, '$.internal_info.capture_origin') AS capture_origin
        FROM ${table} q LEFT JOIN memories m ON m.id = ${target} WHERE q.id = ? AND ${pendingPolicyPredicate}`).get(id) as PolicyRow | undefined;
      if (row) this.writePolicy(table, row, result);
    } catch (error) {
      if (error instanceof JobLeaseLostError) throw error;
      // A projection error must not turn a successful real enqueue into a
      // failed one. Insert/update triggers leave it dirty for a later retry.
      logger.warn("scheduler.policy_refresh_failed", { queue, jobId: id, ...memoryErrorFields(error) });
    }
    return result;
  }

  private writePolicy(table: string, row: PolicyRow, result: PolicyRefreshResult): void {
    let policy: { queueLane: string; resourceClass: string; basePriority: number; policyVersion: number };
    let promotion: "onboarding_first_report" | "manual_retry" | null = null;
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      const tags: unknown = row.tags_json ? JSON.parse(row.tags_json) : [];
      const input = { jobType: row.job_type,
        payload: payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown> : {}, target: {
          agentId: typeof row.agent_id === "string" ? row.agent_id : undefined,
          memoryLayer: typeof row.memory_layer === "string" ? row.memory_layer : undefined,
          tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
          pluginAlgorithm: typeof row.plugin_algorithm === "string" ? row.plugin_algorithm : undefined,
          captureOrigin: typeof row.capture_origin === "string" ? row.capture_origin : undefined
        }
      };
      policy = jobPolicyRegistry.resolve(input);
      // Business urgency, never lane weights: first report > explicit retry >
      // ordinary classification. Keep earned urgency only for this unfinished task.
      const unfinished = table === "evolution_jobs"
        ? ["queued", "leased", "failed"].includes(row.status)
        : ["pending", "in_progress"].includes(row.status);
      if (unfinished) {
        if (row.policy_promotion === "onboarding_first_report" ||
          (policy.queueLane === "interactive" && policy.basePriority === -100)) promotion = "onboarding_first_report";
        else if (row.policy_promotion === "manual_retry" || input.payload.source === "memory.processing.manual_retry") promotion = "manual_retry";
      }
      if (promotion) policy = jobPolicyRegistry.resolve({ ...input, operationMode: promotion });
    } catch (error) {
      if (!(error instanceof UnknownJobPolicyError)) throw error;
      // Keep quarantine explicit. WRR admits these only for terminal cleanup;
      // legacy retains unsupported-type handling. Never silently assign a policy.
      result.unknown.push({ id: row.id, jobType: row.job_type });
      logger.warn("scheduler.unregistered_job", { jobId: row.id, jobType: row.job_type });
      policy = { queueLane: "unregistered", resourceClass: "unregistered",
        basePriority: 0, policyVersion: JOB_POLICY_VERSION };
    }
    const updated = this.db.prepare(`UPDATE ${table} SET queue_lane = ?, resource_class = ?, base_priority = ?, policy_version = ?, policy_promotion = ? WHERE id = ?`)
      .run(policy.queueLane, policy.resourceClass, policy.basePriority, policy.policyVersion, promotion, row.id);
    if (updated.changes > 0 && row.previous_queue_lane !== null) {
      // Do not invalidate deep scans for ordinary new imports. An existing row
      // can change lane/resource/scope even while ending at the same policy version.
      // Rollback may over-invalidate; never roll the revision back to a cached value.
      selectionRevisions.set(this.db, this.getSelectionRevision() + 1);
    }
    result.refreshed++;
  }

  pendingPolicyCount(): number {
    return Number((this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_jobs INDEXED BY ${pendingPolicyIndex("evolution_jobs")} WHERE ${pendingPolicyPredicate}) +
      (SELECT COUNT(*) FROM embedding_retry_queue INDEXED BY ${pendingPolicyIndex("embedding_retry_queue")} WHERE ${pendingPolicyPredicate}) AS n`)
      .get() as { n: number }).n);
  }

  unregisteredPolicyCount(): number {
    return Number((this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_jobs WHERE queue_lane = 'unregistered') +
      (SELECT COUNT(*) FROM embedding_retry_queue WHERE queue_lane = 'unregistered') AS n`)
      .get() as { n: number }).n);
  }

  /** Fetch bounded candidates per lane/table. Type filters apply to main jobs,
   * matching legacy semantics; includeRetries separately gates the retry table. */
  candidates(input: QueueEligibilityOptions & {
    at: string; limit: number; includeRetries?: boolean; includeUnregistered?: boolean;
  }): SchedulingCandidate[] {
    const result: SchedulingCandidate[] = [];
    if (input.limit <= 0) return result;
    for (const lane of QUEUE_LANES) {
      result.push(...this.candidatePage({ ...input, lane, queue: "main" }));
      if (input.includeRetries !== false) result.push(...this.candidatePage({ ...input, lane, queue: "embedding_retry" }));
    }
    return result;
  }

  /** Keyset pages let admission skip busy resources without hiding later FIFO rows. */
  candidatePage(input: QueueEligibilityOptions & {
    at: string; limit: number; queue: SchedulingCandidate["queue"]; lane: QueueLane;
    afterEnqueueSeq?: number; includeUnregistered?: boolean;
    /** Discovery only; ID eligibility and lease CAS still enforce dependencies. */
    includeDependencyBlocked?: boolean;
  }): SchedulingCandidate[] {
    if (input.limit <= 0) return [];
    const main = mainQueueEligibility(input.at, input, input.includeDependencyBlocked);
    const retry = retryQueueEligibility(Date.parse(input.at), input.targetMemoryIds);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
    const includeUnknown = input.includeUnregistered === true && input.lane === "maintenance";
    const laneFilter = includeUnknown ? "queue_lane IN (?, 'unregistered')" : "queue_lane = ?";
    const after = input.afterEnqueueSeq ?? 0;
    if (input.queue === "main") {
      const rows = this.db.prepare(`SELECT id, job_type, queue_lane, enqueue_seq, base_priority, first_queued_at FROM evolution_jobs
        WHERE ${main.sql} AND ${laneFilter} AND policy_version = ? AND enqueue_seq > ?
        ORDER BY enqueue_seq LIMIT ?`).all(...main.params, input.lane, JOB_POLICY_VERSION, after, limit) as Array<{
          id: string; job_type: string; queue_lane: QueueLane | "unregistered"; enqueue_seq: number; base_priority: number; first_queued_at: string | null
        }>;
      return rows.map((row) => ({ queue: "main" as const, id: row.id, jobType: row.job_type,
        lane: row.queue_lane === "unregistered" ? "maintenance" : row.queue_lane,
        enqueueSeq: row.enqueue_seq, basePriority: row.base_priority, firstQueuedAt: row.first_queued_at,
        ...(row.queue_lane === "unregistered" ? { unregistered: true } : {}) }));
    }
    const retries = this.db.prepare(`SELECT q.id, q.queue_lane, q.enqueue_seq, q.base_priority, q.first_queued_at FROM embedding_retry_queue q
      WHERE ${retry.sql} AND q.${laneFilter} AND q.policy_version = ? AND q.enqueue_seq > ?
      ORDER BY q.enqueue_seq LIMIT ?`).all(...retry.params, input.lane, JOB_POLICY_VERSION, after, limit) as Array<{
        id: string; queue_lane: QueueLane | "unregistered"; enqueue_seq: number; base_priority: number; first_queued_at: string | null
      }>;
    return retries.map((row) => ({ queue: "embedding_retry" as const, id: row.id, jobType: "embedding_retry",
      lane: row.queue_lane === "unregistered" ? "maintenance" : row.queue_lane,
      enqueueSeq: row.enqueue_seq, basePriority: row.base_priority, firstQueuedAt: row.first_queued_at,
      ...(row.queue_lane === "unregistered" ? { unregistered: true } : {}) }));
  }
}
