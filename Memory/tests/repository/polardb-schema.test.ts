import { describe, expect, it } from "vitest";
import {
  polardbMigrationSql,
  POLARDB_MIGRATION_ID,
  POLARDB_SCHEMA_VERSION
} from "../../src/index.js";

describe("repository PolarDB schema contract", () => {
  it("publishes migration SQL for the memories table and runtime support tables", () => {
    const sql = polardbMigrationSql().join("\n");
    expect(POLARDB_MIGRATION_ID).toBe("001_memmy_memory_service_runtime_schema");
    expect(POLARDB_SCHEMA_VERSION).toBe("runtime-v1");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS memories");
    expect(sql).toContain("properties JSONB");
    expect(sql).toContain("memory_layer TEXT NOT NULL");
    expect(sql).toContain("properties_tsvector_zh TSVECTOR");
    expect(sql).toContain("embedding vector");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS skill_trials");
    expect(sql).toContain("last_seen_at TIMESTAMPTZ NOT NULL");
    expect(sql).toContain("idx_sessions_host_scope");
    expect(sql).toContain("turn_count INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("feedback_ids JSONB");
    expect(sql).toContain("decision_repair_ids JSONB");
    expect(sql).toContain("l2_policy_ids JSONB");
    expect(sql).toContain("l3_world_model_ids JSONB");
    expect(sql).toContain("skill_memory_ids JSONB");
    expect(sql).toContain("r_task DOUBLE PRECISION");
    expect(sql).toContain("reward_detail JSONB");
    expect(sql).toContain("idx_episodes_pipeline");
    expect(sql).toContain("expires_at TIMESTAMPTZ");
    expect(sql).toContain("project_id TEXT");
    expect(sql).toContain("high_value_memory_ids JSONB");
    expect(sql).toContain("attached_policy_memory_ids JSONB");
    expect(sql).toContain("idx_feedback_context");
    expect(sql).toContain("idx_decision_repairs_context");
    expect(sql).toContain("idx_trace_policy_links_l2");
    expect(sql).toContain("episode_id TEXT NOT NULL");
    expect(sql).toContain("idx_skill_trials_episode_status");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS memory_change_log");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS idempotency_keys");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS evolution_jobs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS embedding_retry_queue");
    expect(sql).toContain("idx_embedding_retry_due");
  });
});
