import type { ResourceClass } from "./job-policy-registry.js";

export interface WorkerLeasePolicy { durationSec: number; heartbeatMs: number }
export interface WorkerLeaseOptions {
  resources?: Partial<Record<ResourceClass, Partial<WorkerLeasePolicy>>>;
  embeddingRetry?: Partial<WorkerLeasePolicy>;
}
export interface ResolvedWorkerLeaseOptions {
  resources: Readonly<Record<ResourceClass, Readonly<WorkerLeasePolicy>>>;
  embeddingRetry: Readonly<WorkerLeasePolicy>;
}
const classes: readonly ResourceClass[] = ["summary", "embedding", "evolution_llm", "database", "scan"];

/** Resolve once at worker startup; invalid timing must fail before any claim. */
export function resolveWorkerLeaseOptions(
  options: WorkerLeaseOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env
): Readonly<ResolvedWorkerLeaseOptions> {
  let configured: WorkerLeaseOptions = {};
  if (env.MEMMY_WORKER_LEASE_OPTIONS !== undefined) {
    try { configured = JSON.parse(env.MEMMY_WORKER_LEASE_OPTIONS) as WorkerLeaseOptions; }
    catch { throw new TypeError("MEMMY_WORKER_LEASE_OPTIONS must be a JSON object"); }
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  for (const value of [configured, options]) {
    if (!object(value) || Object.keys(value).some(key => !["resources", "embeddingRetry"].includes(key))) {
      throw new TypeError("Worker lease options must contain resources or embeddingRetry");
    }
    if (value.resources !== undefined && (!object(value.resources) || Object.keys(value.resources).some(key => !classes.includes(key as ResourceClass)))) {
      throw new TypeError("Unknown worker lease resource class");
    }
  }
  const policy = (defaults: WorkerLeasePolicy, ...values: unknown[]): Readonly<WorkerLeasePolicy> => {
    let result = { ...defaults };
    for (const value of values) {
      if (value === undefined) continue;
      if (!object(value) || Object.keys(value).some(key => !["durationSec", "heartbeatMs"].includes(key))) {
        throw new TypeError("Invalid worker lease policy");
      }
      result = { ...result, ...value };
    }
    if (!Number.isSafeInteger(result.durationSec) || result.durationSec < 1 || result.durationSec > 86_400 ||
      !Number.isSafeInteger(result.heartbeatMs) || result.heartbeatMs < 1 || result.heartbeatMs > result.durationSec * 500) {
      throw new RangeError("Worker lease duration must be 1..86400 seconds and heartbeat at most half its duration");
    }
    return Object.freeze(result);
  };
  const resources = Object.fromEntries(classes.map(resource => [resource,
    policy({ durationSec: 60, heartbeatMs: 20_000 }, configured.resources?.[resource], options.resources?.[resource])
  ])) as Record<ResourceClass, Readonly<WorkerLeasePolicy>>;
  return Object.freeze({ resources: Object.freeze(resources),
    embeddingRetry: policy({ durationSec: 300, heartbeatMs: 20_000 }, configured.embeddingRetry, options.embeddingRetry) });
}
