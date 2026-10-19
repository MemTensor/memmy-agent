import type { Embedder } from "../../model/types.js";
import { embeddingIdentity, sameEmbeddingIdentity, type EmbeddingIdentity } from "../../model/embedding-identity.js";
import { kindFromMemory, type Repositories } from "../../storage/repositories.js";
import type { EmbeddingMaintenanceEntry } from "../../storage/sqlite-vec-store.js";
import type { MemoryRow, UserMemoryRecord } from "../../types.js";
import { newId } from "../../utils/id.js";
import { MemoryServiceError } from "../../utils/error.js";
import { embeddingTextForMemory, traceSummaryEmbeddingText } from "./embedding-pipeline.js";
import { canonicalWorkMemoryText } from "../work-memory/work-memory-pipeline.js";

type Mode = "repair" | "rebuild";
type Health = "ready" | "missing" | "dimMismatch" | "modelMismatch";
interface Target {
  id: string;
  kind: "memory" | "user_memory";
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
}
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
  enqueueMemory(memory: MemoryRow, text: string, at: string): string;
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

  private snapshot() {
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
    const dimension = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : identity.provider === "local" && identity.model === "Xenova/all-MiniLM-L6-v2"
        ? 384
        : [...dimensions].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
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
        const target: Target = { id: entry.id, kind: entry.kind };
        if (entry.kind === "memory") {
          const memory = this.deps.repos.memories.get(entry.id);
          if (memory) target.jobId = this.deps.enqueueMemory(memory, maintenanceText(memory), at);
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

  progress(runId?: string): EmbeddingMaintenanceRunResult | null {
    const run = this.deps.repos.runtime.getKv(this.key)?.value as Run | undefined;
    if (!run) return null;
    if (runId && run.runId !== runId) throw new MemoryServiceError("not_found", "Embedding maintenance run not found");
    const { entries, health, identity, stats } = this.snapshot();
    let changed = false;
    if (run.targets.some((target) => !target.result) && (run.identity.provider !== identity.provider || run.identity.model !== identity.model)) {
      if (!run.error) {
        run.error = "Embedding model changed during maintenance. Refresh the statistics and run repair again.";
        changed = true;
      }
    }
    const byId = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    let retrying = 0;
    for (const target of run.targets) {
      if (target.result || run.error) continue;
      const job = target.kind === "memory"
        ? this.deps.repos.runtime.getEmbeddingRetry(target.jobId!)
        : this.deps.repos.runtime.getJob(target.jobId!);
      const terminalFailure = !job || job.status === "dead_letter" ||
        (job.status === "failed" && (target.kind === "memory" || job.attempts >= job.maxAttempts));
      if (terminalFailure || job?.status === "succeeded") {
        const entry = byId.get(`${target.kind}:${target.id}`);
        target.result = !terminalFailure && entry && health(entry) === "ready" ? "updated" : "failed";
        changed = true;
      } else if (job && job.attempts > 0 && job.lastError) {
        retrying += 1;
      }
    }
    if (changed) this.deps.repos.runtime.setKv(this.key, run);
    const updated = run.targets.filter((target) => target.result === "updated").length;
    const failed = run.targets.filter((target) => target.result === "failed").length;
    const pending = run.targets.length - updated - failed;
    return {
      runId: run.runId, mode: run.mode, accepted: true,
      enqueued: run.targets.filter((target) => target.jobId).length,
      processed: updated + failed, updated, failed, pending, retrying,
      done: pending === 0 || Boolean(run.error), statsAfter: stats,
      serverTime: new Date().toISOString(), ...(run.error ? { error: run.error } : {})
    };
  }
}

function maintenanceText(memory: MemoryRow): string {
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
