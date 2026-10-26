import type { Embedder } from "../../model/types.js";
import { embeddingIdentity, sameEmbeddingIdentity, type EmbeddingIdentity } from "../../model/embedding-identity.js";
import { kindFromMemory, type EmbeddingRetryVectorField, type Repositories } from "../../storage/repositories.js";
import type { EmbeddingMaintenanceEntry } from "../../storage/sqlite-vec-store.js";
import type { MemoryRow, UserMemoryRecord } from "../../types.js";
import { newId } from "../../utils/id.js";
import { MemoryServiceError } from "../../utils/error.js";
import { embeddingTextForMemory, traceSummaryEmbeddingText, traceActionEmbeddingText } from "./embedding-pipeline.js";
import { canonicalWorkMemoryText } from "../work-memory/work-memory-pipeline.js";

type Mode = "repair" | "rebuild";
type Health = "ready" | "missing" | "dimMismatch" | "modelMismatch";
interface Target {
  id: string;
  kind: "memory" | "user_memory";
  vectorField?: EmbeddingRetryVectorField;
  jobId?: string;
  result?: "updated" | "failed";
}
interface Run {
  runId: string;
  mode: Mode;
  identity: EmbeddingIdentity;
  targets: Target[];
  createdAt: string;
  error?: string;
  purpose?: "upgrade";
  dimension?: number;
  initialized?: boolean;
  candidates?: Target[];
  completedAt?: string;
  nextAttemptAt?: number;
}
export const EMBEDDING_PROVENANCE_UPGRADE_KEY = "embedding-provenance-upgrade:v1";
const UPGRADE_RETRY_MS = 5 * 60_000;
export interface EmbeddingMaintenanceStats {
  dimension: number;
  available: boolean;
  totalSlots: number;
  ready: number;
  missing: number;
  dimMismatch: number;
  modelMismatch: number;
  needsRepair: number;
}
export interface EmbeddingMaintenanceRunResult {
  runId: string;
  mode: Mode;
  accepted: true;
  enqueued: number;
  processed: number;
  updated: number;
  failed: number;
  pending: number;
  retrying: number;
  done: boolean;
  statsAfter: EmbeddingMaintenanceStats;
  serverTime: string;
  error?: string;
}
interface Dependencies {
  repos: Repositories;
  embedder: Embedder;
  userId: string;
  enqueueMemory(memory: MemoryRow, text: string, at: string, vectorField?: EmbeddingRetryVectorField): string;
  enqueueUserMemory(memory: UserMemoryRecord, at: string): string;
}

/** Snapshot the selected targets once, then report durable worker outcomes cumulatively. */
export class EmbeddingMaintenance {
  constructor(private readonly deps: Dependencies) {}

  private get key(): string { return `embedding-maintenance:${this.deps.userId}`; }

  private entries(): EmbeddingMaintenanceEntry[] {
    return [...this.deps.repos.vectors.maintenanceEntries(),
      ...this.deps.repos.userMemories.embeddingMaintenanceEntries(this.deps.userId)];
  }

  private snapshot(knownDimension?: number) {
    const entries = this.entries();
    const identity = embeddingIdentity(this.deps.embedder.config);
    const dimensions = new Map<number, number>();
    for (const entry of entries) {
      if (entry.dimension > 0 && sameEmbeddingIdentity(entry, identity)) {
        dimensions.set(entry.dimension, (dimensions.get(entry.dimension) ?? 0) + 1);
      }
    }
    const requested = this.deps.embedder.config.extraBody?.dimensions;
    // A model we have never used has an unknown dimension; old models cannot define it.
    const dimension = knownDimension ?? (typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : identity.provider === "local" && identity.model === "Xenova/all-MiniLM-L6-v2"
        ? 384
        : [...dimensions].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0);
    const health = (entry: EmbeddingMaintenanceEntry): Health => {
      if (entry.dimension <= 0) return "missing";
      if (!sameEmbeddingIdentity(entry, identity)) return "modelMismatch";
      return dimension > 0 && entry.dimension !== dimension ? "dimMismatch" : "ready";
    };
    const stats: EmbeddingMaintenanceStats = {
      dimension, available: this.deps.embedder.status().configured, totalSlots: entries.length,
      ready: 0, missing: 0, dimMismatch: 0, modelMismatch: 0, needsRepair: 0
    };
    for (const entry of entries) stats[health(entry)] += 1;
    stats.needsRepair = stats.missing + stats.dimMismatch + stats.modelMismatch;
    return { entries, identity, health, stats };
  }

  stats(): EmbeddingMaintenanceStats { return this.snapshot().stats; }

