import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { retrievalDocumentIsCurrent } from "../../algorithm/plugin-algorithms.js";
import {
  IMPORTED_SKILL_RETRIEVAL_VERSION,
  IMPORTED_SKILL_STATE_VERSION,
  importedSkillArchiveReason,
  isIdentityOnlyReason,
  normalizeSkillName,
  type ImportedSkillArchiveReason
} from "../../storage/imported-skill.js";
import type { MemoryRow, RequestEnvelope } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { firstLine } from "../../utils/text.js";
import { frontmatterBoolean, frontmatterString, parseSkillFrontmatter } from "@memmy/agent-source-core";
import { importedSkillInfoFields, importedSkillInternalFields, memoryAddKey } from "./memory-import-pipeline.js";

/** One SKILL.md found in the source Agent's skill directories. */
export interface AgentSkillReconcileSkill {
  /** Skill directory relative to its scan root; unique within the source Agent. */
  sourceSkillId: string;
  sourceSkillPath: string;
  title: string;
  content: string;
  contentHash: string;
  /** Source file modification time. */
  modifiedAt: string;
  version?: string;
  description?: string;
  disableModelInvocation?: boolean;
  allowImplicitInvocation?: boolean;
  /** The skill directory holds files besides SKILL.md. */
  hasSupportingFiles?: boolean;
}

/** A skill shipped in an enabled plugin of the source Agent; only its identity is kept. */
export interface AgentSkillReconcileRegistration {
  sourceSkillId: string;
  sourceSkillPath: string;
  name: string;
  pluginId?: string;
}

/**
 * Everything one scan found for one source Agent. Records missing from the
 * lists are archived only when the matching `complete` flag is true.
 */
export interface AgentSkillReconcileRequest extends RequestEnvelope {
  sourceAgentId: string;
  complete: boolean;
  skills: AgentSkillReconcileSkill[];
  registrations?: AgentSkillReconcileRegistration[];
  registrationsComplete?: boolean;
  /** The user disconnected this Agent from Memmy: its skills are no longer shared. */
  disconnected?: boolean;
}

export type AgentSkillReconcileOutcome = "created" | "updated" | "unchanged" | "deleted_by_user" | "failed";

export interface AgentSkillReconcileResult {
  sourceAgentId: string;
  skills: Array<{ sourceSkillId: string; outcome: AgentSkillReconcileOutcome; memoryId?: string; error?: string }>;
  archived: number;
  registrations: number;
  serverTime: string;
}

interface DesiredState {
  status: "activated" | "archived";
  reason?: ImportedSkillArchiveReason;
  /** For a user-archived record: what the source says, kept for when the archive is undone. */
  sourceState?: "present" | "source_missing" | "disconnected" | "invocation_policy";
}

export interface AgentSkillLibraryDeps {
  repos: Repositories;
  nowIso(): string;
  embedAfterCapture(): boolean;
  resolveUserId(request: RequestEnvelope): string;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: {
    jobType: "embedding";
    userId: string;
    sessionId?: string;
    targetMemoryId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
}

const RECONCILE_SOURCE = "agent_skill.reconcile";
const SKILL_VECTOR_FIELDS = ["vec", "vec_summary", "vec_action"] as const;

/**
 * Keeps the imported Skill records of one source Agent in line with what is
 * installed there. A source skill is identified by "Agent + skill directory";
 * each content version is its own record (the key carries the content hash)
 * and exactly one version is current.
 */
export class AgentSkillLibrary {
  constructor(private readonly deps: AgentSkillLibraryDeps) {}

