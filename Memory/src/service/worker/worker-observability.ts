import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { QUEUE_LANES, RESOURCE_CLASSES, type ResourceClass } from "./job-policy-registry.js";

export type AdmissionRejectReason = "global" | "background" | "resource" | "scope" | "provider" | "embedding_request" | "batch" | "closing" | "share_invalid";
export type WorkerSkipReason = AdmissionRejectReason | "budget" | "configuration" | "dependency" | "unknown";
export type WorkerMetricOutcome = "succeeded" | "failed" | "released" | "fenced";
export interface ObservedWorkerWork {
  lane?: string | null;
  queue: "main" | "embedding_retry";
  firstQueuedAt?: string | null;
  leaseCount?: number;
  leaseRecoveryCount?: number;
  selectionReason?: "wrr" | "aging" | "interactive" | "legacy";
}
export interface ObservedConcurrency {
  activeJobs: number; maxActiveJobs: number;
  backgroundActiveJobs?: number; maxBackgroundJobs?: number; interactiveReservedSlots?: number;
  resources: Readonly<Record<string, number>>;
  resourceLimits: Readonly<Record<ResourceClass, number>>;
  providers: ReadonlyArray<{ key: string; active: number; limit: number }>;
  embeddingRequests: number; embeddingRequestLimit: number;
}
/** Only metadata is accepted. Do not add IDs, scope values, endpoint URLs or model inputs. */
export type WorkerObservation =
  | { type: "claimed" | "started"; work: ObservedWorkerWork }
  | { type: "finished"; work: ObservedWorkerWork; outcome: WorkerMetricOutcome }
  | { type: "skipped"; lane?: string | null; reason: WorkerSkipReason }
  | { type: "lease"; queue: "main" | "embedding_retry"; action: "renewed" | "renew_failed" | "expired" | "recovered" | "fenced"; count?: number }
  | { type: "admission_rejected"; reason: AdmissionRejectReason }
  | { type: "concurrency"; state: ObservedConcurrency }
  | { type: "model_request"; providerKey: string; modelKey: string; kind: "summary" | "evolution" | "embedding";
      durationMs: number; outcome: "succeeded" | "failed"; failure?: "429" | "timeout" | "other"; batchSize?: number }
  | { type: "tokens"; providerKey: string; modelKey: string; kind: "summary" | "evolution" | "embedding";
      inputTokens: number; outputTokens: number; totalTokens: number };
export interface WorkerObserver { record(event: WorkerObservation): void }
export function observeWorker(observer: WorkerObserver | undefined, event: WorkerObservation): void {
  try { observer?.record(event); } catch { /* Metrics never affect transactions, admission or execution. */ }
}

type Sample = { at: number; value: number };
class Samples {
  private readonly values: Sample[] = [];
  private next = 0;
  constructor(private readonly capacity: number) {}
  add(at: number, value: number): void {
    const sample = { at, value };
    if (this.values.length < this.capacity) this.values.push(sample);
    else { this.values[this.next] = sample; this.next = (this.next + 1) % this.capacity; }
  }
  snapshot(since: number, until: number) {
    const values = this.values.filter(sample => sample.at >= since && sample.at <= until).map(sample => sample.value).sort((a, b) => a - b);
    const p = (fraction: number) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
    return { sampleCount: values.length, p50: p(0.5), p95: p(0.95), max: values.at(-1) ?? null };
  }
}
interface Bucket { at: number; counts: Map<string, number>; peaks: Map<string, number> }
export interface WorkerQueueMetric {
  lane: string; queued: number; failed: number; leased: number; dueTimeOnly: number;
  oldestWaitingAt: string | null;
}
export interface WorkerObservabilityOptions {
  now?: () => number;
  /** Fixed production defaults: five minute window and thirty second log interval. */
  windowMs?: number;
  logIntervalMs?: number;
  queueSnapshot?: (atMs: number) => WorkerQueueMetric[];
  write?: (snapshot: Record<string, unknown>) => void;
}
const LANE_KEYS = [...QUEUE_LANES, "unknown"] as const;
const MODEL_LIMIT = 32;
const PROVIDER_LIMIT = 32;
const BUCKET_MS = 10_000;
const laneKey = (lane: unknown): string => (QUEUE_LANES as readonly unknown[]).includes(lane) ? String(lane) : "unknown";
const key = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
const count = (value: number | undefined): number => Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : 0;

