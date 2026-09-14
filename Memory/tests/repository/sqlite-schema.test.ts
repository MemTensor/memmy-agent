import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryDb, SCHEMA_MIGRATION_ID, SCHEMA_VERSION } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";

describe("repository sqlite schema contract", () => {
  it("adds global memory indexes when reopening a database with only user-prefixed indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-global-index-upgrade-"));
    const dbPath = join(root, "memory.sqlite");
    try {
      const initial = new MemoryDb({ path: dbPath });
      initial.db.exec(`
        DROP INDEX idx_memories_layer_status_updated;
        DROP INDEX idx_memories_conversation_updated;
        DROP INDEX idx_memories_content_hash_layer;
        DROP INDEX idx_memories_key_layer;
        CREATE INDEX idx_memories_user_layer_status_updated
          ON memories (user_id, memory_layer, status, updated_at DESC);
        CREATE INDEX idx_memories_user_conversation
          ON memories (user_id, conversation_id, updated_at DESC);
        CREATE INDEX idx_memories_hash
          ON memories (user_id, content_hash, memory_layer);
        CREATE INDEX idx_memories_key
          ON memories (user_id, memory_key, memory_layer);
      `);
      initial.close();

      const reopened = new MemoryDb({ path: dbPath });
      const indexes = reopened.db
        .prepare(`PRAGMA index_list(memories)`)
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_memories_layer_status_updated",
        "idx_memories_layer_status_created",
        "idx_memories_conversation_updated",
        "idx_memories_content_hash_layer",
        "idx_memories_key_layer"
      ]));
      const queryPlan = reopened.db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT *
         FROM memories
         WHERE memory_layer = ?
           AND memory_key = ?
           AND deleted_at IS NULL`
      ).all("L1", "shared-key") as Array<{ detail: string }>;
      expect(queryPlan.some((step) => step.detail.includes("idx_memories_key_layer"))).toBe(true);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the runtime tables on a fresh sqlite database", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-schema-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const schema = db.schemaVersion();
      expect(schema.version).toBe(SCHEMA_VERSION);
      expect(schema.lastMigrationId).toBe(SCHEMA_MIGRATION_ID);

      const tables = db.db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')`)
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
        "memories",
        "l3_world_model_scopes",
        "sessions",
        "l3_world_model_session_cursors",
        "episodes",
        "raw_turns",
        "l3_world_model_input_traces",
        "feedback",
        "l3_world_model_evidence_batches",
        "l3_world_model_batch_targets",
        "decision_repairs",
        "l2_candidate_pool",
        "trace_policy_links",
        "skill_trials",
        "recall_events",
        "memory_change_log",
        "idempotency_keys",
        "memory_capture_claims",
        "l3_world_model_project_environment_state",
        "evolution_jobs",
        "embedding_retry_queue",
        "memory_processing_state",
        "artifacts",
        "audit_logs",
        "memory_vector_entries"
      ]));
      expect(tables.map((table) => table.name)).not.toEqual(expect.arrayContaining([
        "memory_embeddings",
        "memory_vectors"
      ]));
      expect(db.db.prepare(`SELECT vec_version() AS version`).get()).toEqual({ version: "v0.1.9" });
      const memoryColumns = db.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
      expect(memoryColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
        "embedding",
        "embedding_model",
        "embedding_dim"
      ]));
      const vectorEntryColumns = db.db
        .prepare(`PRAGMA table_info(memory_vector_entries)`)
        .all() as Array<{ name: string }>;
      expect(vectorEntryColumns.map((column) => column.name)).not.toContain("embedding");
      const tableNames = new Set(tables.map((table) => table.name));
      expect([...tableNames].some((name) => name.startsWith("cloud_"))).toBe(false);

      const skillTrialColumns = db.db
        .prepare(`PRAGMA table_info(skill_trials)`)
        .all() as Array<{ name: string; notnull: number }>;
      const sessionColumns = db.db
        .prepare(`PRAGMA table_info(sessions)`)
        .all() as Array<{ name: string }>;
      expect(sessionColumns.map((column) => column.name)).toContain("source");
      expect(sessionColumns.map((column) => column.name)).not.toContain("agent_kind");
      expect(sessionColumns.map((column) => column.name)).toContain("last_seen_at");
      const sessionIndexes = db.db
        .prepare(`PRAGMA index_list(sessions)`)
        .all() as Array<{ name: string }>;
      expect(sessionIndexes.map((index) => index.name)).toContain("idx_sessions_host_scope");
      const episodeColumns = db.db
        .prepare(`PRAGMA table_info(episodes)`)
        .all() as Array<{ name: string }>;
      expect(episodeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "turn_count",
        "feedback_ids_json",
        "decision_repair_ids_json",
        "l2_policy_ids_json",
        "l3_world_model_ids_json",
        "skill_memory_ids_json",
        "r_task",
        "reward_detail_json",
        "pipeline_status"
      ]));
      const episodeIndexes = db.db
        .prepare(`PRAGMA index_list(episodes)`)
        .all() as Array<{ name: string }>;
      expect(episodeIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_episodes_project_updated",
        "idx_episodes_pipeline"
      ]));
      expect(skillTrialColumns.find((column) => column.name === "episode_id")?.notnull).toBe(1);
      expect(skillTrialColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "status",
        "outcome",
        "feedback_id"
      ]));
      const skillTrialIndexes = db.db
        .prepare(`PRAGMA index_list(skill_trials)`)
        .all() as Array<{ name: string }>;
      expect(skillTrialIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_skill_trials_skill_created",
        "idx_skill_trials_user_status",
        "idx_skill_trials_episode_status",
        "idx_skill_trials_l1_status",
        "idx_skill_trials_raw_status"
      ]));
      const feedbackIndexes = db.db
        .prepare(`PRAGMA index_list(feedback)`)
        .all() as Array<{ name: string }>;
      expect(feedbackIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_feedback_user_created",
        "idx_feedback_episode_created",
        "idx_feedback_raw_turn_created",
        "idx_feedback_context"
      ]));
      const tracePolicyLinkIndexes = db.db
        .prepare(`PRAGMA index_list(trace_policy_links)`)
        .all() as Array<{ name: string }>;
      expect(tracePolicyLinkIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_trace_policy_links_l1",
        "idx_trace_policy_links_l2"
      ]));
      const candidatePoolColumns = db.db
        .prepare(`PRAGMA table_info(l2_candidate_pool)`)
        .all() as Array<{ name: string }>;
      expect(candidatePoolColumns.map((column) => column.name)).toContain("expires_at");
      const repairColumns = db.db
        .prepare(`PRAGMA table_info(decision_repairs)`)
        .all() as Array<{ name: string }>;
      expect(repairColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "project_id",
        "context_hash",
        "preference",
        "anti_pattern",
        "high_value_memory_ids_json",
        "low_value_memory_ids_json",
        "attached_policy_memory_ids_json",
        "meta_json"
      ]));
      const repairIndexes = db.db
        .prepare(`PRAGMA index_list(decision_repairs)`)
        .all() as Array<{ name: string }>;
      expect(repairIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_decision_repairs_context",
        "idx_decision_repairs_episode"
      ]));
      const retryColumns = db.db
        .prepare(`PRAGMA table_info(embedding_retry_queue)`)
        .all() as Array<{ name: string }>;
      expect(retryColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "target_kind",
        "target_id",
        "vector_field",
        "source_text",
        "embed_role",
        "claimed_by",
        "lease_until"
      ]));
      const retryIndexes = db.db
        .prepare(`PRAGMA index_list(embedding_retry_queue)`)
        .all() as Array<{ name: string }>;
      expect(retryIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_embedding_retry_due",
        "idx_embedding_retry_target"
      ]));
      const apiLogColumns = db.db.prepare(`PRAGMA table_info(api_logs)`).all() as Array<{ name: string }>;
      expect(apiLogColumns.map((column) => column.name)).toContain("source_agent");
      const apiLogIndexes = db.db.prepare(`PRAGMA index_list(api_logs)`).all() as Array<{ name: string }>;
      expect(apiLogIndexes.map((index) => index.name)).toContain("idx_api_logs_tool_source_time");
      const evolutionJobColumns = db.db
        .prepare(`PRAGMA table_info(evolution_jobs)`)
        .all() as Array<{ name: string }>;
      expect(evolutionJobColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "scope_key",
        "scope_seq"
      ]));
      const evolutionJobIndexes = db.db
        .prepare(`PRAGMA index_list(evolution_jobs)`)
        .all() as Array<{ name: string }>;
      expect(evolutionJobIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "uq_evolution_jobs_l3_immutable_dedupe",
        "uq_evolution_jobs_scope_seq"
      ]));
      const scopeIndexes = db.db
        .prepare(`PRAGMA index_list(l3_world_model_scopes)`)
        .all() as Array<{ name: string }>;
      const scopeColumns = db.db
        .prepare(`PRAGMA table_info(l3_world_model_scopes)`)
        .all() as Array<{ name: string }>;
      expect(scopeColumns.map((column) => column.name)).toContain("workspace_uri");
      expect(scopeIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "uq_l3_world_model_scopes_general",
        "uq_l3_world_model_scopes_project"
      ]));
      const projectEnvironmentColumns = db.db
        .prepare(`PRAGMA table_info(l3_world_model_project_environment_state)`)
        .all() as Array<{ name: string }>;
      expect(projectEnvironmentColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "current_scan_id",
        "applied_scan_id",
        "fingerprint"
      ]));
      expect(projectEnvironmentColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
        "summary_text",
        "summary_scan_id",
        "profile_scan_id"
      ]));
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backfills hook QA claims when migrating a v6 database", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-v7-qa-claim-migration-"));
    const dbPath = join(root, "memory.sqlite");
    const at = "2026-01-01T00:00:00.000Z";
    try {
      const seeded = new MemoryDb({ path: dbPath });
      seeded.db.prepare(
        `INSERT INTO sessions (
           id, user_id, source, profile_id, status, meta_json,
           opened_at, last_seen_at, updated_at
         ) VALUES (?, ?, 'codex', 'default', 'open', '{}', ?, ?, ?)`
      ).run("qa-session", "qa-user", at, at, at);
      seeded.db.prepare(
        `INSERT INTO episodes (
           id, session_id, user_id, status, l1_memory_ids_json, raw_turn_ids_json,
           feedback_ids_json, decision_repair_ids_json, l2_policy_ids_json,
           l3_world_model_ids_json, skill_memory_ids_json, turn_count,
           reward_detail_json, pipeline_status, meta_json, opened_at, updated_at
         ) VALUES (?, ?, ?, 'open', '["qa-memory"]', '["qa-turn"]',
                   '[]', '[]', '[]', '[]', '[]', 1, '{}', 'idle', '{}', ?, ?)`
      ).run("qa-episode", "qa-session", "qa-user", at, at);
      seeded.db.prepare(
        `INSERT INTO raw_turns (
           id, session_id, episode_id, turn_id, user_id, user_text, assistant_text,
           tool_calls_json, tool_results_json, source_memory_ids_json, usage_json,
           message_payload_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '{}',
                   '{"turn_complete":{}}', 'succeeded', ?)`
      ).run(
        "qa-turn",
        "qa-session",
        "qa-episode",
        "turn-1",
        "qa-user",
        "迁移后不要重复写入。",
        "会通过 QA claim 判重。",
        at
      );
      seeded.db.prepare(
        `INSERT INTO memories (
           id, timeline, user_id, session_id, agent_id, memory_type, status,
           visibility, memory_key, memory_value, tags_json, info_json,
           properties_json, memory_layer, content_hash, version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'codex', 'LongTermMemory', 'activated',
                   'private', 'trace:qa-session:turn-1:0', 'legacy hook trace', '[]',
                   '{"raw_turn_id":"qa-turn"}',
                   '{"internal_info":{"raw_turn_id":"qa-turn","step_index":0}}',
                   'L1', 'qa-hash', 1, ?, ?)`
      ).run("qa-memory", at, "qa-user", "qa-session", at, at);
      seeded.db.exec(`
        DROP TABLE memory_capture_claims;
        DELETE FROM schema_migrations;
        INSERT INTO schema_migrations (id, version, applied_at, checksum)
        VALUES ('006_l3_world_model', 6, '${at}', 'v6');
      `);
      seeded.close();

      const migrated = new MemoryDb({ path: dbPath });
      expect(migrated.db.prepare(
        `SELECT user_id, source, primary_memory_id, captured_by
         FROM memory_capture_claims`
      ).get()).toEqual({
        user_id: "qa-user",
        source: "codex",
        primary_memory_id: "qa-memory",
        captured_by: "turn_complete"
      });
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates schema v2 to v4 without deleting user data", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-v2-source-agent-migration-"));
    const dbPath = join(root, "memory.sqlite");
    try {
      const seeded = new MemoryDb({ path: dbPath });
      const repos = new Repositories(seeded.db);
      repos.memories.insert(schemaVectorMemory());
      repos.runtime.createSession({
        id: "session-preserved",
        userId: "old-user",
        source: "codex",
        profileId: "default",
        status: "open",
        meta: {},
        openedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
      repos.runtime.insertApiLog({
        toolName: "memory_search",
        sourceAgent: "codex",
        inputJson: JSON.stringify({ query: "preserve this log", sessionId: "session-preserved" }),
        outputJson: JSON.stringify({ candidates: [] }),
        durationMs: 3,
        success: true,
        calledAt: "2026-01-01T00:00:01.000Z"
      });
      seeded.close();

      const v2 = new Database(dbPath);
      v2.exec(`
        DROP INDEX idx_api_logs_tool_source_time;
        ALTER TABLE api_logs DROP COLUMN source_agent;
        DELETE FROM schema_migrations;
        INSERT INTO schema_migrations (id, version, applied_at, checksum)
        VALUES ('002_sqlite_vec_storage', 2, '2026-01-01T00:00:00.000Z', 'v2');
      `);
      v2.close();

      const migrated = new MemoryDb({ path: dbPath });
      expect(migrated.schemaVersion()).toEqual({
        version: SCHEMA_VERSION,
        lastMigrationId: SCHEMA_MIGRATION_ID
      });
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM memories`).get()).toEqual({ count: 1 });
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({ count: 1 });
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM api_logs`).get()).toEqual({ count: 1 });
      expect(migrated.db.prepare(`SELECT input_json, source_agent FROM api_logs`).get()).toEqual({
        input_json: JSON.stringify({ query: "preserve this log", sessionId: "session-preserved" }),
        source_agent: null
      });
      expect((migrated.db.prepare(`PRAGMA index_list(api_logs)`).all() as Array<{ name: string }>)
        .map((index) => index.name)).toContain("idx_api_logs_tool_source_time");
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces the L3 world model ownership and immutable job constraints", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      const at = "2026-01-01T00:00:00.000Z";
      db.db.prepare(
        `INSERT INTO l3_world_model_scopes (
           scope_key, user_id, project_id, next_scope_seq, updated_at
         ) VALUES (?, ?, ?, 1, ?)`
      ).run("general:user-1", "user-1", null, at);
      expect(() => db.db.prepare(
        `INSERT INTO l3_world_model_scopes (
           scope_key, user_id, project_id, next_scope_seq, updated_at
         ) VALUES (?, ?, ?, 1, ?)`
      ).run("general:user-1-duplicate", "user-1", null, at)).toThrow(/UNIQUE/u);

      db.db.prepare(
        `INSERT INTO l3_world_model_scopes (
           scope_key, user_id, project_id, next_scope_seq, updated_at
         ) VALUES (?, ?, ?, 1, ?)`
      ).run("project:user-1:one", "user-1", "project-1", at);
      db.db.prepare(
        `UPDATE l3_world_model_scopes SET workspace_uri = 'file:///project-1'
         WHERE scope_key = 'project:user-1:one'`
      ).run();
      expect(() => db.db.prepare(
        `UPDATE l3_world_model_scopes SET workspace_uri = 'file:///general'
         WHERE scope_key = 'general:user-1'`
      ).run()).toThrow(/CHECK/u);
      expect(() => db.db.prepare(
        `INSERT INTO l3_world_model_scopes (
           scope_key, user_id, project_id, next_scope_seq, updated_at
         ) VALUES (?, ?, ?, 1, ?)`
      ).run("project:user-1:one-duplicate", "user-1", "project-1", at)).toThrow(/UNIQUE/u);

      db.db.prepare(
        `INSERT INTO sessions (
           id, user_id, source, profile_id, status, meta_json,
           opened_at, last_seen_at, updated_at
         ) VALUES (?, ?, 'codex', 'default', 'open', '{}', ?, ?, ?)`
      ).run("session-1", "user-1", at, at, at);

      db.db.prepare(
        `INSERT INTO l3_world_model_evidence_batches (
           id, scope_key, scope_seq, user_id, project_id, session_id, trigger,
           start_trace_seq, end_trace_seq, l1_memory_ids_json, raw_turn_ids_json,
           feedback_ids_json, payload_hash, created_at, updated_at
         ) VALUES (?, ?, 1, ?, NULL, ?, 'session_close', 1, 1, '[]', '[]', '[]', ?, ?, ?)`
      ).run("batch-1", "general:user-1", "user-1", "session-1", "hash-1", at, at);
      db.db.prepare(
        `INSERT INTO l3_world_model_batch_targets (
           batch_id, target_field, field_scope_key, scope_seq, status, no_change, updated_at
         ) VALUES (?, 'general_rules_and_safety_constraints', ?, 1, 'queued', 0, ?)`
      ).run("batch-1", "general:user-1:general", at);
      expect(() => db.db.prepare(
        `UPDATE l3_world_model_batch_targets SET no_change = 1 WHERE batch_id = ?`
      ).run("batch-1")).toThrow(/CHECK/u);

      const insertJob = db.db.prepare(
        `INSERT INTO evolution_jobs (
           id, job_type, status, dedupe_key, user_id, scope_key, scope_seq,
           payload_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`
      );
      insertJob.run(
        "l3-job-1", "l3_world_model_update", "succeeded", "immutable-l3", "user-1",
        "general:user-1:general", 1, at, at
      );
      expect(() => insertJob.run(
        "l3-job-2", "l3_world_model_update", "queued", "immutable-l3", "user-1",
        "general:user-1:other", 2, at, at
      )).toThrow(/UNIQUE/u);
      expect(() => insertJob.run(
        "l3-job-3", "l3_world_model_update", "queued", "different-dedupe", "user-1",
        "general:user-1:general", 1, at, at
      )).toThrow(/UNIQUE/u);

      db.db.prepare(
        `INSERT INTO l3_world_model_project_environment_state (
           user_id, project_id, updated_at
         ) VALUES (?, ?, ?)`
      ).run("user-1", "project-1", at);
      expect(() => db.db.prepare(
        `INSERT INTO l3_world_model_project_environment_state (
           user_id, project_id, updated_at
         ) VALUES (?, ?, ?)`
      ).run("user-1", "project-1", at)).toThrow(/UNIQUE/u);
    } finally {
      db.close();
    }
  });

  it("creates a pre-v6 backup once for an old disk database only", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-v6-backup-"));
    const dbPath = join(root, "memory.sqlite");
    const backupPath = `${dbPath}.pre-v${SCHEMA_VERSION}.bak`;
    try {
      const seeded = new MemoryDb({ path: dbPath });
      seeded.db.prepare(`UPDATE schema_migrations SET version = 5`).run();
      seeded.close();

      const migrated = new MemoryDb({ path: dbPath });
      expect(existsSync(backupPath)).toBe(true);
      const backup = new Database(backupPath, { readonly: true });
      expect(backup.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get())
        .toEqual({ version: 5 });
      backup.close();
      migrated.close();

      const marker = new Database(backupPath);
      marker.prepare(`UPDATE schema_migrations SET checksum = 'do-not-overwrite'`).run();
      marker.close();
      const reopened = new MemoryDb({ path: dbPath });
      reopened.close();
      const verified = new Database(backupPath, { readonly: true });
      expect(verified.prepare(`SELECT checksum FROM schema_migrations`).get())
        .toEqual({ checksum: "do-not-overwrite" });
      verified.close();

      const memoryOnly = new MemoryDb({ path: ":memory:" });
      memoryOnly.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates v5 L3 state and only backfills exact legacy adapter sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-v5-l3-migration-"));
    const dbPath = join(root, "memory.sqlite");
    const at = "2026-01-01T00:00:00.000Z";
    try {
      const seeded = new MemoryDb({ path: dbPath });
      const repos = new Repositories(seeded.db);
      repos.memories.insert(schemaLegacyWorldModel(
        "legacy-world-model-source",
        { source: "worker.l3_abstraction.v7" }
      ));
      repos.memories.insert(schemaLegacyWorldModel(
        "legacy-world-model-plugin",
        { plugin_algorithm: "l3.abstraction.v7" }
      ));
      repos.memories.insert(schemaLegacyWorldModel(
        "legacy-world-model-manual",
        { source: "manual" }
      ));
      repos.runtime.enqueueJob({
        id: "legacy-l3-job",
        jobType: "l3_abstraction",
        status: "queued",
        dedupeKey: "legacy-l3-job",
        userId: "old-user",
        targetMemoryId: "legacy-world-model-source",
        payload: {},
        attempts: 0,
        maxAttempts: 3,
        createdAt: at,
        updatedAt: at
      });

      const exactSessions = [
        ["codex-memory-exact", "codex"],
        ["cursor-memory-exact", "cursor"],
        ["claude_code-memory-exact", "claude_code"],
        ["opencode-memory-exact", "opencode"],
        ["openclaw-memory-exact", "openclaw"],
        ["hermes-memory-exact", "hermes"],
        ["deepseek-harness-exact", "deepseek_harness"]
      ] as const;
      for (const [id, source] of exactSessions) {
        repos.runtime.createSession({
          id,
          userId: "old-user",
          source,
          profileId: "default",
          status: "open",
          meta: {},
          openedAt: at,
          updatedAt: at
        });
      }
      const excludedSessions = [
        { id: "codexXmemory-near-prefix", source: "codex" },
        { id: "codex-memory-source-mismatch", source: "cursor" },
        { id: "workbuddy-memory-third-party", source: "workbuddy" }
      ] as const;
      for (const session of excludedSessions) {
        repos.runtime.createSession({
          ...session,
          userId: "old-user",
          profileId: "default",
          status: "open",
          meta: {},
          openedAt: at,
          updatedAt: at
        });
      }
      repos.runtime.createSession({
        id: "cursor-memory-existing-key",
        userId: "old-user",
        source: "cursor",
        profileId: "default",
        hostSessionKey: "already-set",
        status: "open",
        meta: {},
        openedAt: at,
        updatedAt: at
      });
      repos.runtime.createSession({
        id: "codex-memory-duplicate",
        userId: "duplicate-user",
        source: "codex",
        profileId: "default",
        status: "open",
        meta: {},
        openedAt: at,
        updatedAt: at
      });
      repos.runtime.createSession({
        id: "existing-host-key-owner",
        userId: "duplicate-user",
        source: "codex",
        profileId: "default",
        hostSessionKey: "codex-memory-duplicate",
        status: "open",
        meta: {},
        openedAt: at,
        updatedAt: at
      });
      repos.runtime.createEpisode({
        id: "legacy-open-episode",
        sessionId: "codex-memory-exact",
        userId: "old-user",
        status: "open",
        l1MemoryIds: [],
        rawTurnIds: [],
        feedbackIds: [],
        decisionRepairIds: [],
        l2PolicyIds: [],
        l3WorldModelIds: [],
        skillMemoryIds: [],
        turnCount: 0,
        rewardDetail: {},
        pipelineStatus: "idle",
        meta: {},
        openedAt: at,
        updatedAt: at
      });

      seeded.db.exec(`
        DROP TABLE l3_world_model_project_environment_state;
        DROP TABLE l3_world_model_batch_targets;
        DROP TABLE l3_world_model_evidence_batches;
        DROP TABLE l3_world_model_input_traces;
        DROP TABLE l3_world_model_session_cursors;
        DROP TABLE l3_world_model_scopes;
        DROP INDEX uq_evolution_jobs_l3_immutable_dedupe;
        DROP INDEX uq_evolution_jobs_scope_seq;
        ALTER TABLE evolution_jobs DROP COLUMN scope_key;
        ALTER TABLE evolution_jobs DROP COLUMN scope_seq;
        DELETE FROM schema_migrations;
        INSERT INTO schema_migrations (id, version, applied_at, checksum)
        VALUES ('005_memory_processing_state', 5, '${at}', 'v5');
      `);
      seeded.close();

      const migrated = new MemoryDb({ path: dbPath });
      expect(migrated.schemaVersion()).toEqual({
        version: SCHEMA_VERSION,
        lastMigrationId: SCHEMA_MIGRATION_ID
      });
      expect(migrated.db.prepare(
        `SELECT status, leased_until, last_error FROM evolution_jobs WHERE id = 'legacy-l3-job'`
      ).get()).toEqual({
        status: "dead_letter",
        leased_until: null,
        last_error: "replaced_by_l3_world_model_v1"
      });
      expect(migrated.db.prepare(
        `SELECT id, status, json_extract(properties_json, '$.status') AS property_status
         FROM memories
         WHERE id LIKE 'legacy-world-model-%'
         ORDER BY id`
      ).all()).toEqual([
        { id: "legacy-world-model-manual", status: "activated", property_status: "activated" },
        { id: "legacy-world-model-plugin", status: "archived", property_status: "archived" },
        { id: "legacy-world-model-source", status: "archived", property_status: "archived" }
      ]);
      expect(migrated.db.prepare(
        `SELECT id, host_session_key FROM sessions WHERE id IN (${exactSessions.map(() => "?").join(", ")}) ORDER BY id`
      ).all(...exactSessions.map(([id]) => id))).toEqual(
        [...exactSessions]
          .map(([id]) => ({ id, host_session_key: id }))
          .sort((left, right) => left.id.localeCompare(right.id))
      );
      expect(migrated.db.prepare(
        `SELECT id, host_session_key FROM sessions
         WHERE id IN (
           'codexXmemory-near-prefix', 'codex-memory-source-mismatch',
           'workbuddy-memory-third-party', 'codex-memory-duplicate'
         ) ORDER BY id`
      ).all()).toEqual([
        { id: "codex-memory-duplicate", host_session_key: null },
        { id: "codex-memory-source-mismatch", host_session_key: null },
        { id: "codexXmemory-near-prefix", host_session_key: null },
        { id: "workbuddy-memory-third-party", host_session_key: null }
      ]);
      expect(migrated.db.prepare(
        `SELECT host_session_key FROM sessions WHERE id = 'cursor-memory-existing-key'`
      ).get()).toEqual({ host_session_key: "already-set" });
      expect(migrated.db.prepare(
        `SELECT status, json_extract(meta_json, '$.l3_world_model_protocol_version') AS protocol
         FROM sessions WHERE id = 'codex-memory-exact'`
      ).get()).toEqual({ status: "open", protocol: null });
      expect(migrated.db.prepare(
        `SELECT status FROM episodes WHERE id = 'legacy-open-episode'`
      ).get()).toEqual({ status: "open" });
      expect((migrated.db.prepare(`PRAGMA table_info(l3_world_model_scopes)`).all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("workspace_uri");
      const projectEnvironmentColumns = migrated.db.prepare(
        `PRAGMA table_info(l3_world_model_project_environment_state)`
      ).all() as Array<{ name: string }>;
      expect(projectEnvironmentColumns.map((column) => column.name)).toContain("applied_scan_id");
      expect(projectEnvironmentColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
        "summary_text",
        "summary_scan_id",
        "profile_scan_id"
      ]));
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates v3 trace memories into explicit processing states without losing search data or vectors", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-v3-processing-migration-"));
    const dbPath = join(root, "memory.sqlite");
    try {
      const seeded = new MemoryDb({ path: dbPath });
      const repos = new Repositories(seeded.db);
      repos.memories.insert(schemaTraceMemory("legacy-ready", "legacy ready summary", true));
      repos.memories.insert(schemaTraceMemory("legacy-embedding", "legacy searchable summary", false));
      repos.memories.insert(schemaTraceMemory("legacy-summary", "摘要排队中", false));
      repos.memories.insert(schemaTraceMemory("legacy-failed", "legacy failed summary", false));
      repos.runtime.enqueueJob({
        id: "legacy-failed-job",
        jobType: "import_summary",
        status: "queued",
        dedupeKey: "import_summary:legacy-failed",
        userId: "old-user",
        targetMemoryId: "legacy-failed",
        payload: {},
        attempts: 3,
        maxAttempts: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
      seeded.db.prepare(`
        UPDATE evolution_jobs
        SET status = 'dead_letter', last_error = 'legacy provider failed'
        WHERE id = 'legacy-failed-job'
      `).run();
      seeded.db.exec(`
        DROP TABLE memory_processing_state;
        DELETE FROM schema_migrations;
        INSERT INTO schema_migrations (id, version, applied_at, checksum)
        VALUES ('003_runtime_schema', 3, '2026-01-01T00:00:00.000Z', 'v3');
      `);
      seeded.close();

      const migrated = new MemoryDb({ path: dbPath });
      const processingRows = migrated.db.prepare(`
        SELECT memory_id, state, stage, error_message
        FROM memory_processing_state
        ORDER BY memory_id
      `).all() as Array<{ memory_id: string; state: string; stage: string | null; error_message: string | null }>;
      expect(processingRows).toEqual([
        {
          memory_id: "legacy-embedding",
          state: "embedding_pending",
          stage: "embedding",
          error_message: null
        },
        {
          memory_id: "legacy-failed",
          state: "failed",
          stage: "summary",
          error_message: "legacy provider failed"
        },
        {
          memory_id: "legacy-ready",
          state: "ready",
          stage: null,
          error_message: null
        },
        {
          memory_id: "legacy-summary",
          state: "summary_pending",
          stage: "summary",
          error_message: null
        }
      ]);
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM memories`).get()).toEqual({ count: 4 });
      expect(migrated.db.prepare(`
        SELECT embedding_dim
        FROM memory_vector_entries
        WHERE memory_id = 'legacy-ready' AND vector_field = 'vec_summary'
      `).get()).toEqual({ embedding_dim: 3 });
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM memories_fts`).get()).toEqual({ count: 4 });
      const tags = migrated.db.prepare(`SELECT tags_json FROM memories WHERE id = 'legacy-embedding'`).get() as {
        tags_json: string;
      };
      expect(JSON.parse(tags.tags_json)).toEqual(["agent-source", "hermes", "legacy-user-tag"]);
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown schema without changing user data", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-incompatible-schema-"));
    try {
      const dbPath = join(root, "memory.sqlite");
      const incompatible = new Database(dbPath);
      incompatible.exec(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL,
          checksum TEXT NOT NULL
        );
        INSERT INTO schema_migrations VALUES ('001_runtime_schema', 1, '2026-01-01', 'old');
        CREATE TABLE memories (id TEXT PRIMARY KEY);
        INSERT INTO memories VALUES ('old-memory');
      `);
      incompatible.close();

      expect(() => new MemoryDb({ path: dbPath })).toThrow(/left unchanged/);
      const verified = new Database(dbPath);
      expect(verified.prepare(`SELECT id FROM memories`).get()).toEqual({ id: "old-memory" });
      expect(verified.prepare(`SELECT version FROM schema_migrations`).get()).toEqual({ version: 1 });
      verified.close();
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps vectors intact when an unknown schema is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-repo-incompatible-vec-schema-"));
    const dbPath = join(root, "memory.sqlite");
    try {
      const seeded = new MemoryDb({ path: dbPath });
      const repos = new Repositories(seeded.db);
      repos.memories.insert(schemaVectorMemory());
      expect(sqliteNames(seeded, "memory_vec_2%")).toEqual(expect.arrayContaining([
        "memory_vec_2",
        "memory_vec_2_chunks",
        "memory_vec_2_rowids"
      ]));
      seeded.db.prepare(
        `UPDATE schema_migrations SET version = 1, checksum = 'incompatible'`
      ).run();
      seeded.close();

      expect(() => new MemoryDb({ path: dbPath })).toThrow(/left unchanged/);
      const verified = new Database(dbPath);
      expect(verified.prepare(`SELECT COUNT(*) AS count FROM memories`).get()).toEqual({ count: 1 });
      expect(verified.prepare(`SELECT COUNT(*) AS count FROM memory_vector_entries`).get())
        .toEqual({ count: 1 });
      const names = (verified.prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'memory_vec_2%' ORDER BY name`
      ).all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual(expect.arrayContaining(["memory_vec_2", "memory_vec_2_chunks", "memory_vec_2_rowids"]));
      verified.close();
      expect(existsSync(`${dbPath}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

function schemaVectorMemory(): MemoryRow {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id: "old-vector-memory",
    timeline: at,
    userId: "old-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: "policy:old-vector-memory",
    memoryValue: "old vector memory",
    tags: [],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        policy: {
          status: "active",
          vec: [1, 0],
          embedding_model: "old-model"
        }
      }
    },
    memoryLayer: "L2",
    contentHash: "old-vector-memory-hash",
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function schemaTraceMemory(id: string, summary: string, withVector: boolean): MemoryRow {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "old-user",
    agentId: "hermes",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `memory.add:agent-source:hermes:${id}`,
    memoryValue: `Summary: ${summary}\n\nUser:\nlegacy searchable content`,
    tags: ["agent-source", "hermes", "legacy-user-tag", "摘要总结中", "索引建立中"],
    info: {
      summary,
      source: "hermes",
      import_pipeline: { status: "indexing" }
    },
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: "trace",
        plugin_algorithm: "memory.add.import_async.v2",
        import_pipeline: { status: "indexing" },
        trace: {
          summary,
          user_text: "legacy searchable content",
          agent_text: "legacy answer",
          tool_calls: [],
          ...(withVector
            ? {
              vec_summary: [1, 0, 0],
              embedding_model: "legacy-embedding-model"
            }
            : {})
        }
      }
    },
    memoryLayer: "L1",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function schemaLegacyWorldModel(
  id: string,
  marker: { source?: string; plugin_algorithm?: string }
): MemoryRow {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "old-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `legacy-world-model:${id}`,
    memoryValue: "legacy world model",
    tags: [],
    info: {},
    properties: {
      status: "activated",
      internal_info: {
        memory_layer: "L3",
        memory_kind: "world_model",
        ...marker
      }
    },
    memoryLayer: "L3",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function sqliteNames(db: MemoryDb, pattern: string): string[] {
  return (db.db.prepare(
    `SELECT name FROM sqlite_master WHERE name LIKE ? ORDER BY name`
  ).all(pattern) as Array<{ name: string }>).map((row) => row.name);
}
