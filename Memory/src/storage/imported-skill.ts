import { dirname } from "node:path";
import type { MemoryRow } from "../types.js";

/**
 * Skills imported from other Agents' skill directories are read-only Skill
 * records. These helpers read the import-specific fields kept in
 * `properties.internal_info`.
 */

/** Records written by the source reconcile carry this version in `import_state_version`. */
export const IMPORTED_SKILL_STATE_VERSION = 1;

/**
 * Records whose summary and retrieval text come from the frontmatter
 * description carry this version in `retrieval_representation_version`.
 */
export const IMPORTED_SKILL_RETRIEVAL_VERSION = 1;

/**
 * Why an imported skill is archived. The user's own decisions ("user") survive
 * new versions of the file; the others follow the latest scan.
 * - superseded: a newer version of the same skill file is current.
 * - source_missing: the file is gone from a complete scan.
 * - invocation_policy: the source Agent marks the skill as user-invoked only.
 * - disconnected: the user disconnected the source Agent from Memmy.
 * - registration: a skill shipped in an enabled Agent plugin; it is only
 *   recorded so recall knows that Agent already has it.
 */
export type ImportedSkillArchiveReason =
  | "user"
  | "superseded"
  | "source_missing"
  | "invocation_policy"
  | "disconnected"
  | "registration";

const ARCHIVE_REASONS: ReadonlySet<string> = new Set([
  "user",
  "superseded",
  "source_missing",
  "invocation_policy",
  "disconnected",
  "registration"
]);

/** Reasons whose records keep only their identity, never the skill body. */
const IDENTITY_ONLY_REASONS: ReadonlySet<ImportedSkillArchiveReason> = new Set([
  "invocation_policy",
  "disconnected",
  "registration"
]);

export function isImportedSkill(memory: MemoryRow): boolean {
  return memory.memoryLayer === "Skill" && memory.properties.internal_info.read_only === true;
}

export function importedSkillArchiveReason(memory: MemoryRow): ImportedSkillArchiveReason | undefined {
  const reason = memory.properties.internal_info.archive_reason;
  return typeof reason === "string" && ARCHIVE_REASONS.has(reason) ? reason as ImportedSkillArchiveReason : undefined;
}

export function isIdentityOnlyReason(reason: ImportedSkillArchiveReason | undefined): boolean {
  return reason !== undefined && IDENTITY_ONLY_REASONS.has(reason);
}

/** An imported skill kept only as an identity record (no body, no index, no vector). */
export function isIdentityOnlyImportedSkill(memory: MemoryRow): boolean {
  return isImportedSkill(memory) && isIdentityOnlyReason(importedSkillArchiveReason(memory));
}

/**
 * Whether an embedding of this record may be computed. Only imported skills
 * are restricted; every other record keeps its existing behaviour.
 */
export function importedSkillMayEmbed(memory: MemoryRow): boolean {
  if (!isImportedSkill(memory)) return true;
  if (memory.deletedAt || memory.status === "deleted" || memory.status === "archived") return false;
  return memory.memoryValue.trim().length > 0;
}

/** Name used to group skills that share a name across Agents. */
export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The frontmatter description of an imported skill, when the skill has one. */
export function importedSkillDescription(memory: MemoryRow): string | undefined {
  const description = memory.properties.internal_info.skill_description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}

/**
 * The source skill directory, shown only when it holds files besides SKILL.md
 * that an Agent on the same machine may want to open.
 */
export function importedSkillSourceDir(memory: MemoryRow): string | undefined {
  const internal = memory.properties.internal_info;
  if (internal.has_supporting_files !== true || typeof internal.source_skill_path !== "string") return undefined;
  return dirname(internal.source_skill_path);
}