  reconcile(request: AgentSkillReconcileRequest): AgentSkillReconcileResult {
    const sourceAgentId = request.sourceAgentId.trim();
    const userId = this.deps.resolveUserId(request);
    const at = this.deps.nowIso();
    const result: AgentSkillReconcileResult = {
      sourceAgentId,
      skills: [],
      archived: 0,
      registrations: 0,
      serverTime: at
    };
    this.deps.repos.transaction(() => {
      const groups = groupBySourceIdentity(this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId));
      const scannedIds = new Set<string>();
      for (const skill of request.skills) {
        scannedIds.add(skill.sourceSkillId);
        try {
          // Each skill is its own savepoint: a failed write leaves nothing half done.
          result.skills.push(this.deps.repos.transaction(() =>
            this.reconcileSkill(sourceAgentId, userId, skill, groups.get(skill.sourceSkillId) ?? [], request.disconnected === true, at)));
        } catch (error) {
          result.skills.push({
            sourceSkillId: skill.sourceSkillId,
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      for (const [sourceSkillId, versions] of groups) {
        if (scannedIds.has(sourceSkillId) || isRegistrationGroup(versions)) continue;
        for (const version of versions) {
          if (isDeleted(version)) continue;
          const reason = importedSkillArchiveReason(version);
          if (reason === "user") {
            // The user's archive stays, but what happened at the source is
            // remembered so undoing the archive does not share it again.
            const sourceState = request.disconnected === true ? "disconnected" : request.complete ? "source_missing" : undefined;
            if (sourceState && version.properties.internal_info.source_state !== sourceState) {
              this.deps.repos.memories.updateMaintenance(withImportFields(version, { source_state: sourceState }, version.updatedAt));
            }
            continue;
          }
          if (reason === "superseded" || reason === "source_missing") continue;
          if (request.disconnected === true && reason !== "disconnected") {
            this.applyState(version, { status: "archived", reason: "disconnected" }, at, "agent_skill_disconnected");
            result.archived += 1;
          } else if (request.complete) {
            this.applyState(version, { status: "archived", reason: "source_missing" }, at, "agent_skill_source_missing");
            result.archived += 1;
          }
        }
      }
      if (request.registrations) {
        result.registrations = this.reconcileRegistrations(sourceAgentId, userId, request.registrations, groups,
          request.registrationsComplete === true, at);
      }
    });
    return result;
  }

  /**
   * Brings imported Skill records written before source reconciliation up to
   * the current state version, using only what is stored. Facts that need the
   * source files (openai.yaml policy, plugins, whether a file still exists)
   * are settled by the next scan. Runs at startup; records that already carry
   * the version are skipped, so it can be repeated safely.
   */
  migrateLegacyRecords(at: string, limit: number): { migrated: number; scrubbedDeleted: number } {
    let migrated = 0;
    let scrubbedDeleted = 0;
    this.deps.repos.transaction(() => {
      const legacy = this.deps.repos.memories.listImportedSkillsBelowStateVersion(IMPORTED_SKILL_STATE_VERSION, limit);
      const bySource = new Map<string, MemoryRow[]>();
      for (const memory of legacy) {
        const sourceAgentId = String(memory.properties.internal_info.source_agent_id ?? "");
        bySource.set(sourceAgentId, [...(bySource.get(sourceAgentId) ?? []), memory]);
      }
      for (const [sourceAgentId, records] of bySource) {
        const pending = new Set(records.map((memory) => memory.id));
        // Versions already migrated still count when choosing the current one.
        const groups = groupBySourceIdentity(this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId));
        for (const versions of groups.values()) {
          const live = versions.filter((version) => !isDeleted(version));
          const current = live
            .filter((version) => version.status === "activated" || version.status === "resolving")
            .sort(compareImportRecency)[0];
          for (const version of versions) {
            if (!pending.has(version.id)) continue;
            if (isDeleted(version)) {
              this.deps.repos.memories.rewriteDeletedRow(stripBody(withImportFields(version, stateFields({ status: "archived" }), version.updatedAt), version.updatedAt));
              this.deps.repos.runtime.scrubImportedSkillCopies(version.id);
              scrubbedDeleted += 1;
            } else {
              this.migrateLiveRecord(version, current, at);
            }
            migrated += 1;
          }
        }
      }
    });
    return { migrated, scrubbedDeleted };
  }

  /**
   * Switches existing imported skills to the description-based summary and
   * retrieval text. The previous values are kept in `retrieval_previous` so
   * restoreRetrievalRepresentation can put them back. Startup's retrieval
   * index repair re-embeds the records whose retrieval text changed.
   */
  upgradeRetrievalRepresentation(limit: number): number {
    let upgraded = 0;
    this.deps.repos.transaction(() => {
      for (const memory of this.deps.repos.memories.listImportedSkillsByRetrievalVersion(IMPORTED_SKILL_RETRIEVAL_VERSION, "below", limit)) {
        const description = typeof memory.properties.internal_info.skill_description === "string"
          ? memory.properties.internal_info.skill_description.trim()
          : "";
        const hasBody = memory.memoryValue.trim().length > 0;
        const next = withRetrievalText(memory, hasBody && description ? description : undefined,
          hasBody ? description || summaryOf(memory) : "");
        this.deps.repos.memories.updateMaintenance(withImportFields(next, retrievalFields(memory, existingRetrievalBlurb(memory)), memory.updatedAt));
        upgraded += 1;
      }
    });
    return upgraded;
  }

  /** Puts back the summary and retrieval text imported skills had before the upgrade. */
  restoreRetrievalRepresentation(limit: number): number {
    let restored = 0;
    this.deps.repos.transaction(() => {
      for (const memory of this.deps.repos.memories.listImportedSkillsByRetrievalVersion(IMPORTED_SKILL_RETRIEVAL_VERSION, "at", limit)) {
        const previous = memory.properties.internal_info.retrieval_previous;
        const before = previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
        const next = withRetrievalText(
          memory,
          typeof before.blurb === "string" ? before.blurb : undefined,
          typeof before.summary === "string" ? before.summary : firstLine(memory.memoryValue)
        );
        const internal = { ...next.properties.internal_info };
        delete internal.retrieval_representation_version;
        delete internal.retrieval_previous;
        this.deps.repos.memories.updateMaintenance({ ...next, properties: { ...next.properties, internal_info: internal } });
        restored += 1;
      }
    });
    return restored;
  }

  private migrateLiveRecord(memory: MemoryRow, current: MemoryRow | undefined, at: string): void {
    const internal = memory.properties.internal_info;
    const frontmatter = parseSkillFrontmatter(memory.memoryValue);
    const title = typeof internal.name === "string" ? internal.name
      : typeof memory.info.title === "string" ? memory.info.title : "";
    const description = frontmatterString(frontmatter.data, "description");
    const legacyFields: Record<string, unknown> = {
      source_kind: "skill",
      normalized_name: normalizeSkillName(title),
      source_modified_at: memory.timeline ?? memory.createdAt,
      ...(description ? { skill_description: description } : {}),
      invocation: { disable_model_invocation: frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true }
    };
    let desired: DesiredState;
    if (memory.status === "archived") {
      desired = { status: "archived", reason: typeof internal.superseded_by_skill_id === "string" ? "superseded" : "user" };
    } else if (current && current.id !== memory.id) {
      desired = { status: "archived", reason: "superseded" };
    } else if (frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true) {
      desired = { status: "archived", reason: "invocation_policy" };
    } else {
      desired = { status: "activated" };
    }
    const withFields = withImportFields(memory, legacyFields, memory.updatedAt);
    if (desired.status === memory.status && (desired.reason === undefined || memory.status === "archived")) {
      // Only metadata changes: keep the version and the stored updated_at.
      this.deps.repos.memories.updateMaintenance(withImportFields(withFields, stateFields(desired), memory.updatedAt));
      return;
    }
    this.applyState(withFields, desired, at, "agent_skill_state_migrated", desired.reason === "superseded" ? current?.id : undefined);
  }

  /**
   * Undoes the user's archive of an imported skill. The record goes back to
   * the state the rest of its source says it should have: superseded when a
   * newer version is current, identity-only when the source Agent marks it
   * user-invoked only, otherwise current again. Archives made by scans
   * (superseded, source missing, ...) are not the user's and are left alone.
   */
  restoreUserArchive(memory: MemoryRow, at: string): MemoryRow {
    if (importedSkillArchiveReason(memory) !== "user") return memory;
    const identity = memory.properties.internal_info.source_skill_id;
    const versions = this.deps.repos.memories
      .listImportedSkillsForSource(String(memory.properties.internal_info.source_agent_id ?? ""))
      .filter((version) => version.properties.internal_info.source_skill_id === identity);
    const current = versions.find((version) => version.id !== memory.id && !isDeleted(version)
      && (version.status === "activated" || importedSkillArchiveReason(version) === "user"));
    const invocation = memory.properties.internal_info.invocation;
    const policy = invocation && typeof invocation === "object" && !Array.isArray(invocation) ? invocation as Record<string, unknown> : {};
    // Scans while the user kept it archived recorded what happened to the source.
    const sourceState = memory.properties.internal_info.source_state;
    const desired: DesiredState = sourceState === "disconnected"
      ? { status: "archived", reason: "disconnected" }
      : sourceState === "source_missing"
        ? { status: "archived", reason: "source_missing" }
        : current
          ? { status: "archived", reason: "superseded" }
          : sourceState === "invocation_policy" || policy.disable_model_invocation === true || policy.allow_implicit_invocation === false
            ? { status: "archived", reason: "invocation_policy" }
            : { status: "activated" };
    if (desired.status === "archived") {
      this.applyState(memory, desired, at, "agent_skill_user_restored", current?.id);
      return this.deps.repos.memories.get(memory.id) ?? memory;
    }
    const internal = { ...memory.properties.internal_info };
    delete internal.archive_reason;
    delete internal.superseded_by_skill_id;
    internal.skill = { ...skillRecord(memory), status: "active" };
    const saved = this.deps.repos.memories.update({
      ...memory,
      status: "activated",
      properties: { ...memory.properties, status: "activated", internal_info: internal },
      updatedAt: at
    });
    this.appendChange(saved, memory, "updated", "agent_skill_user_restored", at);
    if (!retrievalDocumentIsCurrent(saved) || !this.deps.repos.memories.hasVector(saved.id, "vec")) {
      this.enqueueEmbedding(saved, at);
    }
    return saved;
  }

  /** Whether this Agent's skills were archived because the user disconnected it. */
  isDisconnected(sourceAgentId: string): boolean {
    return this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId)
      .some((memory) => !memory.deletedAt && (importedSkillArchiveReason(memory) === "disconnected"
        // A skill the user archived keeps that reason and records the disconnect separately.
        || memory.properties.internal_info.source_state === "disconnected"));
  }

  /** Records the user's own archive so later scans keep it. */
  markUserArchived(memory: MemoryRow, at: string): MemoryRow {
    // Keep what an earlier scan said about the source; otherwise it is present.
    const previous = importedSkillArchiveReason(memory);
    const sourceState = previous === "disconnected" || previous === "source_missing" || previous === "invocation_policy"
      ? previous
      : previous === "user" ? memory.properties.internal_info.source_state ?? "present" : "present";
    return this.deps.repos.memories.update(withImportFields(memory, {
      archive_reason: "user",
      source_state: sourceState,
      skill: { ...skillRecord(memory), status: "archived" }
    }, at));
  }

  /**
   * Strips the skill body before the record is soft-deleted. Only the source
   * identity stays, which is what stops the next scan from importing it again.
   */
  stripBeforeDelete(memory: MemoryRow, at: string): MemoryRow {
    for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(memory.id, field);
    // Deleting the version the source currently has means "do not import this
    // skill again"; deleting an old, superseded version only removes that one.
    const reason = importedSkillArchiveReason(memory);
    const deletedCurrent = reason !== "superseded" && reason !== "source_missing";
    return this.deps.repos.memories.update(withImportFields(stripBody(memory, at), { deleted_current: deletedCurrent }, at));
  }

  private reconcileSkill(
    sourceAgentId: string,
    userId: string,
    skill: AgentSkillReconcileSkill,
    versions: MemoryRow[],
    disconnected: boolean,
    at: string
  ): AgentSkillReconcileResult["skills"][number] {
    // Records deleted before this marker existed count as deleted current versions.
    if (versions.some((version) => isDeleted(version) && version.properties.internal_info.deleted_current !== false)) {
      return { sourceSkillId: skill.sourceSkillId, outcome: "deleted_by_user" };
    }
    const key = memoryAddKey({
      content: skill.content,
      layer: "Skill",
      sourceAgentId,
      sourceSkillId: skill.sourceSkillId,
      sourceContentHash: skill.contentHash
    }, "Skill", skill.title);
    const existing = versions.find((version) => version.memoryKey === key);
    const live = versions.filter((version) => !isDeleted(version));
    // The user deleted exactly this content as an old version: do not bring it
    // back, and stop recalling a version the source no longer has.
    if (existing && isDeleted(existing)) {
      for (const version of live) {
        if (version.status !== "activated" && version.status !== "resolving") continue;
        this.applyState(version, { status: "archived", reason: "superseded" }, at, "read_only_skill_superseded", existing.id);
      }
      return { sourceSkillId: skill.sourceSkillId, outcome: "deleted_by_user" };
    }
    const desired = desiredState(skill, live, disconnected);
    let current: MemoryRow;
    let outcome: AgentSkillReconcileOutcome;
    if (!existing) {
      current = this.createVersion(sourceAgentId, userId, skill, key, desired, at);
      outcome = "created";
    } else if (isUnchanged(existing, skill, desired)) {
      current = this.refreshMetadata(existing, skill);
      outcome = "unchanged";
    } else {
      current = this.rewriteVersion(existing, skill, desired, at);
      outcome = "updated";
    }
    for (const version of live) {
      if (version.id === current.id) continue;
      if (version.status === "archived" && importedSkillArchiveReason(version) === "superseded"
        && version.properties.internal_info.superseded_by_skill_id === current.id) continue;
      this.applyState(version, { status: "archived", reason: "superseded" }, at, "read_only_skill_superseded", current.id);
    }
    return { sourceSkillId: skill.sourceSkillId, outcome, memoryId: current.id };
  }

  private createVersion(
    sourceAgentId: string,
    userId: string,
    skill: AgentSkillReconcileSkill,
    key: string,
    desired: DesiredState,
    at: string
  ): MemoryRow {
    const identityOnly = isIdentityOnlyReason(desired.reason);
    const content = identityOnly ? "" : skill.content;
    const summary = identityOnly ? "" : skillSummary(skill);
    const memory = this.deps.buildMemory({
      userId,
      agentId: sourceAgentId,
      layer: "Skill",
      kind: "skill",
      lifecycleStatus: desired.status === "activated" ? "active" : "archived",
      memoryType: "SkillMemory",
      key,
      value: content,
      tags: ["agent-source", "cross-agent-skill", sourceAgentId],
      info: {
        title: skill.title,
        summary,
        source: sourceAgentId,
        turn_id: `skill:${skill.sourceSkillId}:${skill.contentHash}`,
        ...importedSkillInfoFields(skill.title)
      },
      internal: {
        source: sourceAgentId,
        title: skill.title,
        summary,
        turn_id: `skill:${skill.sourceSkillId}:${skill.contentHash}`,
        ...importedSkillInternalFields({
          sourceAgentId,
          sourceSkillId: skill.sourceSkillId,
          sourceSkillPath: skill.sourceSkillPath,
          sourceSkillVersion: skill.version ?? skill.contentHash,
          sourceContentHash: skill.contentHash,
          importedAt: at,
          title: skill.title,
          content,
          skillStatus: desired.status === "activated" ? "active" : "archived",
          ...(identityOnly ? {} : { retrievalBlurb: skill.description })
        }),
        ...scanFields(skill),
        ...stateFields(desired),
        ...retrievalFields(undefined, undefined)
      },
      createdAt: skill.modifiedAt
    });
    const inserted = this.deps.repos.memories.insert({ ...memory, updatedAt: at });
    this.appendChange(inserted, undefined, "created", "create", at);
    if (desired.status === "activated") this.enqueueEmbedding(inserted, at);
    return inserted;
  }

  private rewriteVersion(existing: MemoryRow, skill: AgentSkillReconcileSkill, desired: DesiredState, at: string): MemoryRow {
    const identityOnly = isIdentityOnlyReason(desired.reason);
    const content = identityOnly ? "" : skill.content;
    const summary = identityOnly ? "" : skillSummary(skill);
    const fields = importedSkillInternalFields({
      sourceAgentId: String(existing.properties.internal_info.source_agent_id),
      sourceSkillId: skill.sourceSkillId,
      sourceSkillPath: skill.sourceSkillPath,
      sourceSkillVersion: skill.version ?? skill.contentHash,
      sourceContentHash: skill.contentHash,
      importedAt: typeof existing.properties.internal_info.imported_at === "string"
        ? existing.properties.internal_info.imported_at
        : at,
      title: skill.title,
      content,
      skillStatus: desired.status === "activated" ? "active" : "archived",
      ...(identityOnly ? {} : { retrievalBlurb: skill.description })
    });
    const internal: MemoryRow["properties"]["internal_info"] = {
      ...existing.properties.internal_info,
      ...fields,
      title: skill.title,
      summary,
      ...scanFields(skill),
      ...stateFields(desired),
      ...retrievalFields(existing, existingRetrievalBlurb(existing))
    };
    delete internal.superseded_by_skill_id;
    if (!desired.reason) delete internal.archive_reason;
    const info = { ...existing.info, title: skill.title, summary, ...importedSkillInfoFields(skill.title) };
    const next: MemoryRow = {
      ...existing,
      status: desired.status,
      memoryValue: content,
      info,
      properties: {
        ...existing.properties,
        status: desired.status,
        ...(existing.properties.info ? { info: { ...existing.properties.info, ...info } } : {}),
        internal_info: internal
      },
      updatedAt: at
    };
    if (identityOnly) {
      for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(existing.id, field);
    }
    const saved = this.deps.repos.memories.update(next);
    this.appendChange(saved, existing, "updated", "update", at);
    const bodyChanged = existing.memoryValue !== content;
    if (desired.status === "activated" && (bodyChanged || existing.status !== "activated"
      || !retrievalDocumentIsCurrent(saved) || !this.deps.repos.memories.hasVector(saved.id, "vec"))) {
      this.enqueueEmbedding(saved, at);
    }
    return saved;
  }

  /** Same content and state: only source metadata may change, without a rewrite or a new embedding. */
  private refreshMetadata(existing: MemoryRow, skill: AgentSkillReconcileSkill): MemoryRow {
    const internal = existing.properties.internal_info;
    const scan = scanFields(skill);
    const changed = internal.source_skill_path !== skill.sourceSkillPath
      || Object.entries(scan).some(([key, value]) => JSON.stringify(internal[key]) !== JSON.stringify(value));
    if (!changed) return existing;
    // updateMaintenance keeps the version and the stored updated_at, so the
    // keyword channel's updated_at ordering is not disturbed.
    return this.deps.repos.memories.updateMaintenance({
      ...existing,
      properties: {
        ...existing.properties,
        internal_info: { ...internal, source_skill_path: skill.sourceSkillPath, ...scan }
      }
    });
  }

  private applyState(memory: MemoryRow, desired: DesiredState, at: string, changeType: string, supersededBy?: string): void {
    const identityOnly = isIdentityOnlyReason(desired.reason);
    const base = identityOnly ? stripBody(memory, at) : memory;
    const next = withImportFields({ ...base, status: desired.status, properties: { ...base.properties, status: desired.status } }, {
      ...stateFields(desired),
      ...(supersededBy ? { superseded_by_skill_id: supersededBy } : {}),
      skill: { ...skillRecord(base), status: desired.status === "activated" ? "active" : "archived" }
    }, at);
    if (identityOnly) {
      for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(memory.id, field);
    }
    const saved = this.deps.repos.memories.update(next);
    this.appendChange(saved, memory, "archived", changeType, at);
  }

  private reconcileRegistrations(
    sourceAgentId: string,
    userId: string,
    registrations: readonly AgentSkillReconcileRegistration[],
    groups: Map<string, MemoryRow[]>,
    complete: boolean,
    at: string
  ): number {
    const seen = new Set<string>();
    for (const registration of registrations) {
      seen.add(registration.sourceSkillId);
      const existing = (groups.get(registration.sourceSkillId) ?? []).find((memory) => !isDeleted(memory));
      const fields = {
        read_only: true,
        source_agent_id: sourceAgentId,
        source_skill_id: registration.sourceSkillId,
        source_skill_path: registration.sourceSkillPath,
        source_kind: "plugin",
        ...(registration.pluginId ? { plugin_id: registration.pluginId } : {}),
        name: registration.name,
        title: registration.name,
        normalized_name: normalizeSkillName(registration.name),
        import_state_version: IMPORTED_SKILL_STATE_VERSION,
        archive_reason: "registration"
      };
      if (!existing) {
        const memory = this.deps.buildMemory({
          userId,
          agentId: sourceAgentId,
          layer: "Skill",
          kind: "skill",
          lifecycleStatus: "archived",
          memoryType: "SkillMemory",
          key: `skill.registration:${stableHash([sourceAgentId, registration.sourceSkillId]).slice(0, 20)}`,
          value: "",
          tags: ["agent-source", "plugin-skill", sourceAgentId],
          info: { title: registration.name, summary: "", source: sourceAgentId, name: registration.name },
          internal: { source: sourceAgentId, summary: "", ...fields },
          createdAt: at
        });
        this.deps.repos.memories.insert(memory);
        continue;
      }
      const internal = existing.properties.internal_info;
      const same = existing.status === "archived"
        && Object.entries(fields).every(([key, value]) => JSON.stringify(internal[key]) === JSON.stringify(value));
      if (same) continue;
      this.deps.repos.memories.updateMaintenance({
        ...existing,
        status: "archived",
        properties: { ...existing.properties, status: "archived", internal_info: { ...internal, ...fields } }
      });
    }
    if (complete) {
      for (const [sourceSkillId, versions] of groups) {
        if (seen.has(sourceSkillId) || !isRegistrationGroup(versions)) continue;
        for (const version of versions) {
          if (isDeleted(version) || importedSkillArchiveReason(version) !== "registration") continue;
          this.deps.repos.memories.updateMaintenance(withImportFields(version, { archive_reason: "source_missing" }, version.updatedAt));
        }
      }
    }
    return registrations.length;
  }

  private enqueueEmbedding(memory: MemoryRow, at: string): void {
    if (!this.deps.embedAfterCapture()) return;
    this.deps.enqueueJob({
      jobType: "embedding",
      userId: memory.userId,
      sessionId: memory.sessionId,
      targetMemoryId: memory.id,
      payload: { source: RECONCILE_SOURCE },
      createdAt: at
    });
  }

  private appendChange(after: MemoryRow, before: MemoryRow | undefined, op: string, changeType: string, at: string): void {
    this.deps.repos.runtime.appendChange({
      memoryId: after.id,
      namespaceId: this.deps.namespaceIdFromMemory(after),
      kind: "skill",
      op,
      entityId: after.id,
      userId: after.userId,
      changeType,
      ...(before ? { before } : {}),
      after,
      source: RECONCILE_SOURCE,
      createdAt: at
    });
  }
}

function desiredState(skill: AgentSkillReconcileSkill, versions: readonly MemoryRow[], disconnected: boolean): DesiredState {
  if (versions.some((version) => !isDeleted(version) && importedSkillArchiveReason(version) === "user")) {
    const sourceState = disconnected ? "disconnected"
      : skill.disableModelInvocation === true || skill.allowImplicitInvocation === false ? "invocation_policy" : "present";
    return { status: "archived", reason: "user", sourceState };
  }
  if (disconnected) return { status: "archived", reason: "disconnected" };
  if (skill.disableModelInvocation === true || skill.allowImplicitInvocation === false) {
    return { status: "archived", reason: "invocation_policy" };
  }
  return { status: "activated" };
}

function isUnchanged(existing: MemoryRow, skill: AgentSkillReconcileSkill, desired: DesiredState): boolean {
  const internal = existing.properties.internal_info;
  if (internal.import_state_version !== IMPORTED_SKILL_STATE_VERSION) return false;
  if (internal.retrieval_representation_version !== IMPORTED_SKILL_RETRIEVAL_VERSION) return false;
  if (internal.source_content_hash !== skill.contentHash) return false;
  if (existing.status !== desired.status || importedSkillArchiveReason(existing) !== desired.reason) return false;
  if (desired.sourceState && internal.source_state !== desired.sourceState) return false;
  if (internal.superseded_by_skill_id !== undefined) return false;
  const expectedBody = isIdentityOnlyReason(desired.reason) ? "" : skill.content;
  return existing.memoryValue === expectedBody;
}

/** Fields that describe the scanned file; they never trigger a rewrite on their own. */
function scanFields(skill: AgentSkillReconcileSkill): Record<string, unknown> {
  return {
    source_kind: "skill",
    normalized_name: normalizeSkillName(skill.title),
    source_modified_at: skill.modifiedAt,
    ...(skill.description ? { skill_description: skill.description } : {}),
    has_supporting_files: skill.hasSupportingFiles === true,
    invocation: {
      disable_model_invocation: skill.disableModelInvocation === true,
      ...(skill.allowImplicitInvocation === undefined ? {} : { allow_implicit_invocation: skill.allowImplicitInvocation })
    }
  };
}

function stateFields(desired: DesiredState): Record<string, unknown> {
  return {
    import_state_version: IMPORTED_SKILL_STATE_VERSION,
    ...(desired.reason ? { archive_reason: desired.reason } : {}),
    ...(desired.sourceState ? { source_state: desired.sourceState } : {})
  };
}

function withImportFields(memory: MemoryRow, fields: Record<string, unknown>, at: string): MemoryRow {
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: { ...memory.properties.internal_info, ...fields }
    },
    updatedAt: at
  };
}

