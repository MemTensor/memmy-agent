-- Schema v9 from upstream 5326b303, used only to test preservation on upgrade.
CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  );
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    timeline TEXT NOT NULL,
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
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    info_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(info_json)),
    properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
    memory_layer TEXT NOT NULL CHECK (memory_layer IN ('L1', 'L2', 'L3', 'Skill')),
    content_hash TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
CREATE INDEX idx_memories_layer_status_updated
    ON memories (memory_layer, status, updated_at DESC);
CREATE INDEX idx_memories_layer_status_created
    ON memories (memory_layer, status, created_at DESC);
CREATE INDEX idx_memories_conversation_updated
    ON memories (conversation_id, updated_at DESC);
CREATE INDEX idx_memories_session_layer
    ON memories (session_id, memory_layer, updated_at DESC);
CREATE INDEX idx_memories_agent_app
    ON memories (agent_id, app_id, updated_at DESC);
CREATE INDEX idx_memories_content_hash_layer
    ON memories (content_hash, memory_layer);
CREATE INDEX idx_memories_key_layer
    ON memories (memory_key, memory_layer);
CREATE TABLE l3_world_model_scopes (
    scope_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    workspace_uri TEXT,
    memory_id TEXT UNIQUE REFERENCES memories(id) ON DELETE SET NULL,
    next_scope_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_scope_seq >= 1),
    updated_at TEXT NOT NULL,
    CHECK (workspace_uri IS NULL OR (project_id IS NOT NULL AND length(workspace_uri) > 0))
  );
CREATE UNIQUE INDEX uq_l3_world_model_scopes_general
    ON l3_world_model_scopes (user_id)
    WHERE project_id IS NULL;
CREATE UNIQUE INDEX uq_l3_world_model_scopes_project
    ON l3_world_model_scopes (user_id, project_id)
    WHERE project_id IS NOT NULL;
CREATE TABLE user_memories (
    id TEXT PRIMARY KEY,
    source_turn_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    memory_types_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(memory_types_json)),
    content TEXT NOT NULL,
    normalized_user_text_hash TEXT NOT NULL,
    source_turn_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_turn_refs_json)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    replaces_memory_id TEXT,
    replaced_by_memory_id TEXT,
    archived_at TEXT,
    archive_reason TEXT,
    embedding_json TEXT CHECK (embedding_json IS NULL OR json_valid(embedding_json)),
    embedding_model TEXT,
    embedding_provider TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
CREATE INDEX idx_user_memories_user_status_updated
    ON user_memories (user_id, status, updated_at DESC);
CREATE INDEX idx_user_memories_source_turn
    ON user_memories (source_turn_id);
CREATE INDEX idx_user_memories_exact_text
    ON user_memories (user_id, normalized_user_text_hash, status, updated_at DESC);
CREATE VIRTUAL TABLE user_memories_fts USING fts5 (
    id UNINDEXED,
    content,
    memory_types,
    tokenize='unicode61'
  );
CREATE VIRTUAL TABLE memories_fts USING fts5 (
    id UNINDEXED,
    identifier,
    memory_value,
    tags,
    tokenize='unicode61'
  );
CREATE TABLE memory_vector_entries (
    id INTEGER PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    vector_field TEXT NOT NULL CHECK (vector_field IN ('vec_summary', 'vec_action', 'vec')),
    embedding_model TEXT,
    embedding_provider TEXT,
    embedding_dim INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (memory_id, vector_field)
  );
CREATE INDEX idx_memory_vector_entries_field_updated
    ON memory_vector_entries (vector_field, updated_at DESC, id DESC);
CREATE TABLE sessions (
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
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    opened_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    closed_at TEXT,
    updated_at TEXT NOT NULL
  );
CREATE INDEX idx_sessions_user_updated
    ON sessions (user_id, updated_at DESC);
CREATE INDEX idx_sessions_host_key
    ON sessions (host_session_key);
CREATE INDEX idx_sessions_host_scope
    ON sessions (user_id, source, profile_id, host_session_key, status);
CREATE TABLE l3_world_model_session_cursors (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_scheduled_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_scheduled_seq >= 0),
    updated_at TEXT NOT NULL
  );
CREATE TABLE work_memory_session_cursors (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_extracted_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_extracted_seq >= 0),
    updated_at TEXT NOT NULL
  );
CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    project_id TEXT,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
    title TEXT,
    summary TEXT,
    l1_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l1_memory_ids_json)),
    raw_turn_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(raw_turn_ids_json)),
    feedback_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(feedback_ids_json)),
    decision_repair_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(decision_repair_ids_json)),
    l2_policy_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l2_policy_ids_json)),
    l3_world_model_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l3_world_model_ids_json)),
    skill_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_memory_ids_json)),
    turn_count INTEGER NOT NULL DEFAULT 0,
    r_task REAL,
    reward_detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reward_detail_json)),
    pipeline_run_id TEXT,
    pipeline_status TEXT NOT NULL DEFAULT 'idle' CHECK (pipeline_status IN ('idle', 'running', 'succeeded', 'failed')),
    pipeline_error TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    updated_at TEXT NOT NULL
  );
