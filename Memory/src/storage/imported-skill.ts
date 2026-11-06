import { createHash } from "node:crypto";
import { frontmatterBoolean, parseSkillFrontmatter } from "@memmy/agent-source-core";
import { dirname } from "node:path";
import type { MemoryRow } from "../types.js";
import { sanitizeMemmyProtocolText } from "../utils/memmy-context-tags.js";
import { stableHash } from "../utils/id.js";
import { normalizeAgentIdKey } from "../utils/agent-source-id.js";

/**
 * Skills imported from other Agents' skill directories are read-only Skill
 * records. Source installation identity is stored separately from their
 * lifecycle metadata in `properties.internal_info`.
 */

/** Records written by the source reconcile carry this version in `import_state_version`. */
export const IMPORTED_SKILL_STATE_VERSION = 2;

export interface AgentSkillInstallation {
  sourceSkillId: string;
  normalizedName: string;
}

/** Source inventory contains identities only, independently of memory deletion. */
export interface AgentSkillInstallations {
  version: 1;
  skills: AgentSkillInstallation[];
  registrations: AgentSkillInstallation[];
}

export function agentSkillInstallationsKey(sourceAgentId: string): string {
  return `agent-skill-installations:${normalizeAgentIdKey(sourceAgentId)}`;
}

export type AgentSkillConnectionState = "connected" | "disconnected";

export function agentSkillConnectionKey(sourceAgentId: string): string {
  return `agent-skill-connection:${normalizeAgentIdKey(sourceAgentId)}`;
}

/**
 * v4 keeps frontmatter descriptions for summaries while restoring full-body
 * canonical retrieval after the description-only real-query gate regressed.
 * Advancing the version repairs persisted v1-v3 indices through startup.
 */
export const IMPORTED_SKILL_RETRIEVAL_VERSION = 4;

/**
 * Why an imported skill is archived. The user's own decisions ("user") survive
 * new versions of the file; the others follow the latest scan.
 * - superseded: a newer version of the same skill file is current.
 * - source_missing: the file is gone from a complete scan.
 * - invocation_policy: the source Agent marks the skill as user-invoked only.
 * - disconnected: the user disconnected the source Agent from Memmy.
 * - scan_pending: sharing is permitted again, but a scan must reload the stripped body.
 * - source_review_pending: legacy collision repaired; retain historical bytes while
 *   a scan determines source presence. Archived and ineligible for recall/embedding.
 * - registration: a skill shipped in an enabled Agent plugin; it is only
 *   recorded so recall knows that Agent already has it.
 */
export type ImportedSkillArchiveReason =
  | "user"
  | "superseded"
  | "source_missing"
  | "invocation_policy"
  | "policy_unknown"
  | "scan_pending"
  | "source_review_pending"
  | "disconnected"
  | "registration";

const ARCHIVE_REASONS: ReadonlySet<string> = new Set([
  "user",
  "superseded",
  "source_missing",
  "invocation_policy",
  "policy_unknown",
  "scan_pending",
  "source_review_pending",
  "disconnected",
  "registration"
]);

/** Reasons whose records keep only their identity, never the skill body. */
const IDENTITY_ONLY_REASONS: ReadonlySet<ImportedSkillArchiveReason> = new Set([
  "invocation_policy",
  "policy_unknown",
  "scan_pending",
  "disconnected",
  "registration"
]);

export function isImportedSkill(memory: Pick<MemoryRow, "memoryLayer" | "properties" | "tags" | "memoryKey">): boolean {
  return memory.memoryLayer === "Skill" && memory.properties.internal_info.read_only === true
    && hasImportedSkillSourceEvidence(memory);
}

/** Old generic Skill writes inferred an Agent id without observing a file. */
export function hasImportedSkillSourceEvidence(memory: Pick<MemoryRow, "properties" | "tags" | "memoryKey">): boolean {
  const internal = memory.properties.internal_info;
  if (internal.source_kind === "manual") return false;
  const id = typeof internal.source_skill_id === "string" ? internal.source_skill_id.trim() : "";
  const turn = typeof internal.turn_id === "string" ? internal.turn_id.trim() : "";
  return internal.source_kind === "file" || internal.source_kind === "plugin"
    || Boolean(typeof internal.source_skill_path === "string" && internal.source_skill_path.trim())
    || Boolean(id && (id !== turn || /^skill:\S/.test(id)))
    || /^skill:\S/.test(turn)
    || memory.tags.some(tag => tag.trim().toLowerCase() === "agent-source")
    || [memory.memoryKey, internal.source_skill_key].some(key => typeof key === "string" && key.startsWith("memory.add:agent-source:"));
}