function stripBody(memory: MemoryRow, at: string): MemoryRow {
  const internal = { ...memory.properties.internal_info };
  const skill = skillRecord(memory);
  internal.invocation_guide = "";
  internal.procedure_json = { summary: "" };
  internal.summary = "";
  internal.skill = { ...skill, invocation_guide: "", procedure_json: { summary: "" } };
  delete internal.skill_description;
  delete internal.retrieval_index;
  delete internal.retrieval_previous;
  return {
    ...memory,
    memoryValue: "",
    info: { ...memory.info, summary: "" },
    properties: {
      ...memory.properties,
      ...(memory.properties.info ? { info: { ...memory.properties.info, summary: "" } } : {}),
      internal_info: internal
    },
    updatedAt: at
  };
}

function skillRecord(memory: MemoryRow): Record<string, unknown> {
  const skill = memory.properties.internal_info.skill;
  return typeof skill === "object" && skill !== null && !Array.isArray(skill) ? skill as Record<string, unknown> : {};
}

function groupBySourceIdentity(memories: readonly MemoryRow[]): Map<string, MemoryRow[]> {
  const groups = new Map<string, MemoryRow[]>();
  for (const memory of memories) {
    const internal = memory.properties.internal_info;
    const identity = typeof internal.source_skill_id === "string" && internal.source_skill_id
      ? internal.source_skill_id
      : typeof internal.source_skill_path === "string" ? internal.source_skill_path : undefined;
    if (!identity) continue;
    const group = groups.get(identity) ?? [];
    group.push(memory);
    groups.set(identity, group);
  }
  return groups;
}

