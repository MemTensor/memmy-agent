import { sha256Hex } from "../contracts/memory-canonical-json.js";
import { isRecord } from "../utils/json.js";

/** Change notifications keep provenance, not another copy of the extraction input. */
export function compactHistoryChangePayload(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.properties)) return value;
  const internal = value.properties.internal_info;
  if (!isRecord(internal) || internal.memory_kind !== "observed_activity") return value;
  const origin = internal.external_evidence;
  if (!isRecord(origin)) return value;
  const provenance = isRecord(origin.provenance) ? origin.provenance : {};
  const historyId = origin.sourceRecordId;
  const legacyHistory = origin.source === "memmy" && value.agentId === "memmy"
    && typeof historyId === "string" && (provenance.historyId === historyId
      || /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?-(?:10min|6h)-summary$/u.test(historyId));
  if (origin.source !== "computer_history" && !legacyHistory) return value;

  const source = typeof origin.source_content === "string" ? origin.source_content : undefined;
  const state = isRecord(internal.observation_memory) ? internal.observation_memory : undefined;
  const body = typeof value.memoryValue === "string" ? value.memoryValue : "";
  // Source upsert temporarily combines new input with the prior extraction state.
  // A genuine processed body, including one equal to its source, stays intact.
  const replacedInput = body === source && typeof state?.source_revision === "string"
    && typeof origin.revision === "string" && state.source_revision !== origin.revision;
  const omitBody = Boolean(body) && (!state || state.status === "pending" || replacedInput);
  if (source === undefined && !omitBody) return value;

  const { source_content: _sourceContent, ...evidence } = origin;
  const projection = {
    ...(isRecord(internal.change_log_projection) ? internal.change_log_projection : {}),
    schema_version: 1,
    ...(source !== undefined ? { source_content_omitted: true,
      source_content_sha256: sha256Hex(source), source_content_bytes: Buffer.byteLength(source, "utf8") } : {}),
    ...(omitBody ? { memory_value_omitted: true,
      memory_value_sha256: sha256Hex(body), memory_value_bytes: Buffer.byteLength(body, "utf8") } : {})
  };
  return { ...value, ...(omitBody ? { memoryValue: "" } : {}),
    properties: { ...value.properties, internal_info: { ...internal,
      external_evidence: evidence, change_log_projection: projection } } };
}

/** Invalid or unrelated historical JSON remains byte-for-byte unchanged. */
export function compactHistoryChangeJson(value: unknown): unknown {
  if (typeof value !== "string") return compactHistoryChangePayload(value);
  try {
    const payload: unknown = JSON.parse(value);
    const compact = compactHistoryChangePayload(payload);
    return compact === payload ? value : JSON.stringify(compact);
  } catch {
    return value;
  }
}

export function compactHistoryChangeRow<T extends Record<string, unknown>>(row: T): T {
  const before = compactHistoryChangeJson(row.before_json);
  const after = compactHistoryChangeJson(row.after_json);
  return before === row.before_json && after === row.after_json
    ? row : { ...row, before_json: before, after_json: after };
}