export function importedSkillArchiveReason(memory: Pick<MemoryRow, "properties">): ImportedSkillArchiveReason | undefined {
  const reason = memory.properties.internal_info.archive_reason;
  return typeof reason === "string" && ARCHIVE_REASONS.has(reason) ? reason as ImportedSkillArchiveReason : undefined;
}

export function isIdentityOnlyReason(reason: ImportedSkillArchiveReason | undefined): boolean {
  return reason !== undefined && IDENTITY_ONLY_REASONS.has(reason);
}

/** An imported skill kept only as an identity record (no body, no index, no vector). */
export function isIdentityOnlyImportedSkill(memory: ImportedSkillEligibilityMemory): boolean {
  if (!isImportedSkill(memory)) return false;
  if (!memory.memoryValue.trim()) return true;
  if (memory.properties.internal_info.source_kind === "plugin") return true;
  const sourceState = memory.properties.internal_info.source_state;
  return isIdentityOnlyReason(importedSkillArchiveReason(memory))
    || sourceState === "disconnected" || sourceState === "invocation_policy" || sourceState === "policy_unknown";
}

/** Full raw UTF-8 bytes, shared by direct imports, source observations and tombstones. */
export function importedSkillContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Verifies stored bytes against a recorded raw source fact. */
export function importedSkillBodyMatchesSource(memory: MemoryRow): boolean {
  const internal = memory.properties.internal_info;
  const sourceHash = internal.source_raw_content_hash ?? internal.source_content_hash;
  return sourceHash === importedSkillContentHash(memory.memoryValue);
}

/** Retains the verifiable source fact before a policy or deletion removes the body. */
export function withImportedSkillRawHash(memory: MemoryRow): MemoryRow {
  const internal = memory.properties.internal_info;
  if (typeof internal.source_raw_content_hash === "string") return memory;
  // Old memory.add normalized its body while keeping a caller's original
  // source hash. Only agreement with that declared raw digest proves these
  // stored bytes are the original file. An already stripped body proves none.
  if (!memory.memoryValue || internal.source_content_hash !== importedSkillContentHash(memory.memoryValue)) return memory;
  return { ...memory, properties: { ...memory.properties, internal_info: {
    ...internal, source_raw_content_hash: importedSkillContentHash(memory.memoryValue)
  } } };
}

/** Content identity is independent of legacy keys and caller-supplied hash tokens. */
export function importedSkillMatchesContent(memory: MemoryRow, content: string, declaredHash: string): boolean {
  const internal = memory.properties.internal_info;
  const rawHash = importedSkillContentHash(content);
  if (typeof internal.source_raw_content_hash === "string") return internal.source_raw_content_hash === rawHash;
  if (memory.memoryValue) {
    if (importedSkillContentHash(memory.memoryValue) === rawHash) return true;
    return sanitizeMemmyProtocolText(content) === memory.memoryValue
      && (internal.source_content_hash === rawHash || internal.source_content_hash === stableHash(memory.memoryValue));
  }
  // Old stripped rows have lost their raw bytes. Preserve their tombstone on
  // the original explicit token or a recognized old normalized digest. Long
  // truncated digests cannot distinguish suffixes, so they stay conservative.
  return internal.source_content_hash === declaredHash || internal.source_content_hash === stableHash(content)
    || internal.source_content_hash === stableHash(sanitizeMemmyProtocolText(content));
}

/** The original guide lives in memoryValue. Readers already fall back to it. */
export function withoutImportedSkillBodyCopies(memory: MemoryRow): MemoryRow {
  const internal = { ...memory.properties.internal_info };
  const skill = internal.skill && typeof internal.skill === "object" && !Array.isArray(internal.skill)
    ? { ...internal.skill as Record<string, unknown> } : {};
  const compactProcedure = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const procedure = { ...value as Record<string, unknown> };
    delete procedure.summary;
    return procedure;
  };
  delete internal.invocation_guide;
  delete internal.invocationGuide;
  delete skill.invocation_guide;
  delete skill.invocationGuide;
  internal.procedure_json = compactProcedure(internal.procedure_json);
  skill.procedure_json = compactProcedure(skill.procedure_json);
  internal.skill = skill;
  return { ...memory, properties: { ...memory.properties, internal_info: internal } };
}

