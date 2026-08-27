/** Account context module. */
import type { DatabaseSync } from "node:sqlite";

export const LOCAL_BYOK_ACCOUNT_UUID = "local-byok-onboarding";

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

/** Validates ensure account defaults. */
export function ensureAccountDefaults(
  db: DatabaseSync,
  uuid: string
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
    `INSERT OR IGNORE INTO account_token_usage_cache (
       uuid,
       total_tokens,
       used_tokens,
       remaining_tokens,
       scene_usages_json,
       created_at,
       updated_at
     ) VALUES (?, 0, 0, 0, '[]', ?, ?)`
  ).run(uuid, now, now);

}
