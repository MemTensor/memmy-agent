/** SQL projections for display reads. Algorithm/storage reads retain full rows. */
const infoFields = ["title", "summary", "source", "tags", "source_memory_ids"];
const internalFields = [
  "memory_layer",
  "memory_kind",
  "title",
  "summary",
  "source",
  "work_topic",
  "requirement",
  "value",
  "alpha",
  "reflection",
  "source_memory_ids",
  "source_l1_memory_ids",
  "source_trace_ids"
];
const nestedFields: Record<string, string[]> = {
  trace: ["title", "summary", "userText", "user_text", "value", "alpha", "reflection"],
  policy: ["title", "procedure", "source_trace_ids"],
  world_model: ["title", "summary", "body"],
  skill: ["title", "name", "invocation_guide", "invocationGuide"],
  span: ["span_goal"],
  external_evidence: ["source", "provenance"],
  external_evidence_candidate: ["source", "sourceRecordIds"]
};

function objectFields(column: string, path: string, fields: string[]): string {
  return fields.map((field) => `'${field}', json_extract(${column}, '${path}.${field}')`).join(", ");
}

// Body is retained for old title/summary/user-section and observed-activity
// fallbacks. It must not be truncated before those existing parsers run.
const columns = `id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
  memory_type, status, visibility, memory_key, memory_value, tags_json,
  memory_layer, content_hash, version, created_at, updated_at, deleted_at`;

export const PANEL_MEMORY_COLUMNS = `${columns},
  json_object(${objectFields("info_json", "$", infoFields)}) AS info_json,
  json_object('tags', json_extract(properties_json, '$.tags'), 'internal_info', json_object(
    ${objectFields("properties_json", "$.internal_info", internalFields)},
    'observation_memory', json_extract(properties_json, '$.internal_info.observation_memory'),
    ${Object.entries(nestedFields)
      .map(
        ([key, fields]) => `'${key}', json_object(${objectFields("properties_json", `$.internal_info.${key}`, fields)})`
      )
      .join(", ")}
  )) AS properties_json`;

// Legacy imports can still have inline vectors. Remove them inside SQLite,
// before parsing or returning display details; never load the vector store.
const vectorPaths = [
  "$",
  "$.internal_info",
  "$.internal_info.trace",
  "$.internal_info.policy",
  "$.internal_info.world_model",
  "$.internal_info.skill"
]
  .flatMap((path) => ["vec", "vec_summary", "vec_action", "embedding"].map((field) => `'${path}.${field}'`))
  .join(", ");
export const DISPLAY_MEMORY_COLUMNS = `${columns},
  json_remove(info_json, ${vectorPaths}) AS info_json,
  json_remove(properties_json, ${vectorPaths}) AS properties_json`;

export const DISPLAY_USER_MEMORY_COLUMNS = `id, source_turn_id, user_id, memory_types_json, content,
  normalized_user_text_hash, source_turn_refs_json, status, replaces_memory_id, replaced_by_memory_id,
  archived_at, archive_reason, NULL AS embedding_json, NULL AS embedding_model,
  NULL AS embedding_provider, created_at, updated_at, deleted_at`;