export function importedSkillName(memory: MemoryRow): string {
  const internal = memory.properties.internal_info;
  const name = [internal.normalized_name, internal.name, memory.info.title]
    .find(value => typeof value === "string" && value.trim());
  return typeof name === "string" ? normalizeSkillName(name) : "";
}

export function importedSkillSourceIdentity(memory: MemoryRow): string {
  const internal = memory.properties.internal_info;
  return String(internal.source_skill_id || internal.source_skill_path || internal.source_skill_key || memory.id);
}

/** Current lifecycle state wins over creation order when a file rolls back. */
export function currentImportedSkillVersion(versions: readonly MemoryRow[]): MemoryRow | undefined {
  const deleted = (memory: MemoryRow) => Boolean(memory.deletedAt) || memory.status === "deleted";
  const active = (memory: MemoryRow) => memory.status === "activated" || memory.status === "resolving";
  const candidates = versions.filter(version => {
    if (isUnverifiedLegacySkillCollision(version)) return false;
    const internal = version.properties.internal_info;
    const rolledBack = hasStaleImportedSkillSupersession(version, versions);
    if (!rolledBack && importedSkillArchiveReason(version) === "superseded") return false;
    if (!rolledBack && !active(version) && typeof internal.superseded_by_skill_id === "string") return false;
    return !(deleted(version) && internal.deleted_current === false);
  });
  const compareRecency = (left: MemoryRow, right: MemoryRow) => currentVersionTime(right).localeCompare(currentVersionTime(left))
    || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
  const liveCandidates = candidates.filter(version => !deleted(version));
  let live = liveCandidates.sort((left, right) => Number(active(right)) - Number(active(left)) || compareRecency(left, right))[0];
  // Old memory.add rollbacks refreshed imported_at but kept the old successor
  // and left that successor active. A later user archive does not undo rollback.
  const rollback = liveCandidates.filter(version => hasStaleImportedSkillSupersession(version, versions)).sort(compareRecency)[0];
  if (rollback && (!live || compareRecency(rollback, live) < 0)) live = rollback;
  const tombstone = candidates.filter(version => deleted(version)
    && (!live || version.properties.internal_info.deleted_current === true
      || hasStaleImportedSkillSupersession(version, versions))).sort(compareRecency)[0];
  if (!live) return tombstone;
  if (tombstone && compareRecency(tombstone, live) < 0) return tombstone;
  return live;
}

export function isHistoricalImportedSkill(memory: MemoryRow, versions: readonly MemoryRow[]): boolean {
  const internal = memory.properties.internal_info;
  const rolledBack = hasStaleImportedSkillSupersession(memory, versions);
  if (!rolledBack && importedSkillArchiveReason(memory) === "superseded") return true;
  if (!rolledBack && memory.status !== "activated" && memory.status !== "resolving"
    && typeof internal.superseded_by_skill_id === "string") return true;
  const current = currentImportedSkillVersion(versions);
  return current !== undefined && current.id !== memory.id;
}

/** A later source import proves that an old writer's successor is stale. */
export function hasStaleImportedSkillSupersession(memory: MemoryRow, versions: readonly MemoryRow[]): boolean {
  const internal = memory.properties.internal_info;
  if (Number(internal.import_state_version ?? 0) >= IMPORTED_SKILL_STATE_VERSION) return false;
  const skill = internal.skill;
  // Library rollbacks deliberately preserve a version's first imported_at.
  // Their archived nested lifecycle agrees with the explicit historical reason.
  // The old direct writer instead reset nested status to active while retaining
  // the previous successor/reason, even after a repository archive or delete.
  if (importedSkillArchiveReason(memory) === "superseded" && skill && typeof skill === "object"
    && !Array.isArray(skill) && (skill as Record<string, unknown>).status === "archived") return false;
  const target = versions.find(version => version.id === internal.superseded_by_skill_id);
  if (!target || importedSkillSourceIdentity(target) !== importedSkillSourceIdentity(memory)
    || normalizeAgentIdKey(String(target.properties.internal_info.source_agent_id ?? ""))
      !== normalizeAgentIdKey(String(internal.source_agent_id ?? ""))) return false;
  const importedAt = internal.imported_at;
  const targetImportedAt = target.properties.internal_info.imported_at;
  // Embedding and deletion maintenance also update updatedAt. They do not
  // establish a source rollback and must never invalidate a historical edge.
  return typeof importedAt === "string" && typeof targetImportedAt === "string"
    && Number.isFinite(Date.parse(importedAt)) && Number.isFinite(Date.parse(targetImportedAt))
    && Date.parse(importedAt) > Date.parse(targetImportedAt);
}