/** Bounded process-local diagnostics. All counters describe this process and rolling window, not durable history. */
export class WorkerObservability implements WorkerObserver {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly logIntervalMs: number;
  private readonly buckets: Bucket[] = [];
  private readonly waits = new Map(LANE_KEYS.map(lane => [lane as string, new Samples(512)]));
  private readonly models = new Map<string, { provider: string; model: string; kind: string; durations: Samples; batches: Samples }>();
  private readonly providerKeys = new Set<string>();
  private current?: ObservedConcurrency;
  private lastLoggedAt: number;
  private readonly startedAt: number;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: WorkerObservabilityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 300_000;
    this.logIntervalMs = options.logIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs < BUCKET_MS || this.windowMs > 3_600_000 ||
        !Number.isSafeInteger(this.logIntervalMs) || this.logIntervalMs < 1 || this.logIntervalMs > 3_600_000) throw new RangeError("Invalid worker metrics window");
    this.lastLoggedAt = this.startedAt = this.now();
  }
  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.flush(), this.logIntervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush(true);
  }
  record(event: WorkerObservation): void {
    if (this.stopped) return;
    const at = this.now();
    const bucket = this.bucket(at);
    const add = (name: string, value = 1) => bucket.counts.set(name, (bucket.counts.get(name) ?? 0) + value);
    if (event.type === "claimed" || event.type === "started" || event.type === "finished") {
      const lane = laneKey(event.work.lane);
      add(`lane.${lane}.${event.type}`);
      if (event.type === "claimed") {
        add(`queue.${event.work.queue}.claimed`);
        const reason = ["wrr", "aging", "interactive", "legacy"].includes(event.work.selectionReason ?? "")
          ? event.work.selectionReason : "unspecified";
        add(`selection.${lane}.${reason}`);
        // Record recoveries on the separately reported transition, not repeatedly
        // on every future claim of an item which recovered once in the past.
        if (count(event.work.leaseRecoveryCount)) add(`queue.${event.work.queue}.claims_with_recovery_history`);
      }
      if (event.type === "started") {
        const queuedAt = Date.parse(event.work.firstQueuedAt ?? "");
        if (Number.isFinite(queuedAt)) this.waits.get(lane)!.add(at, Math.max(0, at - queuedAt));
        else add(`lane.${lane}.unknown_wait`);
      }
      if (event.type === "finished") add(`lane.${lane}.${event.outcome}`);
    } else if (event.type === "skipped") add(`skip.${laneKey(event.lane)}.${event.reason}`);
    else if (event.type === "admission_rejected") add(`admission_rejected.${event.reason}`);
    else if (event.type === "lease") add(`lease.${event.queue}.${event.action}`, event.count === undefined ? 1 : count(event.count));
    else if (event.type === "concurrency") {
      // Bound labels across configuration churn, not just within one snapshot.
      const providerValues = new Map<string, { key: string; active: number; limit: number }>();
      for (const provider of event.state.providers) {
        let id = key(provider.key);
        if (!this.providerKeys.has(id)) {
          if (this.providerKeys.size < PROVIDER_LIMIT) this.providerKeys.add(id); else id = "overflow";
        }
        const value = providerValues.get(id) ?? { key: id, active: 0, limit: 0 };
        value.active += count(provider.active); value.limit += count(provider.limit); providerValues.set(id, value);
      }
      this.current = { activeJobs: count(event.state.activeJobs), maxActiveJobs: count(event.state.maxActiveJobs),
        backgroundActiveJobs: count(event.state.backgroundActiveJobs), maxBackgroundJobs: count(event.state.maxBackgroundJobs),
        interactiveReservedSlots: count(event.state.interactiveReservedSlots),
        resources: Object.fromEntries(RESOURCE_CLASSES.map(resource => [resource, count(event.state.resources[resource])])),
        resourceLimits: Object.fromEntries(RESOURCE_CLASSES.map(resource => [resource, count(event.state.resourceLimits[resource])])) as Record<ResourceClass, number>,
        embeddingRequests: count(event.state.embeddingRequests), embeddingRequestLimit: count(event.state.embeddingRequestLimit),
        providers: [...providerValues.values()] };
      const peak = (name: string, value: number) => bucket.peaks.set(name, Math.max(bucket.peaks.get(name) ?? 0, value));
      peak("background", count(event.state.backgroundActiveJobs)); peak("global", event.state.activeJobs); peak("embedding_request", event.state.embeddingRequests);
      for (const resource of RESOURCE_CLASSES) peak(`resource.${resource}`, event.state.resources[resource] ?? 0);
      for (const provider of this.current.providers) peak(`provider.${provider.key}`, provider.active);
    } else if (event.type === "tokens" || event.type === "model_request") {
      const series = this.modelSeries(event.providerKey, event.modelKey, event.kind);
      if (event.type === "tokens") {
        add(`model.${series.id}.usage_reports`);
        add(`model.${series.id}.input_tokens`, count(event.inputTokens));
        add(`model.${series.id}.output_tokens`, count(event.outputTokens));
        add(`model.${series.id}.total_tokens`, count(event.totalTokens));
      } else {
        add(`model.${series.id}.requests`); add(`model.${series.id}.${event.outcome}`);
        if (event.failure) add(`model.${series.id}.${event.failure}`);
        series.value.durations.add(at, Math.max(0, event.durationMs));
        if (event.batchSize !== undefined) series.value.batches.add(at, count(event.batchSize));
      }
    }
  }
  snapshot(): Record<string, unknown> {
    const at = this.now(), since = at - this.windowMs;
    this.prune(at);
    const counts = new Map<string, number>(), peaks = new Map<string, number>();
    for (const bucket of this.buckets) {
      if (bucket.at > at) continue;
      for (const [name, value] of bucket.counts) counts.set(name, (counts.get(name) ?? 0) + value);
      for (const [name, value] of bucket.peaks) peaks.set(name, Math.max(peaks.get(name) ?? 0, value));
    }
    // A long-running reservation may span an entire window without a change
    // event. Its current occupancy still belongs to that window's peak.
    if (this.current) {
      const peak = (name: string, value: number) => peaks.set(name, Math.max(peaks.get(name) ?? 0, value));
      peak("background", count(this.current.backgroundActiveJobs)); peak("global", this.current.activeJobs); peak("embedding_request", this.current.embeddingRequests);
      for (const resource of RESOURCE_CLASSES) peak(`resource.${resource}`, this.current.resources[resource] ?? 0);
      for (const provider of this.current.providers) peak(`provider.${provider.key}`, provider.active);
    }
    const elapsedMinutes = Math.max(1 / 60, Math.min(this.windowMs, at - this.startedAt) / 60_000);
    let queue: WorkerQueueMetric[] = [], queueSnapshotError = false;
    try { queue = this.options.queueSnapshot?.(at) ?? []; } catch { queueSnapshotError = true; }
    const queueSnapshotAvailable = Boolean(this.options.queueSnapshot) && !queueSnapshotError;
    return {
      windowMs: this.windowMs, bucketMs: BUCKET_MS, processLocal: true,
      rateDenominatorMs: elapsedMinutes * 60_000,
      counterBasis: "rolling_10s_buckets_including_boundary_bucket_future_buckets_excluded_on_clock_rollback_oldest_evicted_at_hard_cap",
      waitBasis: "started_in_window_total_since_first_queued_at_last_512_per_lane",
      requestBasis: "logical_request_operation_only_excludes_permit_wait_includes_delegate_internal_retries",
      embeddingBatchBasis: "texts_submitted_to_delegate_which_may_further_split_or_cache",
      dueBasis: "time_metadata_only_not_dependency_configuration_or_permit_admissibility",
      skipBasis: "candidate_scan_attempts_not_distinct_waiting_jobs",
      tokenBasis: "reported_usage_only_missing_usage_is_unknown",
      leaseBasis: "process_events_in_window_not_complete_historical_claim_or_recovery_totals",
      completionBasis: "execution_attempts_succeeded_or_failed_not_distinct_terminal_jobs",
      utilizationBasis: "instantaneous_active_divided_by_limit_not_time_weighted",
      runnableBasis: "successful_admissions_only_not_a_full_queue_runnable_census",
      queueSnapshotError,
      queueSnapshotAvailable,
      lanes: Object.fromEntries(LANE_KEYS.map(lane => {
        const rows = queue.filter(row => laneKey(row.lane) === lane);
        const oldest = rows.flatMap(row => row.oldestWaitingAt ? [Date.parse(row.oldestWaitingAt)] : []).filter(Number.isFinite);
        const sum = (field: "queued" | "failed" | "leased" | "dueTimeOnly") => queueSnapshotAvailable
          ? rows.reduce((total, row) => total + row[field], 0) : null;
        return [lane, { queued: sum("queued"), failed: sum("failed"), leased: sum("leased"), dueTimeOnly: sum("dueTimeOnly"),
          oldestWaitingAgeMs: oldest.length ? Math.max(0, at - Math.min(...oldest)) : null,
          waitMs: this.waits.get(lane)!.snapshot(since, at),
          admitted: counts.get(`lane.${lane}.claimed`) ?? 0, started: counts.get(`lane.${lane}.started`) ?? 0,
          succeeded: counts.get(`lane.${lane}.succeeded`) ?? 0, failedInWindow: counts.get(`lane.${lane}.failed`) ?? 0,
          completedPerMinute: ((counts.get(`lane.${lane}.succeeded`) ?? 0) + (counts.get(`lane.${lane}.failed`) ?? 0)) / elapsedMinutes }];
      })),
      concurrency: this.current ? { ...this.current, peaks: Object.fromEntries(peaks), providerSeriesLimit: PROVIDER_LIMIT,
        overflowBasis: "additional_provider_reservations_aggregated_not_a_single_provider_limit",
        utilization: { global: this.current.activeJobs / this.current.maxActiveJobs,
          embeddingRequest: this.current.embeddingRequests / this.current.embeddingRequestLimit,
          resources: Object.fromEntries(RESOURCE_CLASSES.map(resource => [resource,
            (this.current!.resources[resource] ?? 0) / this.current!.resourceLimits[resource]])) } } : null,
      models: [...this.models].map(([id, model]) => ({ id, provider: model.provider, model: model.model, kind: model.kind,
        latencyMs: model.durations.snapshot(since, at), embeddingBatchSize: model.batches.snapshot(since, at),
        requests: counts.get(`model.${id}.requests`) ?? 0, failed: counts.get(`model.${id}.failed`) ?? 0,
        failureRate: counts.get(`model.${id}.requests`) ? (counts.get(`model.${id}.failed`) ?? 0) / counts.get(`model.${id}.requests`)! : null,
        rateLimited: counts.get(`model.${id}.429`) ?? 0, timedOut: counts.get(`model.${id}.timeout`) ?? 0,
        usageReports: counts.get(`model.${id}.usage_reports`) ?? 0,
        reportedTokens: counts.get(`model.${id}.usage_reports`) ? { input: counts.get(`model.${id}.input_tokens`) ?? 0,
          output: counts.get(`model.${id}.output_tokens`) ?? 0, total: counts.get(`model.${id}.total_tokens`) ?? 0 } : null })),
      counters: Object.fromEntries(counts)
    };
  }
  flush(final = false): void {
    try {
      if (!final && (this.stopped || this.now() - this.lastLoggedAt < this.logIntervalMs)) return;
      this.lastLoggedAt = this.now();
      const snapshot = { ...this.snapshot(), final };
      if (this.options.write) this.options.write(snapshot);
      // The ordinary human-readable logger intentionally clips long fields;
      // emit this bounded, metadata-only snapshot as one complete JSON line.
      else if (!["silent", "warn", "error"].includes(process.env.MEMMY_LOG_LEVEL?.trim().toLowerCase() ?? "info")) process.stdout.write(`${JSON.stringify({
        timestamp: new Date(this.now()).toISOString(), level: "info", component: "worker-metrics", event: "worker.metrics",
        message: "[worker-metrics] worker.metrics", metrics: snapshot
      })}\n`);
    } catch { /* Failed metrics collection or logging must not interrupt shutdown. */ }
  }
  private bucket(at: number): Bucket {
    this.prune(at);
    const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.find(value => value.at === start);
    if (!bucket) {
      bucket = { at: start, counts: new Map(), peaks: new Map() }; this.buckets.push(bucket);
      this.buckets.sort((a, b) => a.at - b.at);
    }
    // Wall clocks can move backwards repeatedly. Retaining duplicate or future
    // buckets must never turn a rolling diagnostic into unbounded storage.
    const maximum = Math.ceil(this.windowMs / BUCKET_MS) + 2;
    while (this.buckets.length > maximum) this.buckets.shift();
    return bucket;
  }
  private prune(at: number): void {
    while (this.buckets.length && this.buckets[0]!.at < Math.floor((at - this.windowMs) / BUCKET_MS) * BUCKET_MS) this.buckets.shift();
  }
  private modelSeries(providerKey: string, modelKey: string, kind: string) {
    let id = key(`${providerKey}:${modelKey}:${kind}`);
    if (!this.models.has(id)) {
      if (this.models.size >= MODEL_LIMIT) id = "overflow";
      if (!this.models.has(id)) this.models.set(id, { provider: id === "overflow" ? "overflow" : key(providerKey),
        model: id === "overflow" ? "overflow" : key(modelKey), kind: id === "overflow" ? "mixed" : kind,
        durations: new Samples(256), batches: new Samples(256) });
    }
    return { id, value: this.models.get(id)! };
  }
}

