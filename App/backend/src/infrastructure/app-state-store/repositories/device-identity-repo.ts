import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface InstallationIdRow {
  installation_id: string | null;
}

export interface DeviceIdentityRepository {
  getOrCreateInstallationId(): string;
}

export function createDeviceIdentityRepository(db: DatabaseSync): DeviceIdentityRepository {
  return {
    getOrCreateInstallationId() {
      const current = readInstallationId(db);
      const normalizedCurrent = normalizeInstallationId(current);
      if (isUuid(normalizedCurrent)) {
        return normalizedCurrent;
      }

      const generated = randomUUID();
      db.prepare(
        `UPDATE app_settings
         SET installation_id = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 'default'
           AND installation_id IS ?`
      ).run(generated, current);

      const stored = normalizeInstallationId(readInstallationId(db));
      if (!isUuid(stored)) {
        throw new Error("Unable to persist installation ID");
      }
      return stored;
    }
  };
}

function readInstallationId(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT installation_id FROM app_settings WHERE id = 'default'")
    .get() as InstallationIdRow | undefined;
  return row?.installation_id ?? null;
}

function normalizeInstallationId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function isUuid(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value);
}
