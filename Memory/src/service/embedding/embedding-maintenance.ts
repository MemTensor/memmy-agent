import type { Embedder } from "../../model/types.js";
import { embeddingIdentity, type EmbeddingIdentity } from "../../model/embedding-identity.js";
import type { EmbeddingRetryVectorField, Repositories } from "../../storage/repositories.js";
import type { MemoryRow, UserMemoryRecord } from "../../types.js";
import { newId } from "../../utils/id.js";
import { MemoryServiceError } from "../../utils/error.js";
import { EmbeddingMaintenanceReader } from "./embedding-maintenance-reader.js";
import {
  maintenanceText,
  targetKey,
  type EmbeddingMaintenanceReaderStats,
  type EmbeddingMaintenanceReaderTarget,
  type EmbeddingMaintenanceTargetProgress
} from "./embedding-maintenance-reader-query.js";

type Mode = "repair" | "rebuild";
interface Target extends EmbeddingMaintenanceReaderTarget {
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
interface CachedStats {
  stats: EmbeddingMaintenanceStats;
  readAt: string;
  final: boolean;
}
export const EMBEDDING_PROVENANCE_UPGRADE_KEY = "embedding-provenance-upgrade:v1";
const UPGRADE_RETRY_MS = 5 * 60_000;
export interface EmbeddingMaintenanceStats extends EmbeddingMaintenanceReaderStats {
  dimensionError?: string;
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
  reader: EmbeddingMaintenanceReader;
  embedder: Embedder;
  userId: string;
  enqueueMemory(memory: MemoryRow, text: string, at: string, vectorField?: EmbeddingRetryVectorField): string;
  enqueueUserMemory(memory: UserMemoryRecord, at: string): string;
}

/** Snapshot selected targets once, then report durable worker outcomes cumulatively. */
export class EmbeddingMaintenance {
  constructor(private readonly deps: Dependencies) {}

  private get key(): string { return `embedding-maintenance:${this.deps.userId}`; }
  private statsKey(runId: string): string { return `embedding-maintenance-stats:${this.deps.userId}:${runId}`; }

  async stats(dimension?: number): Promise<EmbeddingMaintenanceStats> {
    return (await this.deps.reader.readStats(this.statsRequest(dimension))).stats;
  }

