/** Shared source projection: keep panel filters and cached statistics identical. */
export function memoryDisplayedSourceSql(fallback: string): string {
  const candidate = "$.internal_info.external_evidence_candidate";
  // SQLite GLOB is case-sensitive and anchored unless a wildcard is present,
  // matching the canonical History ID shape used by the legacy source helper.
  const historyPrefix = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
  const historyId = ["10min", "6h"].flatMap((window) => ["", "Z"].map((zone) => `history_source.value GLOB '${historyPrefix}${zone}-${window}-summary'`)).join(" OR ");
  return `CASE
  WHEN (json_extract(properties_json, '$.internal_info.memory_kind') = 'observed_activity'
   AND (json_extract(properties_json, '$.internal_info.external_evidence.source') = 'computer_history'
    OR json_type(properties_json, '$.internal_info.external_evidence.provenance.historyId') = 'text'))
   OR (memory_layer = 'Skill' AND (
    json_extract(properties_json, '${candidate}.source') = 'computer_history'
    OR (agent_id = 'memmy' AND json_extract(properties_json, '${candidate}.source') = 'memmy'
     AND json_type(properties_json, '${candidate}.sourceRecordIds') = 'array'
     AND (SELECT COUNT(DISTINCT value) FROM json_each(properties_json, '${candidate}.sourceRecordIds')) >= 2
     AND NOT EXISTS (SELECT 1 FROM json_each(properties_json, '${candidate}.sourceRecordIds') AS history_source
      WHERE history_source.type <> 'text' OR NOT (${historyId})))
   ))
  THEN 'computer_history' ELSE ${fallback} END`;
}
