/** Schema finalizer module. */
import type { DatabaseSync } from "node:sqlite";

const LEGACY_ACCOUNT_TABLES = [
  "account_session",
  "onboarding_state",
  "privacy_settings",
  "token_usage_cache",
  "model_config",
  "agent_sources",
  "ingestion_seen",
  "account_idempotency_keys"
] as const;

type SecretPurpose =
  | "cloud_uuid"
  | "model_api_key"
  | "embedding_api_key"
  | "memory_summary_api_key"
  | "memory_evolution_api_key"
  | "composio_machine_token"
  | "asr_api_key"
  | "image_gen_api_key";

interface CloudAccountRow {
  uuid: string;
  user_id: string | null;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
  plan_type: string | null;
  has_finished_guide: number | null;
  region: string | null;
  registered_at: string | null;
  cloud_uuid_ref: string | null;
  raw_profile_json: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelConfigRefRow {
  uuid: string;
  api_key_ref: string | null;
  embedding_api_key_ref: string | null;
  memory_api_key_ref: string | null;
  skill_api_key_ref: string | null;
  asr_api_key_ref: string | null;
  image_api_key_ref: string | null;
}

/** Handles finalize database design. */
export function finalizeDatabaseDesign(db: DatabaseSync): void {
  normalizeCloudAccountPrimaryKeys(db);
  normalizeAccountSecretRefs(db);
  dropLegacyAccountTables(db);
}

/** Normalizes normalize cloud account primary keys. */
function normalizeCloudAccountPrimaryKeys(db: DatabaseSync): void {
  const rows = listCloudAccounts(db);
  for (const row of rows) {
    const stableUuid = resolveStableAccountUuid(row);
    if (!stableUuid || stableUuid === row.uuid) {
      continue;
    }

    upsertCloudAccountWithUuid(db, row, stableUuid);
    moveAccountScopedRows(db, row.uuid, stableUuid);
    updateActiveUuid(db, row.uuid, stableUuid);
    db.prepare("DELETE FROM cloud_accounts WHERE uuid = ?").run(row.uuid);
  }
}

/** Normalizes normalize account secret refs. */
function normalizeAccountSecretRefs(db: DatabaseSync): void {
  for (const account of listCloudAccounts(db)) {
    const cloudUuidRef = normalizeSecretRef(db, account.cloud_uuid_ref, `account:${account.uuid}:cloud-uuid`, account.uuid, "cloud_uuid");
    if (cloudUuidRef !== account.cloud_uuid_ref) {
      db.prepare("UPDATE cloud_accounts SET cloud_uuid_ref = ?, updated_at = ? WHERE uuid = ?").run(
        cloudUuidRef,
        new Date().toISOString(),
        account.uuid
      );
    }
  }

  const modelRows = db
    .prepare("SELECT uuid, api_key_ref, embedding_api_key_ref, memory_api_key_ref, skill_api_key_ref, asr_api_key_ref, image_api_key_ref FROM account_model_config")
    .all() as unknown as ModelConfigRefRow[];
  for (const row of modelRows) {
    const apiKeyRef = normalizeSecretRef(db, row.api_key_ref, `account:${row.uuid}:model-api-key`, row.uuid, "model_api_key");
    const embeddingApiKeyRef = normalizeSecretRef(
      db,
      row.embedding_api_key_ref,
      `account:${row.uuid}:embedding-api-key`,
      row.uuid,
      "embedding_api_key"
    );
    const memoryApiKeyRef = normalizeSecretRef(
      db,
      row.memory_api_key_ref,
      `account:${row.uuid}:memory-summary-api-key`,
      row.uuid,
      "memory_summary_api_key"
    );
    const skillApiKeyRef = normalizeSecretRef(
      db,
      row.skill_api_key_ref,
      `account:${row.uuid}:memory-evolution-api-key`,
      row.uuid,
      "memory_evolution_api_key"
    );
    const asrApiKeyRef = normalizeSecretRef(
      db,
      row.asr_api_key_ref,
      `account:${row.uuid}:asr-api-key`,
      row.uuid,
      "asr_api_key"
    );
    const imageApiKeyRef = normalizeSecretRef(
      db,
      row.image_api_key_ref,
      `account:${row.uuid}:image-gen-api-key`,
      row.uuid,
      "image_gen_api_key"
    );
    db.prepare(
      `UPDATE account_model_config SET
        api_key_ref = ?,
        embedding_api_key_ref = ?,
        memory_api_key_ref = ?,
        skill_api_key_ref = ?,
        asr_api_key_ref = ?,
        image_api_key_ref = ?,
        updated_at = ?
      WHERE uuid = ?`
    ).run(apiKeyRef, embeddingApiKeyRef, memoryApiKeyRef, skillApiKeyRef, asrApiKeyRef, imageApiKeyRef, new Date().toISOString(), row.uuid);
  }
}

/**
 * Drops the legacy account singleton tables no longer allowed by the database design doc.
 *
 * @param db the app-state SQLite connection.
 */
function dropLegacyAccountTables(db: DatabaseSync): void {
  for (const tableName of LEGACY_ACCOUNT_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
}

/**
 * Reads the current cloud_accounts rows.
 *
 * @param db the app-state SQLite connection.
 * @returns the list of account rows.
 */
function listCloudAccounts(db: DatabaseSync): CloudAccountRow[] {
  try {
    return db
      .prepare(
        `SELECT
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
        FROM cloud_accounts
        ORDER BY updated_at ASC`
      )
      .all() as unknown as CloudAccountRow[];
  } catch {
    return [];
  }
}

/**
 * Resolves the stable account uuid.
 *
 * @param row the cloud_accounts row.
 * @returns a stable account id usable as a primary key; returns null when it cannot be determined.
 */
function resolveStableAccountUuid(row: CloudAccountRow): string | null {
  const userId = normalizeOptionalString(row.user_id);
  if (userId && userId !== "unknown") {
    return userId;
  }

  return looksLikeJwt(row.uuid) ? null : row.uuid;
}

/**
 * Inserts or updates the target stable account row.
 *
 * @param db the app-state SQLite connection.
 * @param source the historical account row.
 * @param stableUuid the stable account uuid.
 */
function upsertCloudAccountWithUuid(db: DatabaseSync, source: CloudAccountRow, stableUuid: string): void {
  db.prepare(
    `INSERT INTO cloud_accounts (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      user_id = excluded.user_id,
      email = excluded.email,
      phone = excluded.phone,
      nickname = excluded.nickname,
      avatar = excluded.avatar,
      plan_type = excluded.plan_type,
      has_finished_guide = excluded.has_finished_guide,
      region = excluded.region,
      registered_at = COALESCE(cloud_accounts.registered_at, excluded.registered_at),
      cloud_uuid_ref = COALESCE(cloud_accounts.cloud_uuid_ref, excluded.cloud_uuid_ref),
      raw_profile_json = COALESCE(excluded.raw_profile_json, cloud_accounts.raw_profile_json),
      last_login_at = COALESCE(excluded.last_login_at, cloud_accounts.last_login_at),
      updated_at = excluded.updated_at`
  ).run(
    stableUuid,
    source.user_id,
    source.email,
    source.phone,
    source.nickname,
    source.avatar,
    source.plan_type,
    source.has_finished_guide,
    source.region,
    source.registered_at,
    source.cloud_uuid_ref,
    source.raw_profile_json,
    source.last_login_at,
    source.created_at,
    source.updated_at
  );
}

/**
 * Migrates the uuid of all account-level child tables.
 *
 * @param db the app-state SQLite connection.
 * @param fromUuid the historical uuid.
 * @param toUuid the stable uuid.
 */
function moveAccountScopedRows(db: DatabaseSync, fromUuid: string, toUuid: string): void {
  movePrimaryKeyRow(db, "account_onboarding_state", fromUuid, toUuid, [
    "has_finished_guide",
    "current_step",
    "has_accepted_terms",
    "accepted_terms_version",
    "scan_permission",
    "improvement_program",
    "completed_at",
    "created_at",
    "updated_at"
  ]);
  movePrimaryKeyRow(db, "account_privacy_settings", fromUuid, toUuid, [
    "allow_memory_improvement_upload",
    "local_only_mode",
    "created_at",
    "updated_at"
  ]);
  movePrimaryKeyRow(db, "account_token_usage_cache", fromUuid, toUuid, [
    "plan_name",
    "total_tokens",
    "used_tokens",
    "remaining_tokens",
    "expires_at",
    "last_synced_at",
    "created_at",
    "updated_at"
  ]);
  movePrimaryKeyRow(db, "account_model_config", fromUuid, toUuid, [
    "provider",
    "base_url",
    "model_id",
    "api_key_ref",
    "embedding_mode",
    "embedding_base_url",
    "embedding_model_id",
    "embedding_api_key_ref",
    "memory_provider",
    "memory_base_url",
    "memory_model_id",
    "memory_api_key_ref",
    "skill_provider",
    "skill_base_url",
    "skill_model_id",
    "skill_api_key_ref",
    "asr_provider",
    "asr_base_url",
    "asr_model_id",
    "asr_api_key_ref",
    "image_provider",
    "image_base_url",
    "image_model_id",
    "image_api_key_ref",
    "created_at",
    "updated_at"
  ]);
  moveCompositeRows(db, "account_agent_sources", fromUuid, toUuid, ["source_id"], [
    "display_name",
    "data_path",
    "builtin",
    "status",
    "last_scanned_at",
    "created_at",
    "updated_at"
  ]);
  moveCompositeRows(db, "account_ingestion_seen", fromUuid, toUuid, ["dedup_key"], ["source_id", "created_at"]);
  moveCompositeRows(db, "idempotency_keys", fromUuid, toUuid, ["adapter_id", "request_id"], [
    "body_hash",
    "response_json",
    "status_code",
    "created_at"
  ]);
  db.prepare("UPDATE secret_store SET uuid = ?, updated_at = ? WHERE uuid = ?").run(toUuid, new Date().toISOString(), fromUuid);
}

/**
 * Moves an account table whose single-column primary key is uuid.
 *
 * @param db the app-state SQLite connection.
 * @param tableName the table name.
 * @param fromUuid the historical uuid.
 * @param toUuid the stable uuid.
 * @param columns the columns to copy besides uuid.
 */
function movePrimaryKeyRow(
  db: DatabaseSync,
  tableName: string,
  fromUuid: string,
  toUuid: string,
  columns: readonly string[]
): void {
  const selectColumns = columns.join(", ");
  db.prepare(
    `INSERT OR IGNORE INTO ${tableName} (uuid, ${selectColumns})
     SELECT ?, ${selectColumns}
     FROM ${tableName}
     WHERE uuid = ?`
  ).run(toUuid, fromUuid);
  db.prepare(`DELETE FROM ${tableName} WHERE uuid = ?`).run(fromUuid);
}

/**
 * Moves an account table whose composite primary key is uuid + business key.
 *
 * @param db the app-state SQLite connection.
 * @param tableName the table name.
 * @param fromUuid the historical uuid.
 * @param toUuid the stable uuid.
 * @param keyColumns the primary-key columns besides uuid.
 * @param valueColumns the ordinary value columns.
 */
function moveCompositeRows(
  db: DatabaseSync,
  tableName: string,
  fromUuid: string,
  toUuid: string,
  keyColumns: readonly string[],
  valueColumns: readonly string[]
): void {
  const columns = [...keyColumns, ...valueColumns];
  const selectColumns = columns.join(", ");
  db.prepare(
    `INSERT OR IGNORE INTO ${tableName} (uuid, ${selectColumns})
     SELECT ?, ${selectColumns}
     FROM ${tableName}
     WHERE uuid = ?`
  ).run(toUuid, fromUuid);
  db.prepare(`DELETE FROM ${tableName} WHERE uuid = ?`).run(fromUuid);
}

/**
 * Updates app_settings.active_uuid.
 *
 * @param db the app-state SQLite connection.
 * @param fromUuid the historical uuid.
 * @param toUuid the stable uuid.
 */
function updateActiveUuid(db: DatabaseSync, fromUuid: string, toUuid: string): void {
  db.prepare("UPDATE app_settings SET active_uuid = ?, updated_at = ? WHERE active_uuid = ?").run(
    toUuid,
    new Date().toISOString(),
    fromUuid
  );
}

/**
 * Normalizes the secret ref and metadata.
 *
 * @param db the app-state SQLite connection.
 * @param currentRef the ref currently saved in the business table.
 * @param targetRef the target ref required by the design doc.
 * @param uuid the owning account uuid.
 * @param purpose the secret purpose.
 * @returns the new ref the business table should save; returns null when there is no current ref.
 */
function normalizeSecretRef(
  db: DatabaseSync,
  currentRef: string | null,
  targetRef: string,
  uuid: string,
  purpose: SecretPurpose
): string | null {
  if (!currentRef) {
    return null;
  }

  const now = new Date().toISOString();
  if (currentRef === targetRef) {
    db.prepare("UPDATE secret_store SET uuid = ?, purpose = ?, updated_at = ? WHERE ref = ?").run(uuid, purpose, now, currentRef);
    return targetRef;
  }

  const targetExists = Boolean(db.prepare("SELECT ref FROM secret_store WHERE ref = ?").get(targetRef));
  if (!targetExists) {
    const result = db
      .prepare("UPDATE secret_store SET ref = ?, uuid = ?, purpose = ?, updated_at = ? WHERE ref = ?")
      .run(targetRef, uuid, purpose, now, currentRef);
    if (result.changes > 0) {
      return targetRef;
    }
  }

  const currentSecret = db
    .prepare("SELECT ciphertext, iv, auth_tag FROM secret_store WHERE ref = ?")
    .get(currentRef) as SecretPayloadRow | undefined;
  if (currentSecret) {
    db.prepare(
      `UPDATE secret_store SET
        ciphertext = ?,
        iv = ?,
        auth_tag = ?,
        uuid = ?,
        purpose = ?,
        updated_at = ?
      WHERE ref = ?`
    ).run(currentSecret.ciphertext, currentSecret.iv, currentSecret.auth_tag, uuid, purpose, now, targetRef);
    db.prepare("DELETE FROM secret_store WHERE ref = ?").run(currentRef);
    return targetRef;
  }

  db.prepare("UPDATE secret_store SET uuid = ?, purpose = ?, updated_at = ? WHERE ref = ?").run(uuid, purpose, now, targetRef);
  return targetRef;
}

interface SecretPayloadRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

/**
 * Determines whether a string looks like a JWT.
 *
 * @param value the string to check.
 * @returns true when it has three dot-separated segments and the first segment starts with eyJ.
 */
function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && Boolean(parts[0]?.startsWith("eyJ"));
}

/**
 * Normalizes a nullable string.
 *
 * @param value the nullable string.
 * @returns the trimmed string; returns null for an empty string.
 */
function normalizeOptionalString(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
