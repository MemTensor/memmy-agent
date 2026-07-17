export const POLARDB_SCHEMA_VERSION = "runtime-v1";
export const POLARDB_MIGRATION_ID = "001_memmy_memory_service_runtime_schema";

export function polardbMigrationSql(): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL,
      checksum TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      timeline TIMESTAMPTZ NOT NULL,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      app_id TEXT,
      memory_type TEXT NOT NULL DEFAULT 'LongTermMemory',
      status TEXT NOT NULL DEFAULT 'activated'
        CHECK (status IN ('activated', 'resolving', 'archived', 'deleted')),
      visibility TEXT NOT NULL DEFAULT 'private',
      memory_key TEXT,
      memory_value TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      info JSONB NOT NULL DEFAULT '{}'::jsonb,
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      memory_layer TEXT NOT NULL CHECK (memory_layer IN ('L1', 'L2', 'L3', 'Skill')),
      embedding vector,
      embedding_model TEXT,
      embedding_dim INTEGER,
      content_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      properties_tsvector_zh TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(memory_value, '') || ' ' || coalesce(memory_key, ''))
      ) STORED
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user_layer_status_updated
      ON memories (user_id, memory_layer, status, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user_conversation
      ON memories (user_id, conversation_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_agent_app
      ON memories (agent_id, app_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_tags_gin
      ON memories USING GIN (tags)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_info_gin
      ON memories USING GIN (info)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_properties_gin
      ON memories USING GIN (properties)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_tsvector
      ON memories USING GIN (properties_tsvector_zh)`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      source TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_label TEXT,
      workspace_id TEXT,
      workspace_path TEXT,
      host_session_key TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      opened_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
      ON sessions (user_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_host_scope
      ON sessions (user_id, source, profile_id, host_session_key, status)`,
    `CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      project_id TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
      title TEXT,
      summary TEXT,
      l1_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_turn_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      feedback_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      decision_repair_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      l2_policy_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      l3_world_model_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      skill_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      turn_count INTEGER NOT NULL DEFAULT 0,
      r_task DOUBLE PRECISION,
      reward_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      pipeline_run_id TEXT,
      pipeline_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (pipeline_status IN ('idle', 'running', 'succeeded', 'failed')),
      pipeline_error TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      opened_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_episodes_project_updated
      ON episodes (project_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_episodes_pipeline
      ON episodes (pipeline_status, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS raw_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      user_text TEXT,
      assistant_text TEXT,
      reasoning_summary TEXT,
      tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
      tool_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      usage JSONB NOT NULL DEFAULT '{}'::jsonb,
      message_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'succeeded',
      redacted_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (session_id, turn_id)
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      conversation_id TEXT,
      session_id TEXT,
      episode_id TEXT,
      l1_memory_id TEXT,
      raw_turn_id TEXT,
      channel TEXT NOT NULL CHECK (channel IN ('explicit', 'implicit')),
      polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral')),
      magnitude DOUBLE PRECISION NOT NULL DEFAULT 1,
      rationale TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      context_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_user_created
      ON feedback (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_episode_created
      ON feedback (episode_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_raw_turn_created
      ON feedback (raw_turn_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_context
      ON feedback (user_id, project_id, context_hash, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS decision_repairs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      episode_id TEXT,
      raw_turn_id TEXT,
      user_id TEXT NOT NULL,
      project_id TEXT,
      context_hash TEXT,
      issue TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      preference TEXT,
      anti_pattern TEXT,
      high_value_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      low_value_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      attached_policy_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      feedback_id TEXT,
      validated BOOLEAN NOT NULL DEFAULT false,
      source JSONB NOT NULL DEFAULT '{}'::jsonb,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_decision_repairs_context
      ON decision_repairs (user_id, project_id, context_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_decision_repairs_episode
      ON decision_repairs (episode_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS l2_candidate_pool (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      source_memory_id TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      candidate_value TEXT NOT NULL,
      score DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'rejected')),
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_l2_candidate_pending_expiry
      ON l2_candidate_pool (user_id, candidate_key, status, expires_at)`,
    `CREATE TABLE IF NOT EXISTS trace_policy_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      l1_memory_id TEXT NOT NULL,
      l2_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'supports',
      strength DOUBLE PRECISION NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (l1_memory_id, l2_memory_id, relation)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_trace_policy_links_l1
      ON trace_policy_links (user_id, l1_memory_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_trace_policy_links_l2
      ON trace_policy_links (user_id, l2_memory_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS skill_trials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      skill_memory_id TEXT NOT NULL,
      session_id TEXT,
      episode_id TEXT NOT NULL,
      l1_memory_id TEXT,
      raw_turn_id TEXT,
      turn_id TEXT,
      tool_call_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'pass', 'fail', 'unknown')),
      outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('unknown', 'success', 'failure', 'cancelled')),
      feedback_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_skill_trials_skill_created
      ON skill_trials (skill_memory_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_skill_trials_user_status
      ON skill_trials (user_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_skill_trials_episode_status
      ON skill_trials (episode_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_skill_trials_l1_status
      ON skill_trials (l1_memory_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_skill_trials_raw_status
      ON skill_trials (raw_turn_id, status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS recall_events (
      id TEXT PRIMARY KEY,
      namespace_id TEXT,
      session_id TEXT,
      episode_id TEXT,
      turn_id TEXT,
      user_id TEXT NOT NULL,
      query TEXT NOT NULL,
      query_hash TEXT,
      layers JSONB NOT NULL DEFAULT '[]'::jsonb,
      candidate_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      injected_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      hit_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      dropped JSONB NOT NULL DEFAULT '[]'::jsonb,
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'positive', 'negative', 'ignored')),
      request JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS memory_change_log (
      seq BIGSERIAL PRIMARY KEY,
      memory_id TEXT NOT NULL,
      namespace_id TEXT,
      kind TEXT,
      op TEXT,
      entity_id TEXT,
      user_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      version INTEGER,
      before JSONB,
      after JSONB,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_change_log_namespace_seq
      ON memory_change_log (namespace_id, seq)`,
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS evolution_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter')),
      dedupe_key TEXT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      episode_id TEXT,
      target_memory_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      leased_until TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_evolution_jobs_status_created
      ON evolution_jobs (status, created_at ASC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_evolution_jobs_active_dedupe
      ON evolution_jobs (dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'leased', 'failed')`,
    `CREATE TABLE IF NOT EXISTS embedding_retry_queue (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('trace', 'policy', 'world_model', 'skill')),
      target_id TEXT NOT NULL,
      vector_field TEXT NOT NULL CHECK (vector_field IN ('vec_summary', 'vec_action', 'vec')),
      source_text TEXT NOT NULL,
      embed_role TEXT NOT NULL DEFAULT 'document' CHECK (embed_role IN ('document', 'query')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'failed', 'succeeded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 6,
      next_attempt_at BIGINT NOT NULL,
      claimed_by TEXT,
      lease_until BIGINT,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE (target_kind, target_id, vector_field)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_embedding_retry_due
      ON embedding_retry_queue (status, next_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS idx_embedding_retry_target
      ON embedding_retry_queue (target_kind, target_id)`,
    `CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      episode_id TEXT,
      raw_turn_id TEXT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      actor JSONB NOT NULL DEFAULT '{}'::jsonb,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      before JSONB,
      after JSONB,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    )`
  ];
}
