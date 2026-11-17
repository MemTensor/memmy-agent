import type { QueueLane } from "./job-policy-registry.js";
import { DEFAULT_LANE_WEIGHTS, validateLaneWeights } from "./lane-queue-selector.js";

export type WorkerSchedulingAlgorithm = "wrr" | "legacy";
export interface WorkerAgingOptions { enabled?: boolean; thresholdMs?: number }
export interface WorkerSchedulingOptions {
  algorithm?: WorkerSchedulingAlgorithm;
  aging?: WorkerAgingOptions;
  laneWeights?: Readonly<Record<QueueLane, number>>;
}
export interface ResolvedWorkerSchedulingOptions {
  algorithm: WorkerSchedulingAlgorithm;
  aging: Readonly<{ enabled: boolean; thresholdMs: number }>;
  laneWeights: Readonly<Record<QueueLane, number>>;
}
type SchedulingEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  "MEMMY_WORKER_SCHEDULER_ALGORITHM" | "MEMMY_WORKER_LANE_WEIGHTS" |
  "MEMMY_WORKER_AGING_ENABLED" | "MEMMY_WORKER_AGING_THRESHOLD_MS">>;

/** Explicit dependency settings win over environment settings, field by field. */
export function resolveWorkerSchedulingOptions(
  options: WorkerSchedulingOptions = {}, env: SchedulingEnvironment = process.env
): Readonly<ResolvedWorkerSchedulingOptions> {
  const algorithmValue: unknown = options.algorithm !== undefined ? options.algorithm
    : env.MEMMY_WORKER_SCHEDULER_ALGORITHM?.trim() || "wrr";
  const algorithm = typeof algorithmValue === "string" ? algorithmValue.trim().toLowerCase() : undefined;
  if (algorithm !== "wrr" && algorithm !== "legacy") {
    throw new RangeError("Worker scheduler algorithm must be wrr or legacy");
  }
  let weights: unknown = options.laneWeights;
  if (weights === undefined) {
    const encoded = env.MEMMY_WORKER_LANE_WEIGHTS?.trim();
    if (encoded) {
      try { weights = JSON.parse(encoded) as unknown; }
      catch { throw new TypeError("MEMMY_WORKER_LANE_WEIGHTS must contain a JSON object with all five lane weights"); }
    } else weights = DEFAULT_LANE_WEIGHTS;
  }
  if (options.aging !== undefined && (options.aging === null || typeof options.aging !== "object" || Array.isArray(options.aging))) {
    throw new TypeError("Worker aging options must be an object");
  }
  if (options.aging?.enabled !== undefined && typeof options.aging.enabled !== "boolean") {
    throw new TypeError("Worker aging enabled option must be a boolean");
  }
  const flag: unknown = options.aging?.enabled !== undefined ? options.aging.enabled : env.MEMMY_WORKER_AGING_ENABLED?.trim() ?? true;
  const enabled = typeof flag === "boolean" ? flag : flag === "true" || flag === "1" ? true : flag === "false" || flag === "0" ? false : undefined;
  if (enabled === undefined) throw new TypeError("Worker aging enabled must be a boolean or true/false/1/0");
  const threshold: unknown = options.aging?.thresholdMs !== undefined ? options.aging.thresholdMs :
    (env.MEMMY_WORKER_AGING_THRESHOLD_MS === undefined ? 300_000 : Number(env.MEMMY_WORKER_AGING_THRESHOLD_MS));
  if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 1) {
    throw new RangeError("Worker aging thresholdMs must be a positive safe integer");
  }
  return Object.freeze({ algorithm, laneWeights: validateLaneWeights(weights),
    aging: Object.freeze({ enabled: algorithm === "wrr" && enabled, thresholdMs: threshold }) });
}