/** Read only counts and timestamps; never hydrate memory bodies, payloads or vectors. */
export function readWorkerQueueMetrics(db: Database.Database, atMs: number): WorkerQueueMetric[] {
  const at = new Date(atMs).toISOString();
  const main = db.prepare(`SELECT queue_lane AS lane,
    SUM(status = 'queued') AS queued, SUM(status = 'failed') AS failed, SUM(status = 'leased') AS leased,
    SUM(status IN ('queued','failed') AND (available_at IS NULL OR available_at <= ?)) AS dueTimeOnly,
    MIN(CASE WHEN status IN ('queued','failed') THEN first_queued_at END) AS oldestWaitingAt
    FROM evolution_jobs WHERE status IN ('queued','failed','leased') GROUP BY queue_lane`).all(at);
  const retry = db.prepare(`SELECT queue_lane AS lane,
    SUM(status = 'pending') AS queued, SUM(status = 'failed') AS failed, SUM(status = 'in_progress') AS leased,
    SUM(status = 'pending' AND next_attempt_at <= ?) AS dueTimeOnly,
    MIN(CASE WHEN status = 'pending' THEN first_queued_at END) AS oldestWaitingAt
    FROM embedding_retry_queue WHERE status IN ('pending','failed','in_progress') GROUP BY queue_lane`).all(atMs);
  return [...main, ...retry] as WorkerQueueMetric[];
}