function isRegistrationGroup(versions: readonly MemoryRow[]): boolean {
  return versions.some((version) => version.properties.internal_info.source_kind === "plugin");
}

function isDeleted(memory: MemoryRow): boolean {
  return Boolean(memory.deletedAt) || memory.status === "deleted";
}

/** Newest import first: the version most recently written by an import is treated as current. */
function compareImportRecency(left: MemoryRow, right: MemoryRow): number {
  const time = (memory: MemoryRow) => {
    const imported = memory.properties.internal_info.imported_at;
    return typeof imported === "string" ? imported : memory.updatedAt;
  };
  return time(right).localeCompare(time(left)) || right.updatedAt.localeCompare(left.updatedAt);
}

/** The summary shown for an imported skill: its frontmatter description, else the first line. */
function skillSummary(skill: AgentSkillReconcileSkill): string {
  return skill.description?.trim() || firstLine(skill.content);
}

function existingRetrievalBlurb(memory: MemoryRow): string | null {
  const procedure = skillRecord(memory).procedure_json;
  const blurb = procedure && typeof procedure === "object" && !Array.isArray(procedure)
    ? (procedure as Record<string, unknown>).retrievalBlurb
    : undefined;
  return typeof blurb === "string" ? blurb : null;
}

/**
 * Marks the record as using the description-based summary and retrieval text,
 * and remembers what it had before the first such write so it can be restored.
 */