  async start(mode: Mode, dimension?: number): Promise<EmbeddingMaintenanceRunResult> {
    const previousRun = this.manualRun();
    if (previousRun && !previousRun.completedAt) {
      const previous = await this.progress(previousRun.runId);
      if (previous && !previous.done) return previous;
    }
    const snapshot = await this.deps.reader.readStats(this.statsRequest(dimension, undefined, true));
    if (!snapshot.stats.available) throw new MemoryServiceError("invalid_argument", "Embedding model is unavailable");
    const at = new Date().toISOString();
    const run: Run = {
      runId: newId("embedding_maintenance"), mode,
      identity: embeddingIdentity(this.deps.embedder.config),
      dimension: snapshot.stats.dimension, createdAt: at, targets: []
    };
    let concurrentRun: Run | undefined;
    this.deps.repos.transaction(() => {
      const current = this.manualRun();
      if (current && !current.completedAt) {
        concurrentRun = current;
        return;
      }
      for (const entry of snapshot.entries) {
        if (mode === "repair" && snapshot.health[targetKey(entry)] === "ready") continue;
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
      if (run.targets.every(target => Boolean(target.result))) run.completedAt = at;
      this.deps.repos.runtime.setKv(this.key, run, at);
      this.cacheStats(run, snapshot.stats, snapshot.readAt, Boolean(run.completedAt));
    });
    if (concurrentRun) return (await this.progress(concurrentRun.runId))!;
    return this.result(run, [], snapshot.stats);
  }

  /** One upgrade, only existing action vectors and feedback-derived L2 vectors. */
  async resumeUpgrade(): Promise<void> {
    let run = this.upgradeRun();
    if (run?.completedAt || (run?.nextAttemptAt && run.nextAttemptAt > Date.now())) return;
    const at = new Date().toISOString();
    const identity = embeddingIdentity(this.deps.embedder.config);
    try {
      const identityChanged = run && (run.identity.provider !== identity.provider || run.identity.model !== identity.model);
      if (run && !identityChanged) {
        const targetSnapshot = await this.readTargets(run.targets, run.identity, run.dimension ?? 0);
        const current = this.upgradeRun();
        if (!current || !sameRunReadScope(run, current)) return;
        run = current;
        this.refresh(run, targetSnapshot);
      }
      if (run?.completedAt) return;

      if (!run) {
        run = {
          runId: newId("embedding_upgrade"), mode: "repair", purpose: "upgrade", identity,
          createdAt: at, targets: [], initialized: false
        };
        this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
      }
      if (!run.initialized && !run.candidates && run.targets.length === 0) {
        const eligible = await this.deps.reader.readUpgradeCandidates();
        run.candidates = eligible.map(entry => ({ id: entry.id, kind: entry.kind, vectorField: entry.vectorField }));
        this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
      }
      const candidates = run.candidates ?? run.targets;
      if (!run.initialized && candidates.length === 0) {
        run.initialized = true;
        this.refresh(run, []);
        return;
      }
      if (!this.deps.embedder.status().configured) throw new Error("Embedding model is unavailable; upgrade repair is pending.");
      if (!run.initialized || identityChanged) {
        const requested = this.deps.embedder.config.extraBody?.dimensions;
        const dimension = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? requested
          : identity.provider === "local" && identity.model === "Xenova/all-MiniLM-L6-v2" ? 384
          : candidates.length || run.targets.length ? (await this.deps.embedder.embedOne("embedding compatibility check", "query")).length : 0;
        if ((candidates.length || run.targets.length) && !dimension) throw new Error("Embedding dimension is unavailable");
        const current = embeddingIdentity(this.deps.embedder.config);
        if (current.provider !== identity.provider || current.model !== identity.model) {
          throw new Error("Embedding model changed while planning upgrade repair");
        }
        run.identity = identity;
        run.dimension = dimension;
        const targetSnapshot = await this.readTargets(candidates, identity, dimension);
        const byKey = new Map(targetSnapshot.map(target => [target.key, target]));
        if (!run.initialized) {
          run.targets = candidates.filter(target => byKey.get(targetKey(target))?.health !== "ready").map(target => ({ ...target }));
          run.initialized = true;
        } else {
          for (const target of run.targets) {
            const state = byKey.get(targetKey(target));
            target.result = state?.health === "ready" ? "updated" : undefined;
          }
        }
      }
      run.error = undefined;
      run.nextAttemptAt = undefined;
      this.deps.repos.transaction(() => {
        for (const target of run!.targets) {
          if (target.result === "updated") continue;
          const job = target.jobId ? this.deps.repos.runtime.getEmbeddingRetry(target.jobId) : undefined;
          if (!target.result && job && ["pending", "in_progress"].includes(job.status)) continue;
          const memory = this.deps.repos.memories.get(target.id);
          if (!memory) { target.result = "failed"; continue; }
          target.jobId = this.deps.enqueueMemory(memory, maintenanceText(memory, target.vectorField), at, target.vectorField);
          target.result = undefined;
        }
        this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
      });
      if (run.targets.length === 0) this.refresh(run, []);
    } catch (error) {
      run ??= {
        runId: newId("embedding_upgrade"), mode: "repair", purpose: "upgrade", identity,
        createdAt: at, targets: [], initialized: false
      };
      run.error = error instanceof Error ? error.message : String(error);
      run.nextAttemptAt = Date.now() + UPGRADE_RETRY_MS;
      this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run, at);
    }
  }

  private recordUpgradeReadFailure(run: Run, error: unknown): EmbeddingMaintenanceRunResult {
    run.error = error instanceof Error ? error.message : String(error);
    run.nextAttemptAt = Date.now() + UPGRADE_RETRY_MS;
    this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run);
    return this.result(run, []);
  }

