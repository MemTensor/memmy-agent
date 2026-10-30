import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import type { NewL2Lesson } from "./l2-extraction-contract.js";

/** Row versions also change on statistics updates; this version tracks semantic content only. */
export function l2ContentRevision(memory: MemoryRow): number {
  const policy = memory.properties.internal_info.policy;
  const value = isRecord(policy) ? policy.content_revision : undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

export function l2SupportRelation(memory: MemoryRow): string {
  const revision = l2ContentRevision(memory);
  return revision === 1 ? "supports" : `supports:r${revision}`;
}

export function renderL2Lesson(lesson: NewL2Lesson): string {
  return [`# ${lesson.title}`, `Applicability: ${lesson.applicability}`, `Content: ${lesson.content}`,
    `Verification: ${lesson.verification}`, `Exclusions: ${lesson.exclusions}`].join("\n\n");
}

/** Pure construction. Callers must snapshot old content and CAS before persisting. */
export function revisedL2Memory(memory: MemoryRow, lesson: NewL2Lesson, sourceIds: string[], episodeIds: string[], at: string): MemoryRow {
  const internal = memory.properties.internal_info;
  const old = isRecord(internal.policy) ? internal.policy : {};
  const fields = {
    schema_version: 2, content_revision: l2ContentRevision(memory) + 1, lesson_type: lesson.type,
    status: "candidate", support: new Set(episodeIds).size, gain: 0, raw_gain: 0,
    source_memory_ids: sourceIds, source_l1_memory_ids: sourceIds, source_trace_ids: sourceIds,
    source_episode_ids: [...new Set(episodeIds)], source_feedback_ids: [], source_repair_ids: [],
    successful_source_trace_ids: [], special_source_trace_ids: sourceIds,
    successful_episode_count: 0, evidence_event_count: sourceIds.length,
    pending_conflict_count: 0, gain_status: "not_computed", skill_eligible: false,
    experience_type: "repair_instruction", evidence_polarity: "neutral",
    signature: "_|_|_|_", source_routes: [], source_basis: [], last_verified_at: null, revalidate_after: null,
    generation_method: "model", extraction_status: "complete", rule_fallback: false,
    // Revision evidence justifies the text; it is not proof of successful execution.
    policy_confidence: 0.5, confidence: 0.5,
    decision_guidance: { preference: [], anti_pattern: [] }, expected_outcome: "", exclusions: [],
    title: lesson.title, trigger: lesson.applicability, procedure: lesson.content,
    verification: lesson.verification, boundary: lesson.exclusions
  };
  return { ...memory, status: "resolving", memoryValue: renderL2Lesson(lesson), updatedAt: at,
    tags: [...memory.tags.filter((tag) => !["principle", "local_procedure", "check", "troubleshooting"].includes(tag)), lesson.type],
    info: { ...memory.info, ...fields },
    properties: { ...memory.properties, status: "resolving", info: { ...memory.properties.info, ...fields },
      internal_info: { ...internal, ...fields, policy: { ...old, ...fields } } } };
}
