import type { JobType } from "../../types.js";
import { resolveWorkerLeaseOptions, type ResolvedWorkerLeaseOptions } from "./worker-lease-options.js";

export const JOB_POLICY_VERSION = 5;
export const QUEUE_LANES = ["interactive", "repair_retry", "import", "evolution", "maintenance"] as const;
export type QueueLane = typeof QUEUE_LANES[number];
export const RESOURCE_CLASSES = ["summary", "embedding", "evolution_llm", "database", "scan"] as const;
export type ResourceClass = typeof RESOURCE_CLASSES[number];
export type PolicyJobType = JobType | "embedding_retry";
export type JobOperationMode = "default" | "onboarding_first_report" | "manual_retry" |
  "startup_repair" | "historical_import" | "maintenance";

/** The scheduler needs metadata, never a memory's conversation text or vectors. */
export interface JobPolicyTarget {
  agentId?: string;
  memoryLayer?: string;
  memoryKind?: string;
  tags?: readonly string[];
  pluginAlgorithm?: string;
  /** Scheduling provenance only; never identifies an import processing pipeline. */
  captureOrigin?: string;
}

export interface JobPolicyInput {
  jobType: string;
  payload?: Record<string, unknown>;
  target?: JobPolicyTarget;
  operationMode?: JobOperationMode;
}

export interface JobPolicy {
  queueLane: QueueLane;
  resourceClass: ResourceClass;
  /** Audit/urgency information; this is not a replacement for lane fairness or FIFO. */
  basePriority: number;
  policyVersion: number;
  lease: Readonly<{ durationSec: number; heartbeatMs: number }>;
  /** Describes future admission requirements; phase 3 does not acquire permits. */
  concurrency: Readonly<{
    providerRoles: readonly ("summary" | "evolution" | "embedding")[];
    scope: "target" | "user_project" | "episode" | "none";
    batchable: boolean;
  }>;
}

type PolicyDefinition = Omit<JobPolicy, "policyVersion" | "lease">;
type ProviderRole = JobPolicy["concurrency"]["providerRoles"][number];
type Scope = JobPolicy["concurrency"]["scope"];

function definition(
  queueLane: QueueLane,
  resourceClass: ResourceClass,
  basePriority: number,
  providerRoles: readonly ProviderRole[],
  scope: Scope = "target",
  batchable = false
): PolicyDefinition {
  return Object.freeze({
    queueLane, resourceClass, basePriority,
    concurrency: Object.freeze({ providerRoles: Object.freeze([...providerRoles]), scope, batchable })
  });
}

// Record makes a newly added JobType a compilation error until its policy is reviewed.
// Resource classes describe the principal work; providerRoles also records secondary
// model calls (for example Work Memory's retrieval query embedding).
const DEFINITIONS: Readonly<Record<PolicyJobType, PolicyDefinition>> = Object.freeze({
  episode_assignment: definition("interactive", "summary", 1, ["summary"], "none"),
  episode_finalize: definition("interactive", "database", 1, [], "none"),
  episode_idle_close: definition("maintenance", "database", 10, [], "episode"),
  episode_title: definition("interactive", "summary", 15, ["summary"], "episode"),
  trace_summary: definition("interactive", "summary", 1, ["summary", "evolution"]),
  import_summary: definition("import", "summary", 2, ["summary", "evolution"]),
  observation_extract: definition("interactive", "summary", 1, ["summary"]),
  embedding: definition("evolution", "embedding", 3, ["embedding"], "target", true),
  user_memory_embedding: definition("interactive", "embedding", 3, ["embedding"], "target", true),
  embedding_retry: definition("repair_retry", "embedding", 0, ["embedding"], "target", true),
  reflection: definition("evolution", "evolution_llm", 20, ["summary", "evolution"], "episode"),
  reward: definition("evolution", "evolution_llm", 30, ["summary", "evolution"], "episode"),
  span_big_turn: definition("evolution", "summary", 35, ["summary"]),
  negative_experience: definition("evolution", "evolution_llm", 100, ["evolution"], "episode"),
  decision_repair: definition("repair_retry", "evolution_llm", 25, ["evolution"]),
  // Both entry points can run unified extraction, including comparison/revision embeddings.
  // Reserve the complete call set even when legacy mode uses only a subset.
  l2_association: definition("evolution", "evolution_llm", 40, ["evolution", "embedding"]),
  l2_induction: definition("evolution", "evolution_llm", 50, ["evolution", "embedding"]),
  l3_abstraction: definition("evolution", "database", 60, [], "user_project"),
  l3_world_model_update: definition("evolution", "evolution_llm", 60, ["evolution"], "user_project"),
  project_environment_profile: definition("maintenance", "evolution_llm", 55, ["evolution"], "user_project"),
  skill_crystallization: definition("evolution", "evolution_llm", 70, ["evolution"]),
  skill_cluster_assign: definition("evolution", "evolution_llm", 72, ["embedding", "evolution"], "user_project"),
  skill_batch_evolve: definition("evolution", "evolution_llm", 73, ["evolution"], "user_project"),
  skill_trial_resolve: definition("evolution", "database", 80, [], "episode"),
  work_memory_extract: definition("evolution", "summary", 100, ["summary", "embedding"], "user_project"),
  work_memory_idle_flush: definition("evolution", "database", 100, [], "user_project"),
  feedback_experience: definition("evolution", "evolution_llm", 100, ["evolution", "embedding"])
});