function currentVersionTime(memory: MemoryRow): string {
  const importedAt = memory.properties.internal_info.imported_at;
  return typeof importedAt === "string" ? importedAt : memory.updatedAt;
}

/**
 * Whether an embedding of this record may be computed. Only imported skills
 * are restricted; every other record keeps its existing behaviour.
 */
export type ImportedSkillSourceState = "present" | "source_missing" | "disconnected"
  | "invocation_policy" | "policy_unknown" | "scan_pending" | "source_review_pending";

/** The same evidence is available to row consumers and SQL candidate queries. */
export type ImportedSkillEligibilityMemory = Pick<MemoryRow,
  "memoryLayer" | "memoryKey" | "memoryValue" | "properties" | "tags" | "status" | "deletedAt">;

/**
 * The old writer inherited a file path into an ordinary turn-id Skill. Its
 * stored request is indistinguishable from an explicit same-id source write.
 * Quarantine that narrow shape; never relabel it as a manual or verified file.
 */
export function isUnverifiedLegacySkillCollision(memory: ImportedSkillEligibilityMemory): boolean {
  if (!isImportedSkill(memory)) return false;
  const internal = memory.properties.internal_info;
  if (internal.source_review_required === true) return true;
  const id = typeof internal.source_skill_id === "string" ? internal.source_skill_id.trim() : "";
  const turn = typeof internal.turn_id === "string" ? internal.turn_id.trim() : "";
  return internal.source_kind === "skill" && Boolean(id && id === turn && !/^skill:/.test(turn))
    && Boolean(typeof internal.source_skill_path === "string" && internal.source_skill_path.trim())
    && memory.tags.some(tag => tag.trim().toLowerCase() === "manual")
    && !memory.tags.some(tag => tag.trim().toLowerCase() === "agent-source")
    && ![memory.memoryKey, internal.source_skill_key].some(key => typeof key === "string" && key.startsWith("memory.add:agent-source:"));
}

/**
 * Source facts, independent of a user's archive. Never infer a policy observation
 * from a migration version: old writers can carry modern stamps and stale flags.
 * The raw body remains authoritative for its own frontmatter until it is stripped.
 */
export function importedSkillSourceState(memory: ImportedSkillEligibilityMemory): ImportedSkillSourceState {
  const internal = memory.properties.internal_info;
  const state = internal.source_state;
  const reason = importedSkillArchiveReason(memory);
  if (state === "source_missing" || reason === "source_missing") return "source_missing";
  if (state === "disconnected" || reason === "disconnected") return "disconnected";
  const invocation = internal.invocation;
  const policy = typeof invocation === "object" && invocation !== null && !Array.isArray(invocation)
    ? invocation as Record<string, unknown> : {};
  const frontmatter = parseSkillFrontmatter(memory.memoryValue);
  if (internal.frontmatter_error || internal.policy_error || frontmatter.error
    || state === "policy_unknown" || reason === "policy_unknown") return "policy_unknown";
  if (policy.disable_model_invocation === true || policy.allow_implicit_invocation === false
    || frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true
    || state === "invocation_policy" || reason === "invocation_policy") return "invocation_policy";
  if (isUnverifiedLegacySkillCollision(memory)
    || state === "source_review_pending" || reason === "source_review_pending") return "source_review_pending";
  if (state === "scan_pending" || reason === "scan_pending") return "scan_pending";
  if (state && state !== "present") return "source_review_pending";
  // Codex policy is a separate file. A direct body write cannot prove it was read.
  if (normalizeAgentIdKey(String(internal.source_agent_id ?? "")) === "codex"
    && policy.policy_observed !== true && typeof policy.allow_implicit_invocation !== "boolean") return "policy_unknown";
  return memory.memoryValue.trim() || internal.source_raw_content_hash === importedSkillContentHash(memory.memoryValue)
    ? "present" : "scan_pending";
}

/** Intrinsic eligibility; callers with a database must also check connection authorization. */
export function importedSkillMayEmbed(memory: ImportedSkillEligibilityMemory): boolean {
  if (!isImportedSkill(memory)) return true;
  if (memory.deletedAt || (memory.status !== "activated" && memory.status !== "resolving")) return false;
  if (!String(memory.properties.internal_info.source_agent_id ?? "").trim()
    || memory.properties.internal_info.archive_reason || isIdentityOnlyImportedSkill(memory)) return false;
  return importedSkillSourceState(memory) === "present";
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
