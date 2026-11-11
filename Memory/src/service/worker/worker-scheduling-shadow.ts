import type { RuntimeRepository } from "../../storage/repositories.js";
import type { QueueEligibilityOptions } from "../../storage/queue-eligibility.js";
import { ShadowQueueSelector, type ShadowQueueSelection } from "./shadow-queue-selector.js";
import type { QueueLane } from "./job-policy-registry.js";

export interface WorkerSchedulingShadowInput extends QueueEligibilityOptions {
  at: string;
  limit: number;
  priorityCohortOnly?: boolean;
  includeRetries?: boolean;
  laneWeights?: Readonly<Record<QueueLane, number>>;
}
export interface WorkerSchedulingComparison {
  mode: "shadow";
  sampledAt: string;
  sampleLimit: number;
  algorithm: ShadowQueueSelection["algorithm"];
  weights: ShadowQueueSelection["weights"];
  nextCursor: number;
  coverageComplete: boolean;
  pendingPolicyCount: number;
  unregisteredJobCount: number;
  candidatePoolSize: number;
  legacySelection: string[];
  shadowSelection: string[];
  shadowLanes: string[];
  sameSelection: boolean;
}

/** Observe at most once per five seconds, capped at 32 choices per sample. */
export class WorkerSchedulingShadow {
  private lastSampleAt: number | undefined;
  private selector = new ShadowQueueSelector();
  private weightsKey: string | undefined;

  constructor(private readonly runtime: RuntimeRepository) {}

  sample(input: WorkerSchedulingShadowInput): WorkerSchedulingComparison | undefined {
    const now = Date.parse(input.at);
    if (this.lastSampleAt !== undefined && now >= this.lastSampleAt && now - this.lastSampleAt < 5_000) return;
    this.lastSampleAt = now;
    if (input.laneWeights && JSON.stringify(input.laneWeights) !== this.weightsKey) {
      this.selector = new ShadowQueueSelector(input.laneWeights);
      this.weightsKey = JSON.stringify(input.laneWeights);
    }
    const sampleLimit = Math.max(1, Math.min(32, Math.floor(input.limit)));
    // Only the new projection fields are refreshed. Claims, task state, attempt
    // counts, deadlines and change cursors remain entirely on the legacy path.
    this.runtime.scheduling.refreshPolicies(500);
    return this.runtime.scheduling.readSnapshot(() => {
      const pendingPolicyCount = this.runtime.scheduling.pendingPolicyCount();
      const unregisteredJobCount = this.runtime.scheduling.unregisteredPolicyCount();
      const candidates = this.runtime.scheduling.candidates({ ...input, limit: sampleLimit });
      const legacyMain = this.runtime.previewQueuedJobs({ ...input, limit: sampleLimit });
      const legacyRetries = input.includeRetries === false ? [] : this.runtime.previewDueEmbeddingRetries({
        now, limit: sampleLimit - legacyMain.length, targetMemoryIds: input.targetMemoryIds
      });
      const legacySelection = [...legacyMain.map((job) => `main:${job.id}`),
        ...legacyRetries.map((retry) => `embedding_retry:${retry.id}`)];
      const selection = this.selector.select(candidates, sampleLimit);
      const shadowSelection = selection.selected.map((item) => `${item.queue}:${item.id}`);
      if (legacySelection.length === 0 && shadowSelection.length === 0 && pendingPolicyCount === 0 && unregisteredJobCount === 0) return;
      return {
        mode: "shadow", sampledAt: input.at, sampleLimit, algorithm: selection.algorithm,
        weights: selection.weights, nextCursor: selection.nextCursor,
        coverageComplete: pendingPolicyCount === 0 && unregisteredJobCount === 0,
        pendingPolicyCount, unregisteredJobCount, candidatePoolSize: candidates.length,
        legacySelection, shadowSelection, shadowLanes: selection.selected.map((item) => item.lane),
        sameSelection: JSON.stringify(legacySelection) === JSON.stringify(shadowSelection)
      };
    });
  }
}
