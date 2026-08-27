import type {
  ByokTokenUsageByKind,
  ByokTokenUsageByModel,
  ByokTokenUsageByProvider,
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

interface ByProviderKindRow extends ByKindRow {
  provider: string;
}

interface ByModelRow extends SummaryRow {
  preset_id: string | null;
  provider: string | null;
  model: string | null;
  capability: ByokTokenUsageByModel["capability"];
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
          preset_id,
          provider,
          model,
          capability,
          input_tokens,
          output_tokens,
          total_tokens,
          cached_input_tokens,
          cache_creation_input_tokens,
          metadata_json,
          usage_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          id = excluded.id,
          kind = excluded.kind,
          source = excluded.source,
          operation_id = excluded.operation_id,
          preset_id = excluded.preset_id,
          provider = excluded.provider,
          model = excluded.model,
          capability = excluded.capability,
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
        event.presetId ?? null,
        event.provider ?? null,
        event.model ?? null,
        event.capability ?? null,
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
      const providerRows = db
        .prepare(
          `SELECT
            provider,
            kind,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COUNT(*) AS event_count,
            MAX(created_at) AS updated_at
          FROM byok_token_usage_events
          WHERE provider IS NOT NULL
          GROUP BY provider, kind`
        )
        .all() as unknown as ByProviderKindRow[];
      const modelRows = db
        .prepare(
          `SELECT
            preset_id,
            provider,
            model,
            capability,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COUNT(*) AS event_count,
            MAX(created_at) AS updated_at
          FROM byok_token_usage_events
          GROUP BY preset_id, provider, model, capability`
        )
        .all() as unknown as ByModelRow[];

      return {
        inputTokens: numberValue(total.input_tokens),
        outputTokens: numberValue(total.output_tokens),
        totalTokens: numberValue(total.total_tokens),
        cachedInputTokens: numberValue(total.cached_input_tokens),
        cacheCreationInputTokens: numberValue(total.cache_creation_input_tokens),
        updatedAt: total.updated_at,
        byKind: rows.sort(byKindOrder).map(toByKind),
        byProvider: toByProvider(providerRows),
        byModel: modelRows.map(toByModel).sort(byModelOrder),
      };
    },
  };
}

function toByModel(row: ByModelRow): ByokTokenUsageByModel {
  return {
    presetId: row.preset_id,
    provider: row.provider,
    model: row.model,
    capability: row.capability,
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    totalTokens: numberValue(row.total_tokens),
    cachedInputTokens: numberValue(row.cached_input_tokens),
    cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens),
    eventCount: numberValue(row.event_count),
    updatedAt: row.updated_at,
  };
}

function byModelOrder(left: ByokTokenUsageByModel, right: ByokTokenUsageByModel): number {
  return right.totalTokens - left.totalTokens
    || (left.provider ?? "").localeCompare(right.provider ?? "")
    || (left.model ?? "").localeCompare(right.model ?? "")
    || (left.capability ?? "").localeCompare(right.capability ?? "")
    || (left.presetId ?? "").localeCompare(right.presetId ?? "");
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

function toByProvider(rows: ByProviderKindRow[]): ByokTokenUsageByProvider[] {
  const grouped = new Map<string, ByProviderKindRow[]>();
  for (const row of rows) {
    if (typeof row.provider !== "string" || !row.provider.trim()) continue;
    const current = grouped.get(row.provider) ?? [];
    current.push(row);
    grouped.set(row.provider, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, providerRows]) => ({
      provider,
      inputTokens: sumRows(providerRows, "input_tokens"),
      outputTokens: sumRows(providerRows, "output_tokens"),
      totalTokens: sumRows(providerRows, "total_tokens"),
      cachedInputTokens: sumRows(providerRows, "cached_input_tokens"),
      cacheCreationInputTokens: sumRows(providerRows, "cache_creation_input_tokens"),
      eventCount: sumRows(providerRows, "event_count"),
      updatedAt: providerRows
        .map((row) => row.updated_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
      byKind: providerRows.sort(byKindOrder).map(toByKind),
    }));
}

function sumRows(
  rows: readonly ByProviderKindRow[],
  field: "input_tokens" | "output_tokens" | "total_tokens" | "cached_input_tokens" | "cache_creation_input_tokens" | "event_count"
): number {
  return rows.reduce((total, row) => total + numberValue(row[field]), 0);
}

function numberValue(value: number | null): number {
  return Number(value ?? 0);
}