CREATE INDEX idx_episodes_session_updated
    ON episodes (session_id, updated_at DESC);
CREATE INDEX idx_episodes_project_updated
    ON episodes (project_id, updated_at DESC);
CREATE INDEX idx_episodes_pipeline
    ON episodes (pipeline_status, updated_at DESC);
CREATE TABLE raw_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    user_text TEXT,
    assistant_text TEXT,
    reasoning_summary TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_calls_json)),
    tool_results_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_results_json)),
    source_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
    usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
    message_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(message_payload_json)),
    status TEXT NOT NULL DEFAULT 'succeeded',
    redacted_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, turn_id)
  );
CREATE INDEX idx_raw_turns_episode_created
    ON raw_turns (episode_id, created_at ASC);
CREATE INDEX idx_raw_turns_user_turn
    ON raw_turns (user_id, turn_id);
CREATE TABLE l3_world_model_input_traces (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    trace_seq INTEGER NOT NULL CHECK (trace_seq >= 1),
    l1_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    raw_turn_id TEXT NOT NULL REFERENCES raw_turns(id) ON DELETE CASCADE,
    episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, trace_seq),
    UNIQUE (session_id, l1_memory_id)
  );
CREATE INDEX idx_l3_world_model_input_traces_raw_turn
    ON l3_world_model_input_traces (raw_turn_id, session_id, trace_seq);
CREATE TABLE feedback (
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
    magnitude REAL NOT NULL DEFAULT 1,
    rationale TEXT,
    raw_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_payload_json)),
    context_hash TEXT,
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_feedback_session_created
    ON feedback (session_id, created_at DESC);
CREATE INDEX idx_feedback_memory
    ON feedback (l1_memory_id, created_at DESC);
CREATE INDEX idx_feedback_user_created
    ON feedback (user_id, created_at DESC);
CREATE INDEX idx_feedback_episode_created
    ON feedback (episode_id, created_at DESC);
CREATE INDEX idx_feedback_raw_turn_created
    ON feedback (raw_turn_id, created_at DESC);
CREATE INDEX idx_feedback_context
    ON feedback (user_id, project_id, context_hash, created_at DESC);
CREATE TABLE l3_world_model_evidence_batches (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL REFERENCES l3_world_model_scopes(scope_key) ON DELETE CASCADE,
    scope_seq INTEGER NOT NULL CHECK (scope_seq >= 1),
    user_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN (
      'new_task', 'token_compaction', 'token_compaction_attempt', 'session_close', 'episode_idle_close'
    )),
    start_trace_seq INTEGER NOT NULL CHECK (start_trace_seq >= 1),
    end_trace_seq INTEGER NOT NULL CHECK (end_trace_seq >= start_trace_seq),
    l1_memory_ids_json TEXT NOT NULL CHECK (json_valid(l1_memory_ids_json)),
    raw_turn_ids_json TEXT NOT NULL CHECK (json_valid(raw_turn_ids_json)),
    feedback_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(feedback_ids_json)),
    payload_hash TEXT NOT NULL,
    terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN (
      'applied', 'partial_dead_letter', 'dead_letter'
    )),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (scope_key, scope_seq)
  );
CREATE INDEX idx_l3_world_model_batches_session_trace
    ON l3_world_model_evidence_batches (session_id, end_trace_seq);
CREATE TABLE l3_world_model_batch_targets (
    batch_id TEXT NOT NULL REFERENCES l3_world_model_evidence_batches(id) ON DELETE CASCADE,
    target_field TEXT NOT NULL CHECK (target_field IN (
      'general_rules_and_safety_constraints', 'project_contract', 'domain_knowledge'
    )),
    field_scope_key TEXT NOT NULL,
    scope_seq INTEGER NOT NULL CHECK (scope_seq >= 1),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applied', 'dead_letter')),
    no_change INTEGER NOT NULL DEFAULT 0 CHECK (no_change IN (0, 1)),
    applied_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (batch_id, target_field),
    UNIQUE (field_scope_key, scope_seq),
    CHECK (status = 'applied' OR no_change = 0)
  );
CREATE INDEX idx_l3_world_model_targets_field_status
    ON l3_world_model_batch_targets (field_scope_key, status, scope_seq);
