/** Repository module. */
import type { DatabaseSync } from "node:sqlite";

/** Contract for idempotency hit. */
export interface IdempotencyHit {
  bodyHash: string;
  responseJson: string;
  statusCode: number;
  createdAt: string;
}

/** Contract for save idempotency input. */
export interface SaveIdempotencyInput {
  adapterId: string;
  requestId: string;
  bodyHash: string;
  responseJson: string;
  statusCode: number;
}

/** Contract for idempotency store. */
export interface IdempotencyStore {
  lookup(adapterId: string, requestId: string): IdempotencyHit | null;
  save(input: SaveIdempotencyInput): void;
  purgeBefore(thresholdIso: string): number;
}

export interface CreateIdempotencyStoreOptions {
  /** Get active uuid. */
  getActiveUuid?: () => string | null;
}

interface IdempotencyRow {
  body_hash: string;
  response_json: string;
  status_code: number;
  created_at: string;
}

/** Creates create idempotency store. */
export function createIdempotencyStore(
  db: DatabaseSync,
  options: CreateIdempotencyStoreOptions = {}
): IdempotencyStore {
  return {
    lookup(adapterId, requestId) {
      const uuid = options.getActiveUuid?.() ?? null;
      if (!uuid) {
        return null;
      }

      const row = db
        .prepare(
          `
            SELECT body_hash, response_json, status_code, created_at
            FROM idempotency_keys
            WHERE uuid = ? AND adapter_id = ? AND request_id = ?
          `
        )
        .get(uuid, adapterId, requestId) as IdempotencyRow | undefined;

      return row ? toIdempotencyHit(row) : null;
    },

    save(input) {
      const uuid = requireActiveUuid(options);
      db.prepare(
        `
          INSERT INTO idempotency_keys (
            uuid,
            adapter_id,
            request_id,
            body_hash,
            response_json,
            status_code
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `
      ).run(uuid, input.adapterId, input.requestId, input.bodyHash, input.responseJson, input.statusCode);
    },

    purgeBefore(thresholdIso) {
      const uuid = requireActiveUuid(options);
      const result = db.prepare("DELETE FROM idempotency_keys WHERE uuid = ? AND created_at < ?").run(uuid, thresholdIso);
      return Number(result.changes);
    }
  };
}

/** Handles require active uuid. */
function requireActiveUuid(options: CreateIdempotencyStoreOptions): string {
  const uuid = options.getActiveUuid?.() ?? null;
  if (!uuid) {
    throw Object.assign(new Error("idempotency state requires an active cloud account"), { code: "unauthorized" as const });
  }

  return uuid;
}

/** Handles to idempotency hit. */
function toIdempotencyHit(row: IdempotencyRow): IdempotencyHit {
  return {
    bodyHash: row.body_hash,
    responseJson: row.response_json,
    statusCode: row.status_code,
    createdAt: row.created_at
  };
}