  async progress(runId?: string): Promise<EmbeddingMaintenanceRunResult | null> {
    const run = this.selectRun(runId);
    if (runId && !run) throw new MemoryServiceError("not_found", "Embedding maintenance run not found");
    if (!run) return null;
    const cached = this.cachedStats(run);
    if (run.completedAt && cached?.final) return this.result(run, [], cached.stats);
    const snapshot = await this.deps.reader.readStats(this.statsRequest(run.dimension, run.targets));
    const current = this.selectRun(runId);
    if (!current || !sameRunReadScope(run, current)) return this.result(run, [], snapshot.stats);
    return this.refresh(current, snapshot.targets ?? [], snapshot.stats, snapshot.readAt);
  }

  nextUpgradeAttemptAt(): number | undefined {
    const run = this.upgradeRun();
    return run && !run.completedAt ? run.nextAttemptAt : undefined;
  }

  async upgradeProgress(): Promise<EmbeddingMaintenanceRunResult | null> {
    const run = this.upgradeRun();
    if (!run) return null;
    if (run.completedAt) return this.result(run, [], this.cachedStats(run)?.stats);
    try {
      const targets = await this.readTargets(run.targets, run.identity, run.dimension ?? 0);
      const current = this.upgradeRun();
      if (!current || !sameRunReadScope(run, current)) return this.result(run, []);
      return this.refresh(current, targets);
    } catch (error) {
      const current = this.upgradeRun();
      return current && sameRunReadScope(run, current)
        ? this.recordUpgradeReadFailure(current, error)
        : this.result(run, []);
    }
  }

