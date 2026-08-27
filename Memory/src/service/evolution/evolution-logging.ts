import { createMemoryLogger } from "../../logging/logger.js";
import type { EvolutionJobRecord } from "../../storage/repositories.js";

const evolutionLogger = createMemoryLogger("evolution");

export function evolutionJobLogFields(job: EvolutionJobRecord): Record<string, unknown> {
  return {
    jobId: job.id,
    jobType: job.jobType,
    status: job.status,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    sessionId: job.sessionId,
    episodeId: job.episodeId,
    targetMemoryId: job.targetMemoryId,
    targetField: typeof job.payload.targetField === "string" ? job.payload.targetField : undefined,
    scopeKey: job.scopeKey,
    scopeSeq: job.scopeSeq
  };
}

export function logEvolutionDecision(
  job: EvolutionJobRecord,
  stage: "l2_induction" | "l3_abstraction" | "l3_world_model_update" | "skill_crystallization",
  reason: string,
  fields: Record<string, unknown> = {}
): void {
  const context = {
    ...evolutionJobLogFields(job),
    stage,
    reason,
    ...fields
  };
  if (/llm-failed|llm-refusal|invalid|verification_failed|malformed|truncat/i.test(reason)) {
    evolutionLogger.warn("generation.skipped", context);
  } else {
    evolutionLogger.info("gate.skipped", context);
  }
}
