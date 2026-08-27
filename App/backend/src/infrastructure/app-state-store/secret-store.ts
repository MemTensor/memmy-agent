/** Secret store module. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const ALGORITHM = "aes-256-gcm";
const DEFAULT_KEY_MATERIAL = "Memmy local SecretStore v1";

export interface SecretStore {
  set(ref: string, secret: string, metadata?: SecretMetadata): void;
  get(ref: string): string | null;
  delete(ref: string): void;
}

/** Contract for secret metadata. */
export interface SecretMetadata {
  uuid?: string | null;
  purpose?: string | null;
}

/** Creates create sqlite secret store. */
export function createSqliteSecretStore(
  db: DatabaseSync,
  options: {
    keyMaterial?: string;
  } = {}
): SecretStore {
  const key = deriveKey(options.keyMaterial ?? process.env.MEMMY_SECRET_KEY ?? DEFAULT_KEY_MATERIAL);

  return {
    set(ref, secret, metadata = {}) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO secret_store (ref, ciphertext, iv, auth_tag, uuid, purpose, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           uuid = excluded.uuid,
           purpose = excluded.purpose,
           updated_at = excluded.updated_at`
      ).run(
        ref,
        ciphertext.toString("base64"),
        iv.toString("base64"),
        authTag.toString("base64"),
        metadata.uuid ?? null,
        metadata.purpose ?? null,
        now,
        now
      );
    },

    get(ref) {
      const row = db
        .prepare("SELECT ciphertext, iv, auth_tag FROM secret_store WHERE ref = ?")
        .get(ref) as SecretRow | undefined;
      if (!row) {
        return null;
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, "base64"));
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(row.ciphertext, "base64")),
          decipher.final()
        ]);
        return plaintext.toString("utf8");
      } catch {
        return null;
      }
    },

    delete(ref) {
      db.prepare("DELETE FROM secret_store WHERE ref = ?").run(ref);
    }
  };
}

interface SecretRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

/** Handles derive key. */
function deriveKey(keyMaterial: string): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}
