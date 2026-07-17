import type {
  ByokTokenUsageByKind,
  ByokTokenUsageEvent,
  ByokTokenUsageKind,
  ByokTokenUsageSummary
} from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";

const KIND_ORDER: ByokTokenUsageKind[] = ["agent_chat", "memory_summary", "memory_evolution", "embedding"];

interface SummaryRow {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  updated_at: string | null;
}

interface ByKindRow extends SummaryRow {
  kind: ByokTokenUsageKind;
  event_count: number | null;
}

export interface ByokTokenUsageRepository {
  recordEvent(event: ByokTokenUsageEvent): void;
  getSummary(): ByokTokenUsageSummary;
}

export function createByokTokenUsageRepository(db: DatabaseSync): ByokTokenUsageRepository {
  return {
    recordEvent(event) {
      db.prepare(
        `INSERT INTO byok_token_usage_events (
          id,
          kind,
          source,
          operation_id,
          dedupe_key,
          input_tokens,
          output_tokens,
          total_tokens,
          cached_input_tokens,
          cache_creation_input_tokens,
          metadata_json,
          usage_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          id = excluded.id,
          kind = excluded.kind,
          source = excluded.source,
          operation_id = excluded.operation_id,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          total_tokens = excluded.total_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          metadata_json = excluded.metadata_json,
          usage_json = excluded.usage_json,
          created_at = excluded.created_at`
      ).run(
        event.id,
        event.kind,
        event.source,
        event.operationId,
        dedupeKeyForEvent(event),
        event.inputTokens,
        event.outputTokens,
        event.totalTokens,
        event.cachedInputTokens,
        event.cacheCreationInputTokens,
        JSON.stringify(event.metadata),
        JSON.stringify(event.rawUsage),
        event.createdAt
      );
    },

    getSummary() {
      const total = db
        .prepare(
          `SELECT
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            MAX(created_at) AS updated_at
          FROM byok_token_usage_events`
        )
        .get() as unknown as SummaryRow;

      const rows = db
        .prepare(
          `SELECT
            kind,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COUNT(*) AS event_count,
            MAX(created_at) AS updated_at
          FROM byok_token_usage_events
          GROUP BY kind`
        )
        .all() as unknown as ByKindRow[];

      return {
        inputTokens: numberValue(total.input_tokens),
        outputTokens: numberValue(total.output_tokens),
        totalTokens: numberValue(total.total_tokens),
        cachedInputTokens: numberValue(total.cached_input_tokens),
        cacheCreationInputTokens: numberValue(total.cache_creation_input_tokens),
        updatedAt: total.updated_at,
        byKind: rows.sort(byKindOrder).map(toByKind),
      };
    },
  };
}

function dedupeKeyForEvent(event: ByokTokenUsageEvent): string {
  return `${event.kind}:${event.source}:${event.operationId}`;
}

function toByKind(row: ByKindRow): ByokTokenUsageByKind {
  return {
    kind: row.kind,
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    totalTokens: numberValue(row.total_tokens),
    cachedInputTokens: numberValue(row.cached_input_tokens),
    cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens),
    eventCount: numberValue(row.event_count),
    updatedAt: row.updated_at,
  };
}

function byKindOrder(left: ByKindRow, right: ByKindRow): number {
  return KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
}

function numberValue(value: number | null): number {
  return Number(value ?? 0);
}