  start(mode: Mode): EmbeddingMaintenanceRunResult {
    const snapshot = this.snapshot();
    if (!snapshot.stats.available) throw new MemoryServiceError("invalid_argument", "Embedding model is unavailable");
    const previous = this.progress();
    if (previous && !previous.done) return previous;
    const at = new Date().toISOString();
    const run: Run = { runId: newId("embedding_maintenance"), mode, identity: snapshot.identity, createdAt: at, targets: [] };
    // The snapshot and enqueue are one transaction: another poll never observes a partial run.
    this.deps.repos.transaction(() => {
      for (const entry of snapshot.entries) {
        if (mode === "repair" && snapshot.health(entry) === "ready") continue;
        const target: Target = { id: entry.id, kind: entry.kind, vectorField: entry.vectorField };
        if (entry.kind === "memory") {
          const memory = this.deps.repos.memories.get(entry.id);
          if (memory) target.jobId = this.deps.enqueueMemory(memory, maintenanceText(memory, entry.vectorField), at, entry.vectorField);
        } else {
          const memory = this.deps.repos.userMemories.get(entry.id);
          if (memory) target.jobId = this.deps.enqueueUserMemory(memory, at);
        }
        if (!target.jobId) target.result = "failed";
        run.targets.push(target);
      }
      this.deps.repos.runtime.setKv(this.key, run, at);
    });
    return this.progress(run.runId)!;
  }

  /** One upgrade, only existing action vectors and feedback-derived L2 vectors. */
  async resumeUpgrade(): Promise<void> {
    let run = this.deps.repos.runtime.getKv(EMBEDDING_PROVENANCE_UPGRADE_KEY)?.value as Run | undefined;
    if (run?.completedAt) return;
    const at = new Date().toISOString();
    const identity = embeddingIdentity(this.deps.embedder.config);
    const identityChanged = run && (run.identity.provider !== identity.provider || run.identity.model !== identity.model);
    if (run && !identityChanged) this.refresh(run);
    if (run?.completedAt || (run?.nextAttemptAt && run.nextAttemptAt > Date.now())) return;
    const eligible = this.entries().filter(entry => {
      if (entry.kind !== "memory" || entry.dimension <= 0) return false;
      if (entry.vectorField === "vec_action") return true;
      const memory = this.deps.repos.memories.get(entry.id);
      const internal = memory?.properties.internal_info;
      return memory?.memoryLayer === "L2" && (internal?.source === "feedback.experience.v1" ||
        internal?.plugin_algorithm === "feedback.experience.v1");
    });
    run ??= { runId: newId("embedding_upgrade"), mode: "repair", purpose: "upgrade", identity,
      createdAt: at, targets: [], initialized: false,
      candidates: eligible.map(entry => ({ id: entry.id, kind: entry.kind, vectorField: entry.vectorField })) };
    // Persist the initial scope before any model request; failures/restarts cannot widen it.
    this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
    const candidates = eligible.filter(entry => (run.candidates ?? run.targets).some(target => targetKey(target) === targetKey(entry)));
    if (!run.initialized && !run.candidates?.length) {
      run.initialized = true;
      this.refresh(run);
      return;
    }
    try {
      if (!this.deps.embedder.status().configured) throw new Error("Embedding model is unavailable; upgrade repair is pending.");
      if (!run.initialized || identityChanged) {
        const requested = this.deps.embedder.config.extraBody?.dimensions;
        // Confirm unknown dimensions with this model, never infer them from legacy vectors.
        const dimension = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? requested
          : identity.provider === "local" && identity.model === "Xenova/all-MiniLM-L6-v2" ? 384
          : candidates.length || run.targets.length ? (await this.deps.embedder.embedOne("embedding compatibility check", "query")).length : 0;
        if ((candidates.length || run.targets.length) && !dimension) throw new Error("Embedding dimension is unavailable");
        const current = embeddingIdentity(this.deps.embedder.config);
        if (current.provider !== identity.provider || current.model !== identity.model) throw new Error("Embedding model changed while planning upgrade repair");
        run.identity = identity;
        run.dimension = dimension;
        const { health } = this.snapshot(dimension);
        if (!run.initialized) {
          run.targets = candidates.filter(entry => health(entry) !== "ready").map(entry => ({
            id: entry.id, kind: entry.kind, vectorField: entry.vectorField
          }));
          run.initialized = true;
        } else {
          // Model changes may invalidate completed targets, but never widen the original target set.
          for (const target of run.targets) {
            const entry = candidates.find(candidate => targetKey(candidate) === targetKey(target));
            target.result = entry && health(entry) === "ready" ? "updated" : undefined;
          }
        }
      }
      run.error = undefined;
      run.nextAttemptAt = undefined;
      this.deps.repos.transaction(() => {
        for (const target of run.targets) {
          if (target.result === "updated") continue;
          const job = target.jobId ? this.deps.repos.runtime.getEmbeddingRetry(target.jobId) : undefined;
          if (!target.result && job && ["pending", "in_progress"].includes(job.status)) continue;
          // Terminal failures remain observable until the durable retry deadline.
          const memory = this.deps.repos.memories.get(target.id);
          if (!memory) { target.result = "failed"; continue; }
          target.jobId = this.deps.enqueueMemory(memory, maintenanceText(memory, target.vectorField), at, target.vectorField);
          target.result = undefined;
        }
        this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
      });
      this.refresh(run);
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      run.nextAttemptAt = Date.now() + UPGRADE_RETRY_MS;
      this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
    }
  }

