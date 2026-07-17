/** Account context module. */
import type { DatabaseSync } from "node:sqlite";

export const LOCAL_BYOK_ACCOUNT_UUID = "local-byok-onboarding";

export interface EnsureAccountDefaultsOptions {
  /** Copy legacy model config. */
  copyLegacyModelConfig?: boolean;
}

/** Reads get active account uuid. */
export function getActiveAccountUuid(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as
      | { active_uuid: string | null }
      | undefined;
    return row?.active_uuid ?? null;
  } catch {
    return null;
  }
}

/** Writes set active account uuid. */
export function setActiveAccountUuid(db: DatabaseSync, uuid: string | null): void {
  db.prepare("UPDATE app_settings SET active_uuid = ?, updated_at = ? WHERE id = 'default'").run(
    uuid,
    new Date().toISOString()
  );
}

/** Validates ensure local byok account. */
export function ensureLocalByokAccount(db: DatabaseSync): string {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO cloud_accounts (
      uuid,
      created_at,
      updated_at
    ) VALUES (?, ?, ?)`
  ).run(LOCAL_BYOK_ACCOUNT_UUID, now, now);
  return LOCAL_BYOK_ACCOUNT_UUID;
}

/** Validates ensure local byok model config defaults. */
export function ensureLocalByokModelConfigDefaults(db: DatabaseSync): string {
  const uuid = ensureLocalByokAccount(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO account_model_config (
      uuid,
      provider,
      base_url,
      model_id,
      embedding_mode,
      created_at,
      updated_at
    ) VALUES (
      ?,
      'openai_compatible',
      'https://api.openai.com/v1',
      '',
      'local',
      ?,
      ?
    )`
  ).run(uuid, now, now);
  return uuid;
}

/** Validates ensure account defaults. */
export function ensureAccountDefaults(
  db: DatabaseSync,
  uuid: string,
  options: EnsureAccountDefaultsOptions = {}
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO account_onboarding_state (uuid, created_at, updated_at)
     VALUES (?, ?, ?)`
  ).run(uuid, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO account_privacy_settings (uuid, created_at, updated_at)
     VALUES (?, ?, ?)`
  ).run(uuid, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO account_token_usage_cache (uuid, created_at, updated_at)
     VALUES (?, ?, ?)`
  ).run(uuid, now, now);

  if (options.copyLegacyModelConfig) {
    copyLegacyModelConfig(db, uuid);
    return;
  }

  db.prepare(
    `INSERT OR IGNORE INTO account_model_config (
      uuid,
      provider,
      base_url,
      model_id,
      embedding_mode,
      created_at,
      updated_at
    ) VALUES (
      ?,
      'openai_compatible',
      'https://api.openai.com/v1',
      'gpt-4.1-mini',
      'local',
      ?,
      ?
    )`
  ).run(uuid, now, now);
}

/** Handles copy legacy model config. */
function copyLegacyModelConfig(db: DatabaseSync, uuid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO account_model_config (
      uuid,
      provider,
      base_url,
      model_id,
      api_key_ref,
      CASE embedding_mode
        WHEN 'separate' THEN 'custom'
        ELSE 'local'
      END,
      embedding_base_url,
      embedding_model_id,
      embedding_api_key_ref,
      created_at,
      updated_at
    )
    SELECT
      ?,
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
  ).run(uuid);
}
