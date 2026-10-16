export const MEMORY_BYOK_TOKENS_PER_M = 1_000_000;
export const DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M = 10;
export const DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M = 500;
export const MAX_MEMORY_BYOK_LIMIT_M = 99_999;
export const EPISODE_IDLE_CLOSE_JOB_TYPE = "episode_idle_close";

export const MEMORY_WORKER_JOB_TYPES = [
  "episode_idle_close",
  "episode_title",
  "trace_summary",
  "user_memory_embedding",
  "import_summary",
  "reflection",
  "embedding",
  "reward",
  "span_big_turn",
  "negative_experience",
  "l2_association",
  "l2_induction",
  "l3_abstraction",
  "l3_world_model_update",
  "project_environment_profile",
  "skill_crystallization",
  "skill_cluster_assign",
  "skill_batch_evolve",
  "skill_trial_resolve",
  "work_memory_extract",
  "decision_repair",
  "feedback_experience"
] as const;

export type MemoryTokenBudgetTrigger = "daily" | "total";
export type MemoryBudgetModelRole = "memory_summary" | "memory_evolution" | "embedding";

export interface MemoryBudgetModelSource {
  source?: string | null;
  mode?: string | null;
}

export interface MemoryBudgetModelSources {
  memory_summary?: MemoryBudgetModelSource;
  memory_evolution?: MemoryBudgetModelSource;
  embedding?: MemoryBudgetModelSource;
}

export interface MemoryTokenBudgetLimits {
  dailyLimitM: number;
  totalLimitM: number;
}

export interface MemoryTokenBudgetUsage {
  dailyUsed: number;
  lifetimeUsed: number;
}

export interface MemoryTokenBudgetSnapshot extends MemoryTokenBudgetLimits, MemoryTokenBudgetUsage {
  paused: boolean;
  trigger: MemoryTokenBudgetTrigger | null;
}

export function isBudgetedMemoryUsage(input: {
  kind?: string | null;
  operation?: string | null;
}): boolean {
  const operation = typeof input.operation === "string" ? input.operation.trim() : "";
  if (operation === "embedding.query" || operation.startsWith("retrieval.")) {
    return false;
  }
  if (input.kind === "memory_summary" || input.kind === "memory_evolution") {
    return true;
  }
  return input.kind === "embedding" && (
    operation === "embedding.document" || operation.startsWith("embedding.document.")
  );
}

export function jobTypeBudgetRoles(jobType: string): MemoryBudgetModelRole[] {
  switch (jobType) {
    case EPISODE_IDLE_CLOSE_JOB_TYPE:
    case "negative_experience":
    case "l2_association":
    case "l3_abstraction":
    case "skill_cluster_assign":
    case "skill_trial_resolve":
      return [];
    case "episode_title":
    case "trace_summary":
    case "import_summary":
    case "span_big_turn":
    case "work_memory_extract":
      return ["memory_summary"];
    case "reflection":
    case "reward":
      return ["memory_summary", "memory_evolution"];
    case "embedding":
    case "user_memory_embedding":
      return ["embedding"];
    default:
      return ["memory_evolution"];
  }
}

export function isBudgetedByokModelSource(
  role: MemoryBudgetModelRole,
  source?: MemoryBudgetModelSource | null
): boolean {
  if (!source || source.source !== "byok") {
    return false;
  }
  return role !== "embedding" || source.mode !== "local";
}

export function jobTypeConsumesMemoryBudget(
  jobType: string,
  models?: MemoryBudgetModelSources
): boolean {
  const roles = jobTypeBudgetRoles(jobType);
  if (roles.length === 0) {
    return false;
  }
  if (!models) {
    return true;
  }
  return roles.some((role) => isBudgetedByokModelSource(role, models[role]));
}

export function allowedMemoryBudgetJobTypes(
  models?: MemoryBudgetModelSources
): string[] {
  return MEMORY_WORKER_JOB_TYPES.filter((jobType) => !jobTypeConsumesMemoryBudget(jobType, models));
}

export function parseMemoryByokLimitM(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < 0 || value > MAX_MEMORY_BYOK_LIMIT_M) {
    return undefined;
  }
  return value;
}

export function normalizeMemoryByokLimitM(
  value: unknown,
  fallback: number
): number {
  return parseMemoryByokLimitM(value) ?? fallback;
}

export function evaluateMemoryTokenBudget(
  input: MemoryTokenBudgetLimits & MemoryTokenBudgetUsage
): MemoryTokenBudgetSnapshot {
  const dailyLimitM = normalizeMemoryByokLimitM(input.dailyLimitM, DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M);
  const totalLimitM = normalizeMemoryByokLimitM(input.totalLimitM, DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M);
  const dailyUsed = nonNegativeInteger(input.dailyUsed);
  const lifetimeUsed = nonNegativeInteger(input.lifetimeUsed);
  const dailyHit = dailyLimitM > 0 && dailyUsed >= dailyLimitM * MEMORY_BYOK_TOKENS_PER_M;
  const totalHit = totalLimitM > 0 && lifetimeUsed >= totalLimitM * MEMORY_BYOK_TOKENS_PER_M;
  const trigger: MemoryTokenBudgetTrigger | null = totalHit ? "total" : dailyHit ? "daily" : null;
  return {
    dailyLimitM,
    totalLimitM,
    dailyUsed,
    lifetimeUsed,
    paused: trigger !== null,
    trigger
  };
}

export function localCalendarDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function nextLocalMidnightMs(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

export function startOfLocalDayIso(now: Date = new Date()): string {
  return startOfLocalDay(now).toISOString();
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}
