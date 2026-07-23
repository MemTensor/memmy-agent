/** Legacy app-state migration module. */
import type { DatabaseSync } from "node:sqlite";
import { LOCAL_BYOK_ACCOUNT_UUID } from "./account-context.js";

const LOCAL_AGENT_SOURCE_UUID = "local-agent-sources";
const SNAPSHOT_TABLE = "_legacy_app_state_snapshot";
const SNAPSHOT_ID = "singleton";
const SNAPSHOT_VERSION = 1;

interface LegacyAccountSessionRow {
  user_id: string | null;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar_url: string | null;
  plan_type: string | null;
  has_finished_guide: number | null;
  region: string | null;
  registered_at: string | null;
  raw_profile_json: string | null;
  cloud_uuid_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyOnboardingRow {
  completed: number;
  current_step: string;
  has_accepted_terms: number;
  accepted_terms_version: string | null;
  scan_permission: string;
  improvement_program: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyPrivacyRow {
  allow_memory_improvement_upload: number;
  local_only_mode: number;
  created_at: string;
  updated_at: string;
}

interface LegacyTokenUsageRow {
  plan_name: string;
  total_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  expires_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyModelConfigRow {
  provider: string;
  base_url: string;
  model_id: string;
  api_key_ref: string | null;
  embedding_mode: string;
  embedding_base_url: string | null;
  embedding_model_id: string | null;
  embedding_api_key_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyAgentSourceRow {
  source_id: string;
  display_name: string;
  data_path: string;
  builtin: number;
  status: string;
  last_scanned_at: string | null;
  created_at: string;
}

interface LegacyIngestionSeenRow {
  dedup_key: string;
  source_id: string;
  created_at: string;
}

interface LegacyIdempotencyRow {
  adapter_id: string;
  request_id: string;
  body_hash: string;
  response_json: string;
  status_code: number;
  created_at: string;
}

export interface LegacyAppStateSnapshot {
  userMode: string | null;
  account: LegacyAccountSessionRow | null;
  onboarding: LegacyOnboardingRow | null;
  privacy: LegacyPrivacyRow | null;
  tokenUsage: LegacyTokenUsageRow | null;
  modelConfig: LegacyModelConfigRow | null;
  agentSources: LegacyAgentSourceRow[];
  ingestionSeen: LegacyIngestionSeenRow[];
  idempotency: LegacyIdempotencyRow[];
}

/**
 * Captures the singleton schema before later SQL migrations replace or remove it.
 *
 * @param db The open app-state database before runMigrations.
 * @returns A snapshot for final-schema restoration, or null when the database is already current or empty.
 */
export function captureLegacyAppState(db: DatabaseSync): LegacyAppStateSnapshot | null {
  const persistedSnapshot = readPersistedSnapshot(db);
  if (persistedSnapshot) {
    return persistedSnapshot;
  }
  if (!tableExists(db, "account_session")) {
    return null;
  }

  const registeredAtColumn = tableHasColumn(db, "account_session", "registered_at")
    ? "registered_at"
    : "NULL AS registered_at";
  const cloudUuidColumn = legacyCloudUuidSelect(db);

  const snapshot: LegacyAppStateSnapshot = {
    userMode: readOptionalRow<{ user_mode: string }>(
      db,
      "app_settings",
      "SELECT user_mode FROM app_settings WHERE id = 'default'"
    )?.user_mode ?? null,
    account: readOptionalRow<LegacyAccountSessionRow>(
      db,
      "account_session",
      `SELECT
        user_id,
        email,
        phone,
        nickname,
        avatar_url,
        plan_type,
        has_finished_guide,
        region,
        ${registeredAtColumn},
        raw_profile_json,
        ${cloudUuidColumn},
        created_at,
        updated_at
      FROM account_session
      WHERE id = 'default'`
    ),
    onboarding: readOptionalRow<LegacyOnboardingRow>(
      db,
      "onboarding_state",
      `SELECT
        completed,
        current_step,
        has_accepted_terms,
        accepted_terms_version,
        scan_permission,
        improvement_program,
        completed_at,
        created_at,
        updated_at
      FROM onboarding_state
      WHERE id = 'default'`
    ),
    privacy: readOptionalRow<LegacyPrivacyRow>(
      db,
      "privacy_settings",
      `SELECT
        allow_memory_improvement_upload,
        local_only_mode,
        created_at,
        updated_at
      FROM privacy_settings
      WHERE id = 'default'`
    ),
    tokenUsage: readOptionalRow<LegacyTokenUsageRow>(
      db,
      "token_usage_cache",
      `SELECT
        plan_name,
        total_tokens,
        used_tokens,
        remaining_tokens,
        expires_at,
        last_synced_at,
        created_at,
        updated_at
      FROM token_usage_cache
      WHERE id = 'default'`
    ),
    modelConfig: readOptionalRow<LegacyModelConfigRow>(
      db,
      "model_config",
      `SELECT
        provider,
        base_url,
        model_id,
        api_key_ref,
        embedding_mode,
        embedding_base_url,
        embedding_model_id,
        embedding_api_key_ref,
        created_at,
        updated_at
      FROM model_config
      WHERE id = 'default'`
    ),
    agentSources: readRows<LegacyAgentSourceRow>(
      db,
      "agent_sources",
      `SELECT
        source_id,
        display_name,
        data_path,
        builtin,
        status,
        last_scanned_at,
        created_at
      FROM agent_sources`
    ),
    ingestionSeen: readRows<LegacyIngestionSeenRow>(
      db,
      "ingestion_seen",
      "SELECT dedup_key, source_id, created_at FROM ingestion_seen"
    ),
    idempotency: tableHasColumn(db, "idempotency_keys", "uuid")
      ? []
      : readRows<LegacyIdempotencyRow>(
          db,
          "idempotency_keys",
          `SELECT
            adapter_id,
            request_id,
            body_hash,
            response_json,
            status_code,
            created_at
          FROM idempotency_keys`
        )
  };
  persistSnapshot(db, snapshot);
  return snapshot;
}

/**
 * Restores a pre-account-isolation snapshot into the fully migrated schema.
 *
 * @param db The migrated app-state database.
 * @param snapshot The state captured before SQL migrations ran.
 */
export function restoreLegacyAppState(db: DatabaseSync, snapshot: LegacyAppStateSnapshot): void {
  const accountUuid = legacyAccountUuid(snapshot.account);
  const stateUuid = snapshot.userMode === "account" && accountUuid
    ? accountUuid
    : LOCAL_BYOK_ACCOUNT_UUID;

  if (accountUuid && snapshot.account) {
    restoreCloudAccount(db, accountUuid, snapshot.account);
  }
  if (stateUuid && stateUuid !== accountUuid) {
    ensureScopeAccount(db, stateUuid);
  }

  if (stateUuid) {
    restoreOnboarding(db, stateUuid, snapshot);
    restorePrivacy(db, stateUuid, snapshot.privacy);
    restoreModelConfig(db, stateUuid, snapshot.modelConfig);
  }

  if (accountUuid) {
    restoreTokenUsage(db, accountUuid, snapshot.tokenUsage);
    restoreIdempotency(db, accountUuid, snapshot.idempotency);
    if (snapshot.userMode === "account") {
      db.prepare(
        `UPDATE app_settings
         SET active_uuid = ?, updated_at = ?
         WHERE id = 'default' AND active_uuid IS NULL`
      ).run(accountUuid, new Date().toISOString());
    }
  }

  restoreAgentSources(db, snapshot.agentSources, snapshot.ingestionSeen);
}

/** Removes the durable snapshot after restoration and schema finalization succeed. */
export function discardLegacyAppStateSnapshot(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS ${SNAPSHOT_TABLE}`);
}

function restoreCloudAccount(db: DatabaseSync, uuid: string, account: LegacyAccountSessionRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO cloud_accounts (
      uuid,
      user_id,
      email,
      phone,
      nickname,
      avatar,
      plan_type,
      has_finished_guide,
      region,
      registered_at,
      cloud_uuid_ref,
      raw_profile_json,
      last_login_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    account.user_id,
    account.email,
    account.phone,
    account.nickname,
    account.avatar_url,
    account.plan_type,
    account.has_finished_guide,
    account.region,
    account.registered_at,
    account.cloud_uuid_ref,
    account.raw_profile_json,
    account.updated_at,
    account.created_at,
    account.updated_at
  );
}

function restoreOnboarding(db: DatabaseSync, uuid: string, snapshot: LegacyAppStateSnapshot): void {
  const onboarding = snapshot.onboarding;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO account_onboarding_state (
      uuid,
      has_finished_guide,
      current_step,
      has_accepted_terms,
      accepted_terms_version,
      scan_permission,
      improvement_program,
      completed_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    onboarding?.completed ?? snapshot.account?.has_finished_guide ?? 0,
    onboarding?.current_step ?? "scan_permission_required",
    onboarding?.has_accepted_terms ?? 0,
    onboarding?.accepted_terms_version ?? null,
    onboarding?.scan_permission ?? "unset",
    onboarding?.improvement_program ?? "unset",
    onboarding?.completed_at ?? null,
    onboarding?.created_at ?? now,
    onboarding?.updated_at ?? now
  );
}

function restorePrivacy(db: DatabaseSync, uuid: string, privacy: LegacyPrivacyRow | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO account_privacy_settings (
      uuid,
      allow_memory_improvement_upload,
      local_only_mode,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(
    uuid,
    privacy?.allow_memory_improvement_upload ?? 0,
    privacy?.local_only_mode ?? 0,
    privacy?.created_at ?? now,
    privacy?.updated_at ?? now
  );
}

function restoreTokenUsage(db: DatabaseSync, uuid: string, usage: LegacyTokenUsageRow | null): void {
  if (!usage) {
    return;
  }

  db.prepare(
    `INSERT OR IGNORE INTO account_token_usage_cache (
      uuid,
      plan_name,
      total_tokens,
      used_tokens,
      remaining_tokens,
      expires_at,
      last_synced_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    usage.plan_name,
    usage.total_tokens,
    usage.used_tokens,
    usage.remaining_tokens,
    usage.expires_at,
    usage.last_synced_at,
    usage.created_at,
    usage.updated_at
  );
}

function restoreModelConfig(db: DatabaseSync, uuid: string, config: LegacyModelConfigRow | null): void {
  if (!config) {
    return;
  }

  const customEmbedding = config.embedding_mode === "separate";
  db.prepare(
    `INSERT OR IGNORE INTO account_model_config (
      uuid,
      provider,
      base_url,
      model_id,
      api_key_ref,
      embedding_mode,
      embedding_base_url,
      embedding_model_id,
      embedding_api_key_ref,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    config.provider,
    config.base_url,
    config.model_id,
    config.api_key_ref,
    customEmbedding ? "custom" : "local",
    customEmbedding ? config.embedding_base_url : null,
    customEmbedding ? config.embedding_model_id : null,
    customEmbedding ? config.embedding_api_key_ref : null,
    config.created_at,
    config.updated_at
  );
}

function restoreAgentSources(
  db: DatabaseSync,
  sources: LegacyAgentSourceRow[],
  ingestionSeen: LegacyIngestionSeenRow[]
): void {
  if (sources.length === 0 && ingestionSeen.length === 0) {
    return;
  }

  ensureScopeAccount(db, LOCAL_AGENT_SOURCE_UUID);
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO account_agent_sources (
      uuid,
      source_id,
      display_name,
      data_path,
      builtin,
      status,
      last_scanned_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const source of sources) {
    insertSource.run(
      LOCAL_AGENT_SOURCE_UUID,
      source.source_id,
      source.display_name,
      source.data_path,
      source.builtin,
      source.status,
      source.last_scanned_at,
      source.created_at,
      source.created_at
    );
  }

  const insertSeen = db.prepare(
    `INSERT OR IGNORE INTO account_ingestion_seen (
      uuid,
      dedup_key,
      source_id,
      created_at
    ) VALUES (?, ?, ?, ?)`
  );
  for (const seen of ingestionSeen) {
    if (sourceIds.has(seen.source_id)) {
      insertSeen.run(LOCAL_AGENT_SOURCE_UUID, seen.dedup_key, seen.source_id, seen.created_at);
    }
  }
}

function restoreIdempotency(db: DatabaseSync, uuid: string, rows: LegacyIdempotencyRow[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (
      uuid,
      adapter_id,
      request_id,
      body_hash,
      response_json,
      status_code,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      uuid,
      row.adapter_id,
      row.request_id,
      row.body_hash,
      row.response_json,
      row.status_code,
      row.created_at
    );
  }
}

function ensureScopeAccount(db: DatabaseSync, uuid: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO cloud_accounts (uuid, created_at, updated_at)
     VALUES (?, ?, ?)`
  ).run(uuid, now, now);
}

function legacyAccountUuid(account: LegacyAccountSessionRow | null): string | null {
  const userId = account?.user_id?.trim();
  return userId && userId !== "unknown" ? userId : null;
}

function readOptionalRow<T>(db: DatabaseSync, tableName: string, sql: string): T | null {
  if (!tableExists(db, tableName)) {
    return null;
  }
  return (db.prepare(sql).get() as T | undefined) ?? null;
}

function readRows<T>(db: DatabaseSync, tableName: string, sql: string): T[] {
  if (!tableExists(db, tableName)) {
    return [];
  }
  return db.prepare(sql).all() as unknown as T[];
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  );
}

function readPersistedSnapshot(db: DatabaseSync): LegacyAppStateSnapshot | null {
  if (!tableExists(db, SNAPSHOT_TABLE)) {
    return null;
  }
  const row = db
    .prepare(`SELECT schema_version, snapshot_json FROM ${SNAPSHOT_TABLE} WHERE id = ?`)
    .get(SNAPSHOT_ID) as { schema_version: number; snapshot_json: string } | undefined;
  if (!row) {
    return null;
  }
  if (row.schema_version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported legacy app-state snapshot version: ${row.schema_version}`);
  }
  return JSON.parse(row.snapshot_json) as LegacyAppStateSnapshot;
}

function persistSnapshot(db: DatabaseSync, snapshot: LegacyAppStateSnapshot): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
        id TEXT PRIMARY KEY CHECK (id = '${SNAPSHOT_ID}'),
        schema_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT OR REPLACE INTO ${SNAPSHOT_TABLE} (
        id,
        schema_version,
        snapshot_json,
        created_at
      ) VALUES (?, ?, ?, ?)`
    ).run(SNAPSHOT_ID, SNAPSHOT_VERSION, JSON.stringify(snapshot), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).some(
    (column) => column.name === columnName
  );
}

function legacyCloudUuidSelect(db: DatabaseSync): string {
  if (tableHasColumn(db, "account_session", "cloud_uuid_ref")) {
    return "cloud_uuid_ref";
  }
  if (tableHasColumn(db, "account_session", "cloud_token_ref")) {
    return `CASE cloud_token_ref
      WHEN 'account-session:default:cloud-token' THEN 'account-session:default:cloud-uuid'
      ELSE cloud_token_ref
    END AS cloud_uuid_ref`;
  }
  return "NULL AS cloud_uuid_ref";
}
