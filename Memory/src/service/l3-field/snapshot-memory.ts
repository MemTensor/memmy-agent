import type { L3WorldModelFields } from "../../contracts/index.js";
import type { MemoryRow } from "../../types.js";

type SnapshotMemory = Pick<MemoryRow, "memoryLayer" | "properties">;

function l3FieldInfo(memory: SnapshotMemory): Record<string, unknown> | null {
  if (memory.memoryLayer !== "L3") return null;
  const field = memory.properties.internal_info.l3_field;
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : null;
}

/** Unit key of an L3 field cognition snapshot memory, or null for any other memory. */
export function l3FieldSnapshotUnitKey(memory: SnapshotMemory): string | null {
  const unitKey = l3FieldInfo(memory)?.unit_key;
  return typeof unitKey === "string" && unitKey ? unitKey : null;
}

export function isL3FieldSnapshotMemory(memory: SnapshotMemory): boolean {
  return l3FieldSnapshotUnitKey(memory) !== null;
}

/** The schema-2 fields a snapshot carries for pages that only understand the old L3 shape. */
export function l3FieldSnapshotLegacyFields(memory: SnapshotMemory): L3WorldModelFields | null {
  if (!l3FieldSnapshotUnitKey(memory)) return null;
  const legacy = l3FieldInfo(memory)?.legacy_fields;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return null;
  const value = (key: string): string | null => {
    const field = (legacy as Record<string, unknown>)[key];
    return typeof field === "string" ? field : null;
  };
  return {
    generalRulesAndSafetyConstraints: value("general_rules_and_safety_constraints"),
    projectEnvironmentProfile: value("project_environment_profile"),
    projectContract: value("project_contract"),
    domainKnowledge: value("domain_knowledge")
  };
}