CREATE TABLE decision_repairs (
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
    high_value_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(high_value_memory_ids_json)),
    low_value_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(low_value_memory_ids_json)),
    attached_policy_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attached_policy_memory_ids_json)),
    feedback_id TEXT,
    validated INTEGER NOT NULL DEFAULT 0 CHECK (validated IN (0, 1)),
    source_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_json)),
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_decision_repairs_context
    ON decision_repairs (user_id, project_id, context_hash);
CREATE INDEX idx_decision_repairs_episode
    ON decision_repairs (episode_id, created_at DESC);
CREATE TABLE l2_candidate_pool (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_memory_id TEXT NOT NULL,
    candidate_key TEXT NOT NULL,
    candidate_value TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'rejected')),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  );
CREATE INDEX idx_l2_candidate_status
    ON l2_candidate_pool (user_id, status, updated_at DESC);
CREATE INDEX idx_l2_candidate_pending_expiry
    ON l2_candidate_pool (user_id, candidate_key, status, expires_at);
CREATE TABLE trace_policy_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    l1_memory_id TEXT NOT NULL,
    l2_memory_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'supports',
    strength REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (l1_memory_id, l2_memory_id, relation)
  );
CREATE INDEX idx_trace_policy_links_l1
    ON trace_policy_links (user_id, l1_memory_id, created_at DESC);
CREATE INDEX idx_trace_policy_links_l2
    ON trace_policy_links (user_id, l2_memory_id, created_at DESC);
CREATE TABLE skill_trials (
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
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
CREATE INDEX idx_skill_trials_skill_created
    ON skill_trials (skill_memory_id, created_at DESC);
CREATE INDEX idx_skill_trials_user_status
    ON skill_trials (user_id, status, created_at DESC);
CREATE INDEX idx_skill_trials_episode_status
    ON skill_trials (episode_id, status, created_at DESC);
CREATE INDEX idx_skill_trials_l1_status
    ON skill_trials (l1_memory_id, status, created_at DESC);
CREATE INDEX idx_skill_trials_raw_status
    ON skill_trials (raw_turn_id, status, created_at DESC);
CREATE TABLE skill_clusters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools_json)),
    artifacts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json)),
    tool_bigrams_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_bigrams_json)),
    centroid_json TEXT,
    skill_memory_id TEXT,
    meta_skill_md TEXT NOT NULL DEFAULT '',
    processed_episode_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(processed_episode_ids_json)),
    member_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE INDEX idx_skill_clusters_scope
    ON skill_clusters (user_id, project_id, updated_at DESC);
CREATE INDEX idx_skill_clusters_skill
    ON skill_clusters (skill_memory_id);
CREATE TABLE skill_cluster_members (
    cluster_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'unknown'
      CHECK (outcome IN ('success', 'failure', 'unknown')),
    r_task REAL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (cluster_id, episode_id)
  );
CREATE INDEX idx_skill_cluster_members_episode
    ON skill_cluster_members (episode_id, assigned_at DESC);
CREATE TABLE recall_events (
    id TEXT PRIMARY KEY,
    namespace_id TEXT,
    session_id TEXT,
    episode_id TEXT,
    turn_id TEXT,
    user_id TEXT NOT NULL,
    query TEXT NOT NULL,
    query_hash TEXT,
    layers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(layers_json)),
    candidate_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_memory_ids_json)),
    injected_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(injected_memory_ids_json)),
    hit_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hit_memory_ids_json)),
    dropped_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped_json)),
    outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'positive', 'negative', 'ignored')),
    request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request_json)),
    query_id TEXT,
    user_memory_candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(user_memory_candidate_ids_json)),
    l1_candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(l1_candidate_ids_json)),
    merged_source_turn_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(merged_source_turn_ids_json)),
    member_memory_ids_by_source_turn_id_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(member_memory_ids_by_source_turn_id_json)),
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_recall_events_session_created
    ON recall_events (session_id, created_at DESC);
CREATE TABLE api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL CHECK (tool_name IN ('memory_add', 'memory_search', 'skill_generate', 'skill_evolve')),
    source_agent TEXT,
    input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
    output_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(output_json)),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
    called_at TEXT NOT NULL
  );
CREATE INDEX idx_api_logs_tool_time
    ON api_logs (tool_name, called_at DESC);
CREATE INDEX idx_api_logs_tool_source_time
    ON api_logs (tool_name, source_agent, called_at DESC);
CREATE TABLE memory_change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    namespace_id TEXT,
    kind TEXT,
    op TEXT,
    entity_id TEXT,
    user_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    version INTEGER,
    before_json TEXT,
    after_json TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_memory_change_log_namespace_seq
    ON memory_change_log (namespace_id, seq);
CREATE INDEX idx_memory_change_log_created
    ON memory_change_log (created_at DESC);
CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
CREATE TABLE source_turn_captures (
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    namespace_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    session_id TEXT,
    episode_id TEXT,
    raw_turn_id TEXT,
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    source_sequence INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, profile_id, namespace_key, conversation_id, turn_id)
  );
CREATE INDEX idx_source_turn_captures_conversation
    ON source_turn_captures (user_id, source, profile_id, namespace_key, conversation_id, completed_at DESC);
CREATE INDEX idx_source_turn_captures_native_turn
    ON source_turn_captures (source, profile_id, namespace_key, conversation_id, turn_id);
CREATE INDEX idx_source_turn_captures_native_conversation
    ON source_turn_captures (source, profile_id, namespace_key, conversation_id, completed_at DESC);
CREATE INDEX idx_source_sessions_native_conversation
    ON sessions (source, profile_id, conversation_id);
CREATE INDEX idx_source_sessions_native_host_key
    ON sessions (source, profile_id, host_session_key);
CREATE TABLE memory_capture_claims (
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    qa_hash TEXT NOT NULL,
    primary_memory_id TEXT NOT NULL,
    captured_by TEXT NOT NULL CHECK (captured_by IN ('turn_complete', 'agent_source_scan')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, qa_hash)
  );
CREATE INDEX idx_memory_capture_claims_primary_memory
    ON memory_capture_claims (primary_memory_id);
CREATE TABLE l3_world_model_project_environment_state (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (project_kind IN ('unknown', 'code', 'folder')),
    status TEXT NOT NULL DEFAULT 'uninitialized' CHECK (status IN (
      'uninitialized', 'queued', 'scanning', 'summarizing', 'clean', 'failed'
    )),
    current_scan_id TEXT,
    applied_scan_id TEXT,
    fingerprint TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id)
  );
CREATE INDEX idx_l3_world_model_project_environment_status
    ON l3_world_model_project_environment_state (status, updated_at);
CREATE TABLE evolution_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter')),
    dedupe_key TEXT,
    user_id TEXT NOT NULL,
    session_id TEXT,
    episode_id TEXT,
    target_memory_id TEXT,
    scope_key TEXT,
    scope_seq INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    leased_until TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
CREATE INDEX idx_evolution_jobs_status_created
    ON evolution_jobs (status, created_at ASC);
CREATE INDEX idx_evolution_jobs_target
    ON evolution_jobs (target_memory_id, job_type);
CREATE UNIQUE INDEX uq_evolution_jobs_l3_immutable_dedupe
    ON evolution_jobs (dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND job_type IN ('l3_world_model_update', 'project_environment_profile');
CREATE UNIQUE INDEX uq_evolution_jobs_scope_seq
    ON evolution_jobs (scope_key, scope_seq)
    WHERE scope_key IS NOT NULL;
CREATE TABLE embedding_retry_queue (
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
    next_attempt_at INTEGER NOT NULL,
    claimed_by TEXT,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (target_kind, target_id, vector_field)
  );
CREATE INDEX idx_embedding_retry_due
    ON embedding_retry_queue (status, next_attempt_at);
CREATE INDEX idx_embedding_retry_target
    ON embedding_retry_queue (target_kind, target_id);
CREATE TABLE memory_processing_state (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN (
      'summary_pending', 'summarizing', 'embedding_pending', 'embedding',
      'ready', 'ready_text_only', 'failed'
    )),
    stage TEXT CHECK (stage IN ('summary', 'embedding')),
    active_job_id TEXT REFERENCES evolution_jobs(id) ON DELETE SET NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    manual_retry_count INTEGER NOT NULL DEFAULT 0,
    retry_action TEXT NOT NULL DEFAULT 'retry'
      CHECK (retry_action IN ('retry', 'open_settings', 'none')),
    error_code TEXT,
    error_message TEXT,
    failed_at TEXT,
    updated_at TEXT NOT NULL
  );
CREATE INDEX idx_memory_processing_state_state_updated
    ON memory_processing_state (state, updated_at ASC);
CREATE INDEX idx_memory_processing_state_active_job
    ON memory_processing_state (active_job_id);
CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    episode_id TEXT,
    raw_turn_id TEXT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    uri TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_artifacts_session_created
    ON artifacts (session_id, created_at DESC);
CREATE TABLE runtime_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL
  );
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    actor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(actor_json)),
    action TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
    created_at TEXT NOT NULL
  );
CREATE INDEX idx_audit_logs_user_created
    ON audit_logs (user_id, created_at DESC);
CREATE TABLE token_usage_outbox (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  );
CREATE UNIQUE INDEX uq_evolution_jobs_active_dedupe
         ON evolution_jobs (dedupe_key)
         WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'leased', 'failed');
INSERT INTO schema_migrations VALUES ('009_token_usage_outbox', 9, '2026-10-01', 'fixture');
