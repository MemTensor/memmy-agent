/** Shared eligibility for legacy leasing and read-only scheduling previews. */
export interface QueueEligibilityOptions {
  targetMemoryIds?: readonly string[];
  allowedJobTypes?: readonly string[];
  excludedJobTypes?: readonly string[];
  /** WRR admits due failures directly; legacy leasing still requires requeue. */
  includeDueFailed?: boolean;
}

export function mainQueueEligibility(at: string, options: QueueEligibilityOptions = {}): {
  sql: string; params: Array<string | number>;
} {
  const { targetMemoryIds, allowedJobTypes, excludedJobTypes } = options;
  if (targetMemoryIds?.length === 0 || allowedJobTypes?.length === 0) return { sql: "0", params: [] };
  const targetFilter = targetMemoryIds
    ? `AND target_memory_id IN (${targetMemoryIds.map(() => "?").join(", ")})`
    : "";
  return {
    sql: `(status = 'queued'
              ${options.includeDueFailed ? "OR status = 'failed'" : ""}
              OR (status = 'leased' AND (leased_until IS NULL OR leased_until <= ?)))
             AND failure_count < max_attempts
             AND (available_at IS NULL OR available_at <= ?)
             AND (blocked_reason IS NULL OR blocked_reason != 'configuration')
             AND NOT (
               job_type = 'reward'
               AND json_extract(payload_json, '$.l1MemoryId') IS NOT NULL
               AND (
                 json_extract(payload_json, '$.polarity') IS NULL
                 OR json_extract(payload_json, '$.polarity') = 'positive'
               )
               AND EXISTS (
                 SELECT 1
                 FROM memory_processing_state
                 JOIN memories ON memories.id = memory_processing_state.memory_id
                 WHERE memory_processing_state.memory_id =
                   CAST(json_extract(evolution_jobs.payload_json, '$.l1MemoryId') AS TEXT)
                   AND NOT EXISTS (
                     SELECT 1
                     FROM memory_vector_entries
                     WHERE memory_vector_entries.memory_id = memory_processing_state.memory_id
                       AND memory_vector_entries.vector_field = 'vec_summary'
                   )
                   AND (
                     memory_processing_state.state IN ('embedding_pending', 'embedding')
                   OR memory_processing_state.state IN ('summary_pending', 'summarizing')
                   )
               )
             )
             AND (
               json_extract(payload_json, '$.runAfter') IS NULL
               OR CAST(json_extract(payload_json, '$.runAfter') AS TEXT) <= ?
             )
             AND (
               job_type NOT IN ('l3_world_model_update', 'work_memory_extract')
               OR (
                 scope_key IS NOT NULL
                 AND scope_seq IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM evolution_jobs AS leased_l3_job
                   WHERE leased_l3_job.job_type = evolution_jobs.job_type
                     AND leased_l3_job.scope_key = evolution_jobs.scope_key
                     AND leased_l3_job.status = 'leased'
                     AND leased_l3_job.id <> evolution_jobs.id
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM evolution_jobs AS earlier_l3_job
                   WHERE earlier_l3_job.job_type = evolution_jobs.job_type
                     AND earlier_l3_job.scope_key = evolution_jobs.scope_key
                     AND earlier_l3_job.scope_seq < evolution_jobs.scope_seq
                     AND earlier_l3_job.status IN ('queued', 'leased', 'failed')
                 )
               )
             )
             ${allowedJobTypes ? `AND job_type IN (${allowedJobTypes.map(() => "?").join(", ")})` : ""}
             ${excludedJobTypes?.length ? `AND job_type NOT IN (${excludedJobTypes.map(() => "?").join(", ")})` : ""}
             ${targetFilter}`,
    params: [at, at, at, ...(allowedJobTypes ?? []), ...(excludedJobTypes ?? []), ...(targetMemoryIds ?? [])]
  };
}

export function retryQueueEligibility(now: number, targetMemoryIds?: readonly string[]): {
  sql: string; params: Array<string | number>;
} {
  if (targetMemoryIds?.length === 0) return { sql: "0", params: [] };
  return {
    sql: `(q.status = 'pending' OR (q.status = 'in_progress' AND q.lease_until IS NOT NULL AND q.lease_until <= ?))
      AND q.next_attempt_at <= ?
      ${targetMemoryIds ? `AND q.target_id IN (${targetMemoryIds.map(() => "?").join(", ")})` : ""}`,
    params: [now, now, ...(targetMemoryIds ?? [])]
  };
}