  private refresh(
    run: Run,
    targetStates: EmbeddingMaintenanceTargetProgress[],
    stats?: EmbeddingMaintenanceStats,
    readAt = new Date().toISOString()
  ): EmbeddingMaintenanceRunResult {
    const identity = embeddingIdentity(this.deps.embedder.config);
    let changed = false;
    if (!run.completedAt && (run.purpose === "upgrade" || run.targets.some(target => !target.result)) &&
        (run.identity.provider !== identity.provider || run.identity.model !== identity.model)) {
      if (!run.error) {
        run.error = run.purpose === "upgrade"
          ? "Embedding model changed; automatic upgrade repair will resume with the selected model."
          : "Embedding model changed during maintenance. Refresh the statistics and run repair again.";
        changed = true;
      }
    }
    const byKey = new Map(targetStates.map(state => [state.key, state]));
    for (const target of run.targets) {
      const state = byKey.get(targetKey(target));
      if (target.result || run.error) continue;
      if (!state || state.terminalFailure || state.succeeded) {
        target.result = state?.succeeded && state.sourceCurrent && state.health === "ready" ? "updated" : "failed";
        changed = true;
      }
    }
    const manualDone = !run.purpose && (Boolean(run.error) || run.targets.every(target => Boolean(target.result)));
    const upgradeDone = run.purpose === "upgrade" && run.initialized && !run.error &&
      run.targets.every(target => {
        const state = byKey.get(targetKey(target));
        return target.result === "updated" && state?.sourceCurrent && state.health === "ready";
      });
    if (!run.completedAt && (manualDone || upgradeDone)) {
      run.completedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.deps.repos.runtime.setKv(run.purpose === "upgrade" ? EMBEDDING_PROVENANCE_UPGRADE_KEY : this.key, run);
    if (run.purpose === "upgrade" && !run.completedAt &&
        (run.error || run.targets.some(target => target.result === "failed")) && !run.nextAttemptAt) {
      run.nextAttemptAt = Date.now() + UPGRADE_RETRY_MS;
      this.deps.repos.runtime.setKv(EMBEDDING_PROVENANCE_UPGRADE_KEY, run);
    }
    if (stats) this.cacheStats(run, stats, readAt, Boolean(run.completedAt));
    return this.result(run, targetStates, stats);
  }

  private result(
    run: Run,
    targetStates: EmbeddingMaintenanceTargetProgress[],
    stats?: EmbeddingMaintenanceStats
  ): EmbeddingMaintenanceRunResult {
    const updated = run.targets.filter(target => target.result === "updated").length;
    const failed = run.targets.filter(target => target.result === "failed").length;
    const pending = run.targets.length - updated - failed;
    const byKey = new Map(targetStates.map(state => [state.key, state]));
    const retrying = run.targets.filter(target => !target.result && byKey.get(targetKey(target))?.retrying).length;
    return {
      runId: run.runId, mode: run.mode, accepted: true,
      enqueued: run.targets.filter(target => target.jobId).length,
      processed: updated + failed, updated, failed, pending, retrying,
      done: Boolean(run.completedAt) || (!run.purpose && (pending === 0 || Boolean(run.error))),
      statsAfter: stats ?? this.cachedStats(run)?.stats ?? this.emptyStats(run.dimension),
      serverTime: new Date().toISOString(), ...(run.error ? { error: run.error } : {})
    };
  }

  private statsRequest(knownDimension?: number, targets?: Target[], includePlan = false) {
    const identity = embeddingIdentity(this.deps.embedder.config);
    const requested = this.deps.embedder.config.extraBody?.dimensions;
    return {
      userId: this.deps.userId, identity,
      available: this.deps.embedder.status().configured,
      ...(knownDimension === undefined ? {} : { knownDimension }),
      ...(typeof requested === "number" ? { requestedDimension: requested } : {}),
      ...(includePlan ? { includePlan: true } : {}),
      ...(targets ? { targets: targets.map(target => ({
        id: target.id, kind: target.kind, vectorField: target.vectorField, jobId: target.jobId
      })) } : {})
    };
  }

  private async readTargets(targets: Target[], identity: EmbeddingIdentity, dimension: number) {
    return (await this.deps.reader.readTargets({
      userId: this.deps.userId, identity, dimension,
      targets: targets.map(target => ({
        id: target.id, kind: target.kind, vectorField: target.vectorField, jobId: target.jobId
      }))
    })).targets;
  }

  private selectRun(runId?: string): Run | undefined {
    const manual = this.manualRun();
    const upgrade = this.upgradeRun();
    return runId
      ? [manual, upgrade].find(candidate => candidate?.runId === runId)
      : upgrade && !upgrade.completedAt ? upgrade : manual ?? upgrade;
  }

  private manualRun(): Run | undefined {
    return this.deps.repos.runtime.getKv(this.key)?.value as Run | undefined;
  }

  private upgradeRun(): Run | undefined {
    return this.deps.repos.runtime.getKv(EMBEDDING_PROVENANCE_UPGRADE_KEY)?.value as Run | undefined;
  }

  private cacheStats(run: Run, stats: EmbeddingMaintenanceStats, readAt: string, final: boolean): void {
    this.deps.repos.runtime.setKv(this.statsKey(run.runId), { stats, readAt, final } satisfies CachedStats, readAt);
  }

  private cachedStats(run: Run): CachedStats | undefined {
    return this.deps.repos.runtime.getKv(this.statsKey(run.runId))?.value as CachedStats | undefined;
  }

  private emptyStats(dimension = 0): EmbeddingMaintenanceStats {
    return {
      dimension, available: this.deps.embedder.status().configured,
      totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0, modelMismatch: 0,
      contentMismatch: 0, needsRepair: 0,
      retryQueue: { pending: 0, active: 0, stale: 0, failed: 0 }
    };
  }
}

function sameRunReadScope(expected: Run, current: Run): boolean {
  return expected.runId === current.runId &&
    expected.createdAt === current.createdAt &&
    expected.identity.provider === current.identity.provider &&
    expected.identity.model === current.identity.model &&
    expected.dimension === current.dimension &&
    expected.initialized === current.initialized &&
    expected.targets.length === current.targets.length &&
    expected.targets.every((target, index) => {
      const other = current.targets[index];
      if (!other) return false;
      return targetKey(target) === targetKey(other) && target.jobId === other.jobId;
    });
}