export const REGISTERED_JOB_TYPES = Object.freeze(Object.keys(DEFINITIONS) as PolicyJobType[]);
const FIRST_REPORT_JOB_TYPES = new Set(["trace_summary", "import_summary", "observation_extract", "embedding", "embedding_retry"]);
const STARTUP_REPAIR_SOURCES = new Set([
  "startup.processing_repair", "startup.placeholder_summary_repair",
  "startup.retrieval_document_v2", "startup.observation_backfill"
]);
const SUMMARY_JOB_TYPES = new Set(["trace_summary", "import_summary", "observation_extract"]);

export class UnknownJobPolicyError extends Error {
  constructor(readonly jobType: string) {
    super(`No scheduling policy registered for job type: ${jobType}`);
    this.name = "UnknownJobPolicyError";
  }
}

export function isOnboardingFirstReportTarget(target: JobPolicyTarget | undefined): boolean {
  return target?.agentId?.toLowerCase() === "memmy-onboarding" ||
    target?.tags?.some((tag) => ["first-encounter-report", "onboarding-report"].includes(tag.toLowerCase())) === true;
}

export function isImportedPolicyTarget(target: JobPolicyTarget | undefined): boolean {
  return target?.pluginAlgorithm?.startsWith("memory.add.import_async.") === true ||
    target?.tags?.some((tag) => tag.toLowerCase() === "agent-source") === true;
}

export class JobPolicyRegistry {
  constructor(private readonly leases: Readonly<ResolvedWorkerLeaseOptions> = resolveWorkerLeaseOptions()) {}

  resolve(input: JobPolicyInput): JobPolicy {
    if (!Object.hasOwn(DEFINITIONS, input.jobType)) throw new UnknownJobPolicyError(input.jobType);
    const base = DEFINITIONS[input.jobType as PolicyJobType];
    const source = typeof input.payload?.source === "string" ? input.payload.source : "";
    // Embedding producers use `reason`, while summary/observation producers use
    // `source`. Both identify the operation; neither contains the model provider.
    const reason = typeof input.payload?.reason === "string" ? input.payload.reason : "";
    let queueLane = base.queueLane;
    let basePriority = base.basePriority;

    // First reports are user-visible results, even when the original data came
    // from a historical scan or is being repaired on startup.
    if (FIRST_REPORT_JOB_TYPES.has(input.jobType) &&
      (input.operationMode === "onboarding_first_report" || isOnboardingFirstReportTarget(input.target))) {
      queueLane = "interactive";
      basePriority = -100;
    } else if (input.operationMode === "manual_retry" || source === "memory.processing.manual_retry") {
      queueLane = "repair_retry";
      basePriority = 0;
    } else if (input.operationMode === "startup_repair" || input.operationMode === "maintenance" ||
      STARTUP_REPAIR_SOURCES.has(source) || STARTUP_REPAIR_SOURCES.has(reason)) {
      queueLane = "maintenance";
      basePriority = 90;
    } else if (input.operationMode === "historical_import" ||
      (["episode_title", "episode_assignment", "episode_finalize"].includes(input.jobType) && input.payload?.captureOrigin === "agent_source_scan") ||
      ((SUMMARY_JOB_TYPES.has(input.jobType) || input.jobType === "embedding") &&
        (source === "agent_source.scan.summary_stage" || reason === "import.summary.updated" ||
          input.target?.captureOrigin === "agent_source_scan" || isImportedPolicyTarget(input.target)))) {
      queueLane = "import";
      basePriority = 2;
    } else if (input.jobType === "embedding") {
      if (isImportedPolicyTarget(input.target)) {
        queueLane = "import";
        basePriority = 2;
      } else if (input.target?.memoryLayer === "L1" || input.target?.memoryKind === "user_memory") {
        queueLane = "interactive";
        basePriority = 1;
      }
    }

    return Object.freeze({
      ...base, queueLane, basePriority, policyVersion: JOB_POLICY_VERSION,
      lease: input.jobType === "embedding_retry" ? this.leases.embeddingRetry : this.leases.resources[base.resourceClass]
    });
  }
}

export const jobPolicyRegistry = new JobPolicyRegistry();
