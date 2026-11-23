import type { MemoryService } from "../../src/service/memory-service.js";
import type { Repositories } from "../../src/storage/repositories.js";
import type { MemoryAddRequest, MemoryRow } from "../../src/types.js";
import { agentSkillInstallationsKey, importedSkillSourceIdentity, normalizeSkillName,
  type AgentSkillInstallations } from "../../src/storage/imported-skill.js";
import { withLegacyImportedSkillWriter } from "./legacy-imported-skill-writer.js";

/**
 * Replays the intermediate library writer, including its destructive state
 * transition and audit log. The original direct-writer fixture alone only
 * archives activated rows and never appends a supersession change.
 *
 * Historical implementation: round6-baseline/agent-skill-library.ts
 * upsertMemoryAdd -> recordInstallations -> supersedeOtherVersions -> applyState.
 * This form used the incoming path; the later path-inheriting writer is not
 * silently modeled as a provable non-source manual here.
 */
export function replayRound6ManualCollision(service: MemoryService, repos: Repositories,
  request: MemoryAddRequest, at: string, options: { inheritedPath?: boolean } = {}): string {
  const source = request.source ?? request.namespace?.source ?? "hermes";
  const identity = request.turnId!;
  const before = repos.memories.listImportedSkillsForSource(source)
    .filter(row => importedSkillSourceIdentity(row) === identity && !row.deletedAt && row.status !== "deleted");
  const id = withLegacyImportedSkillWriter(service, () => service.addMemory(request)).id;
  let manual = repos.memories.getIncludingDeleted(id)!;
  if (options.inheritedPath) {
    // The final Round 6 adapter inherited the current source path before
    // persistVersion; its ordinary turn id and manual tags remained unchanged.
    const current = before.find(row => row.properties.internal_info.archive_reason !== "superseded") ?? before[before.length - 1];
    manual = repos.memories.updateMaintenance({ ...manual, properties: { ...manual.properties, internal_info: {
      ...manual.properties.internal_info, source_kind: "skill", import_state_version: 2,
      source_skill_path: current?.properties.internal_info.source_skill_path
    } } });
  }
  const key = agentSkillInstallationsKey(source);
  const stored = repos.runtime.getKv(key)?.value as AgentSkillInstallations | undefined;
  const skills = new Map((stored?.skills ?? []).map(entry => [entry.sourceSkillId, entry]));
  skills.set(identity, { sourceSkillId: identity, normalizedName: normalizeSkillName(String(manual.info.title)) });
  repos.runtime.setKv(key, { version: 1, skills: [...skills.values()], registrations: stored?.registrations ?? [] }, at);
  for (const version of before) {
    const internal: MemoryRow["properties"]["internal_info"] = { ...version.properties.internal_info, archive_reason: "superseded",
      superseded_by_skill_id: id, skill: { ...(version.properties.internal_info.skill as Record<string, unknown>), status: "archived" } };
    delete internal.source_state;
    const saved = repos.memories.update({ ...version, status: "archived", updatedAt: at,
      properties: { ...version.properties, status: "archived", internal_info: internal } } as MemoryRow);
    repos.runtime.appendChange({ memoryId: version.id, entityId: version.id, userId: version.userId,
      kind: "skill", op: "archived", changeType: "read_only_skill_superseded", before: version, after: saved,
      source: "agent_skill.reconcile", createdAt: at });
  }
  repos.runtime.appendChange({ memoryId: manual.id, entityId: manual.id, userId: manual.userId,
    kind: "skill", op: "created", changeType: "create", after: manual, source: options.inheritedPath ? "agent_skill.reconcile" : "memory.add", createdAt: at });
  return id;
}

/** R9 repaired the edge and then archiveMemory synthesized source_state=present. */
export function replayRound9UnverifiedArchive(repos: Repositories, fileId: string, manualId: string, at: string): void {
  const original = repos.memories.getIncludingDeleted(fileId)!;
  const manual = repos.memories.getIncludingDeleted(manualId)!;
  const manualInternal: MemoryRow["properties"]["internal_info"] = { ...manual.properties.internal_info,
    read_only: false, source_kind: "manual" };
  for (const field of ["source_agent_id", "source_skill_id", "source_skill_path", "imported_at", "normalized_name",
    "import_state_version", "archive_reason", "source_state"]) delete manualInternal[field];
  repos.memories.updateMaintenance({ ...manual, properties: { ...manual.properties, internal_info: manualInternal } });
  const pendingInternal: MemoryRow["properties"]["internal_info"] = { ...original.properties.internal_info,
    archive_reason: "source_review_pending" };
  delete pendingInternal.superseded_by_skill_id;
  delete pendingInternal.source_state;
  const pending = repos.memories.update({ ...original, status: "archived", updatedAt: at,
    properties: { ...original.properties, status: "archived", internal_info: pendingInternal } });
  repos.runtime.appendChange({ memoryId: fileId, userId: original.userId, kind: "skill", op: "archived",
    changeType: "legacy_manual_supersession_repaired", before: original, after: pending,
    source: "agent_skill.reconcile", createdAt: at });
  const archived = repos.memories.update({ ...pending, updatedAt: at, properties: { ...pending.properties,
    internal_info: { ...pending.properties.internal_info, archive_reason: "user", source_state: "present" } } });
  repos.runtime.appendChange({ memoryId: fileId, userId: original.userId, kind: "skill", op: "archived",
    changeType: "archive", before: original, after: archived, source: "panel.archive", createdAt: at });
  repos.runtime.setKv(agentSkillInstallationsKey(String(original.properties.internal_info.source_agent_id)), { version: 1,
    skills: [{ sourceSkillId: importedSkillSourceIdentity(original), normalizedName: normalizeSkillName(String(original.info.title)) }],
    registrations: [] }, at);
}