  progress(runId?: string): EmbeddingMaintenanceRunResult | null {
    const manual = this.deps.repos.runtime.getKv(this.key)?.value as Run | undefined;
    const upgrade = this.deps.repos.runtime.getKv(EMBEDDING_PROVENANCE_UPGRADE_KEY)?.value as Run | undefined;
    const run = runId
      ? [manual, upgrade].find(candidate => candidate?.runId === runId)
      : upgrade && !upgrade.completedAt ? upgrade : manual ?? upgrade;
    if (runId && !run) throw new MemoryServiceError("not_found", "Embedding maintenance run not found");
    return run ? this.refresh(run) : null;
  }

  nextUpgradeAttemptAt(): number | undefined {
    const run = this.deps.repos.runtime.getKv(EMBEDDING_PROVENANCE_UPGRADE_KEY)?.value as Run | undefined;
    return run && !run.completedAt ? run.nextAttemptAt : undefined;
  }

  upgradeProgress(): EmbeddingMaintenanceRunResult | null {
    const run = this.deps.repos.runtime.getKv(EMBEDDING_PROVENANCE_UPGRADE_KEY)?.value as Run | undefined;
    return run ? this.refresh(run) : null;
  }

  private refresh(run: Run): EmbeddingMaintenanceRunResult {
    const { entries, health, identity, stats } = this.snapshot(run.purpose === "upgrade" ? run.dimension : undefined);
    let changed = false;
    if (!run.completedAt && (run.purpose === "upgrade" || run.targets.some((target) => !target.result)) && (run.identity.provider !== identity.provider || run.identity.model !== identity.model)) {
      if (!run.error) {
        run.error = run.purpose === "upgrade"
          ? "Embedding model changed; automatic upgrade repair will resume with the selected model."
          : "Embedding model changed during maintenance. Refresh the statistics and run repair again.";
        changed = true;
      }
    }
    const byId = new Map(entries.map((entry) => [targetKey(entry), entry]));
    let retrying = 0;
    for (const target of run.targets) {
      if (target.result || run.error) continue;
      const job = target.kind === "memory"
        ? this.deps.repos.runtime.getEmbeddingRetry(target.jobId!)
        : this.deps.repos.runtime.getJob(target.jobId!);
      const terminalFailure = !job || job.status === "dead_letter" ||
        (job.status === "failed" && (target.kind === "memory" || job.attempts >= job.maxAttempts));
      if (terminalFailure || job?.status === "succeeded") {
        const entry = target.vectorField ? byId.get(targetKey(target))
          : entries.find(item => item.kind === target.kind && item.id === target.id && item.vectorField !== "vec_action");
        target.result = !terminalFailure && entry && health(entry) === "ready" ? "updated" : "failed";
        changed = true;
      } else if (job && job.attempts > 0 && job.lastError) {
        retrying += 1;
      }
    }
    if (run.purpose === "upgrade" && run.initialized && !run.completedAt && !run.error &&
        run.targets.every(target => target.result === "updated" &&
          byId.has(targetKey(target)) && health(byId.get(targetKey(target))!) === "ready")) {
      run.completedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.deps.repos.runtime.setKv(run.purpose === "upgrade" ? EMBEDDING_PROVENANCE_UPGRADE_KEY : this.key, run);
    if (run.purpose === "upgrade" && !run.completedAt && (run.error || run.targets.some(target => target.result === "failed")) && !run.nextAttemptAt) {
      run.nextAttemptAt = Date.now() + UPGRADE_RETRY_MS;
      this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run);
    }
    const updated = run.targets.filter((target) => target.result === "updated").length;
    const failed = run.targets.filter((target) => target.result === "failed").length;
    const pending = run.targets.length - updated - failed;
    return {
      runId: run.runId, mode: run.mode, accepted: true,
      enqueued: run.targets.filter((target) => target.jobId).length,
      processed: updated + failed, updated, failed, pending, retrying,
      done: run.purpose === "upgrade" ? Boolean(run.completedAt) : pending === 0 || Boolean(run.error), statsAfter: stats,
      serverTime: new Date().toISOString(), ...(run.error ? { error: run.error } : {})
    };
  }
}

function targetKey(target: Pick<Target, "kind" | "id" | "vectorField">): string {
  return `${target.kind}:${target.id}:${target.vectorField ?? "vec"}`;
}

function maintenanceText(memory: MemoryRow, vectorField?: EmbeddingRetryVectorField): string {
  if (vectorField === "vec_action") return traceActionEmbeddingText(memory);
  if (memory.memoryLayer === "L1" && kindFromMemory(memory) === "work_memory") {
    const internal = memory.properties.internal_info;
    return canonicalWorkMemoryText(
      typeof internal.work_topic === "string" ? internal.work_topic : "Work requirements",
      typeof internal.requirement === "string" ? internal.requirement : "",
      typeof internal.reason === "string" ? internal.reason : ""
    );
  }
  return memory.memoryLayer === "L1"
    ? traceSummaryEmbeddingText(memory) ?? embeddingTextForMemory(memory)
    : embeddingTextForMemory(memory);
}