function retrievalFields(existing: MemoryRow | undefined, previousBlurb: string | null | undefined): Record<string, unknown> {
  const internal = existing?.properties.internal_info;
  const alreadyUpgraded = internal?.retrieval_representation_version === IMPORTED_SKILL_RETRIEVAL_VERSION;
  return {
    retrieval_representation_version: IMPORTED_SKILL_RETRIEVAL_VERSION,
    ...(alreadyUpgraded || !existing ? {} : {
      retrieval_previous: {
        blurb: previousBlurb ?? null,
        summary: typeof internal?.summary === "string" ? internal.summary : null
      }
    })
  };
}

function summaryOf(memory: MemoryRow): string {
  return typeof memory.properties.internal_info.summary === "string" ? memory.properties.internal_info.summary : firstLine(memory.memoryValue);
}

/** Sets (or removes, when undefined) the retrieval blurb and sets the summary everywhere they are stored. */
function withRetrievalText(memory: MemoryRow, blurb: string | undefined, summary: string): MemoryRow {
  const internal = { ...memory.properties.internal_info };
  const withBlurb = (procedure: unknown): Record<string, unknown> => {
    const next = { ...(procedure && typeof procedure === "object" && !Array.isArray(procedure) ? procedure as Record<string, unknown> : {}) };
    if (blurb) next.retrievalBlurb = blurb;
    else delete next.retrievalBlurb;
    return next;
  };
  internal.procedure_json = withBlurb(internal.procedure_json);
  internal.skill = { ...skillRecord(memory), procedure_json: withBlurb(skillRecord(memory).procedure_json) };
  internal.summary = summary;
  return {
    ...memory,
    info: { ...memory.info, summary },
    properties: {
      ...memory.properties,
      ...(memory.properties.info ? { info: { ...memory.properties.info, summary } } : {}),
      internal_info: internal
    }
  };
}
