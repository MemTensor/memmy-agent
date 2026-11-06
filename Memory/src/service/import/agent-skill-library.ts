import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { retrievalDocumentForMemory, retrievalDocumentIsCurrent, retrievalDocumentSourceHash } from "../../algorithm/plugin-algorithms.js";
import {
  IMPORTED_SKILL_RETRIEVAL_VERSION,
  IMPORTED_SKILL_STATE_VERSION,
  agentSkillConnectionKey,
  agentSkillInstallationsKey,
  type AgentSkillConnectionState,
  type AgentSkillInstallations,
  currentImportedSkillVersion,
  importedSkillArchiveReason,
  importedSkillName,
  hasStaleImportedSkillSupersession,
  hasImportedSkillSourceEvidence,
  importedSkillBodyMatchesSource,
  importedSkillContentHash,
  importedSkillMatchesContent,
  stripImportedSkillBody,
  withImportedSkillRawHash,
  withoutImportedSkillBodyCopies,
  importedSkillSourceState,
  type ImportedSkillSourceState,
  importedSkillSourceIdentity,
  isHistoricalImportedSkill,
  isUnverifiedLegacySkillCollision,
  hasRestrictedImportedSkillContent,
  isIdentityOnlyImportedSkill,
  isIdentityOnlyReason,
  normalizeSkillName,
  type ImportedSkillArchiveReason
} from "../../storage/imported-skill.js";
import type { MemoryRow, RequestEnvelope } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { firstLine } from "../../utils/text.js";
import { sanitizeMemmyProtocolText } from "../../utils/memmy-context-tags.js";
import { normalizeAgentIdKey } from "../../utils/agent-source-id.js";
import { frontmatterBoolean, frontmatterString, parseSkillFrontmatter } from "@memmy/agent-source-core";
import { importedSkillInfoFields, importedSkillInternalFields, memoryAddKey, skillInternalFields, type ImportedSkillMemoryAddOptions } from "./memory-import-pipeline.js";

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
  policyError?: string;
  frontmatterError?: string;
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
  /** Only an explicit connection event changes a persisted disconnect. */
  connectionState?: AgentSkillConnectionState;
  connectionKind?: "skill" | "plugin";
  /** Caller-generated attempt identifier so a timed-out connect recognizes its own commit. */
  connectionEventId?: string;
}

export interface AgentSkillConnectionEvent {
  id: string;
  state: AgentSkillConnectionState;
  kind?: "skill" | "plugin";
  revision?: number;
}

export type AgentSkillReconcileOutcome = "created" | "updated" | "unchanged" | "deleted_by_user" | "failed";

export interface AgentSkillReconcileResult {
  sourceAgentId: string;
  skills: Array<{ sourceSkillId: string; outcome: AgentSkillReconcileOutcome; memoryId?: string; error?: string }>;
  archived: number;
  registrations: number;
  serverTime: string;
  connectionEvent?: AgentSkillConnectionEvent;
}

interface DesiredState {
  status: "activated" | "archived";
  reason?: ImportedSkillArchiveReason;
  /** For a user-archived record: what the source says, kept for when the archive is undone. */
  sourceState?: ImportedSkillSourceState;
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
    request = { ...request, skills: request.skills.map(normalizeSkillObservation) };
    const sourceAgentId = normalizeAgentIdKey(request.sourceAgentId);
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
      this.prepareSource(sourceAgentId, at);
      this.recordConnection(request, at);
      if (request.connectionState) result.connectionEvent = this.connectionEvent(sourceAgentId);
      const disconnected = this.isDisconnected(sourceAgentId);
      this.recordInstallations(request, at);
      const groups = groupBySourceIdentity(this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId));
      const scannedIds = new Set<string>();
      for (const skill of request.skills) {
        scannedIds.add(skill.sourceSkillId);
        const versions = observationVersions(this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId), skill.sourceSkillId, skill.sourceSkillPath);
        for (const version of versions) scannedIds.add(importedSkillSourceIdentity(version));
        try {
          // Each skill is its own savepoint: a failed write leaves nothing half done.
          result.skills.push(this.deps.repos.transaction(() =>
            this.reconcileSkill(sourceAgentId, userId, skill, versions, disconnected, at)));
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
          const reason = archiveReasonForReconcile(version, versions);
          if (disconnected) {
            const sourceMissing = reason === "source_missing" || version.properties.internal_info.source_state === "source_missing";
            const desired: DesiredState = {
              status: "archived",
              reason: reason === "user" || reason === "superseded" || reason === "source_missing" ? reason : "disconnected",
              sourceState: sourceMissing ? "source_missing" : "disconnected"
            };
            if (version.properties.internal_info.source_state !== desired.sourceState || version.memoryValue
              || this.deps.repos.memories.hasVector(version.id, "vec")) {
              const successor = reason === "superseded" && typeof version.properties.internal_info.superseded_by_skill_id === "string"
                ? version.properties.internal_info.superseded_by_skill_id : undefined;
              this.applyState(sourceMissing ? stripBody(version, at) : version, desired, at, "agent_skill_disconnected", successor);
              result.archived += 1;
            }
            continue;
          }
          if (reason === "user") {
            // The user's archive stays, but what happened at the source is
            // remembered so undoing the archive does not share it again.
            const sourceState = request.complete ? "source_missing" : undefined;
            const restrict = hasRestrictedImportedSkillContent(version);
            if ((sourceState && version.properties.internal_info.source_state !== sourceState)
              || (restrict && version.memoryValue)) {
              const base = restrict ? stripBody(version, version.updatedAt) : version;
              const updated = this.deps.repos.memories.updateMaintenance(
                sourceState ? withImportFields(base, { source_state: sourceState }, version.updatedAt) : base
              );
              if (restrict) {
                this.deps.repos.runtime.scrubImportedSkillCopies(updated.id);
                this.clearSkillIndex(updated.id);
              }
            }
            continue;
          }
          if (reason === "superseded" || reason === "source_missing") continue;
          if (request.complete) {
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

  /** Normalize stored evidence before any source write or user lifecycle decision. */
  private prepareSource(sourceAgentId: string, at: string): void {
    this.repairLegacyManualSkills(at, 200, sourceAgentId);
    this.repairLegacySourceFacts(at, 200, sourceAgentId);
    this.seedInstallations(sourceAgentId, at);
    this.recordConnection({ sourceAgentId, complete: false, skills: [] }, at);
  }

  private preparedMemory(memory: MemoryRow, at: string): MemoryRow {
    this.prepareSource(String(memory.properties.internal_info.source_agent_id ?? ""), at);
    return this.deps.repos.memories.getIncludingDeleted(memory.id) ?? memory;
  }

  private seedInstallations(sourceAgentId: string, at: string): void {
    const key = agentSkillInstallationsKey(sourceAgentId);
    const stored = this.deps.repos.runtime.getKv(key)?.value as AgentSkillInstallations | undefined;
    if (stored?.version !== 1) {
      this.deps.repos.runtime.setKv(key, this.deps.repos.memories.legacyInstalledSkillsForAgent(sourceAgentId), at);
    }
  }

  private seenConnectionEventIds(sourceAgentId: string): string[] {
    const value = this.deps.repos.runtime.getKv(`${agentSkillConnectionKey(sourceAgentId)}:seen`)?.value;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  }

  private rememberConnectionEventId(sourceAgentId: string, eventId: string, seen: string[], at: string): void {
    const next = [...seen.filter(entry => entry !== eventId), eventId].slice(-64);
    this.deps.repos.runtime.setKv(`${agentSkillConnectionKey(sourceAgentId)}:seen`, next, at);
  }

  private recordConnection(request: AgentSkillReconcileRequest, at: string): void {
    const explicit = request.connectionState ?? (request.disconnected === true ? "disconnected" : undefined);
    if (explicit) {
      if (request.connectionState) {
        const current = this.connectionEvent(request.sourceAgentId);
        const requestedId = request.connectionEventId?.trim() || undefined;
        const seen = requestedId ? this.seenConnectionEventIds(request.sourceAgentId) : [];
        if (requestedId && (current?.id === requestedId || seen.includes(requestedId))) {
          return;
        }
        this.deps.repos.runtime.setKv(agentSkillConnectionKey(request.sourceAgentId), explicit, at);
        const revision = (current?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Agent connection event revision is exhausted");
        const id = requestedId ?? newId("agent_connection");
        this.deps.repos.runtime.setKv(`${agentSkillConnectionKey(request.sourceAgentId)}:event`, {
          id, state: request.connectionState, revision,
          ...(request.connectionKind === "skill" || request.connectionKind === "plugin" ? { kind: request.connectionKind } : {})
        }, at);
        if (requestedId) {
          this.rememberConnectionEventId(request.sourceAgentId, id, seen, at);
        }
      } else {
        this.deps.repos.runtime.setKv(agentSkillConnectionKey(request.sourceAgentId), explicit, at);
      }
    } else if (this.connectionState(request.sourceAgentId) === undefined && this.isDisconnected(request.sourceAgentId)) {
      this.deps.repos.runtime.setKv(agentSkillConnectionKey(request.sourceAgentId), "disconnected", at);
    }
  }

  /** Scan observations remain useful even when memory import is blocked or fails. */
  private recordInstallations(request: AgentSkillReconcileRequest, at: string): void {
    const key = agentSkillInstallationsKey(request.sourceAgentId);
    const stored = this.deps.repos.runtime.getKv(key)?.value as AgentSkillInstallations | undefined;
    const previous = stored?.version === 1
      ? stored
      : this.deps.repos.memories.legacyInstalledSkillsForAgent(request.sourceAgentId);
    const previousSkills = new Map(previous.skills.map(entry => [entry.sourceSkillId, entry.normalizedName] as const));
    const sourceMemories = this.deps.repos.memories.listImportedSkillsForSource(request.sourceAgentId);
    const skills = request.complete ? new Map<string, string>() : new Map(previousSkills);
    const registrations = new Map(previous.registrations.map(entry => [entry.sourceSkillId, entry.normalizedName] as const));
    for (const skill of request.skills) {
      const related = observationVersions(sourceMemories, skill.sourceSkillId, skill.sourceSkillPath);
      const aliases = new Set(related.map(importedSkillSourceIdentity));
      for (const memory of related) {
        const internal = memory.properties.internal_info;
        if (internal.source_skill_key && !internal.source_skill_id && !internal.source_skill_path) aliases.add(memory.id);
      }
      const knownName = previousSkills.get(skill.sourceSkillId)
        ?? [...aliases].map(identity => previousSkills.get(identity)).find(name => name !== undefined);
      for (const identity of aliases) if (identity !== skill.sourceSkillId) skills.delete(identity);
      skills.set(skill.sourceSkillId, skill.frontmatterError && knownName !== undefined ? knownName : normalizeSkillName(skill.title));
    }
    if (request.registrations) {
      if (request.registrationsComplete) registrations.clear();
      for (const registration of request.registrations) {
        registrations.set(registration.sourceSkillId, normalizeSkillName(registration.name));
      }
    }
    const inventory: AgentSkillInstallations = {
      version: 1,
      skills: [...skills].map(([sourceSkillId, normalizedName]) => ({ sourceSkillId, normalizedName })),
      registrations: [...registrations].map(([sourceSkillId, normalizedName]) => ({ sourceSkillId, normalizedName }))
    };
    this.deps.repos.runtime.setKv(key, inventory, at);
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
      migrated += this.repairLegacyManualSkills(at, limit);
      migrated += this.repairLegacySourceFacts(at, limit);
      for (;;) {
        const legacy = this.deps.repos.memories.listImportedSkillsBelowStateVersion(IMPORTED_SKILL_STATE_VERSION, Math.max(1, limit));
        if (legacy.length === 0) break;
        const before = migrated;
        const bySource = new Map<string, MemoryRow[]>();
        for (const memory of legacy) {
          const sourceAgentId = normalizeAgentIdKey(String(memory.properties.internal_info.source_agent_id ?? ""));
          bySource.set(sourceAgentId, [...(bySource.get(sourceAgentId) ?? []), memory]);
        }
        for (const [sourceAgentId, records] of bySource) {
          this.seedInstallations(sourceAgentId, at);
          this.recordConnection({ sourceAgentId, complete: false, skills: [] }, at);
          const pending = new Set(records.map((memory) => memory.id));
          // Versions already migrated still count when choosing the current one.
          const groups = groupBySourceIdentity(this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId));
          for (const versions of groups.values()) {
            if (!versions.some(version => pending.has(version.id))) continue;
            const current = currentImportedSkillVersion(versions);
            // A source's versions share user intent. Repair the whole legacy
            // group before a later batch can observe its already-rewritten rows.
            for (const version of versions) {
              if (Number(version.properties.internal_info.import_state_version ?? 0) >= IMPORTED_SKILL_STATE_VERSION) continue;
              if (isDeleted(version)) {
                const deletedCurrent = !isUnverifiedLegacySkillCollision(version) && importedSkillArchiveReason(version) !== "source_missing"
                  && version.properties.internal_info.source_state !== "source_missing"
                  && !isHistoricalImportedSkill(version, versions);
                const repaired = withImportFields(withImportedSkillRawHash(version), { import_state_version: IMPORTED_SKILL_STATE_VERSION,
                  deleted_current: deletedCurrent }, version.updatedAt);
                if (!isHistoricalImportedSkill(version, versions)) {
                  delete repaired.properties.internal_info.superseded_by_skill_id;
                  if (importedSkillArchiveReason(version) === "superseded") delete repaired.properties.internal_info.archive_reason;
                }
                this.deps.repos.memories.rewriteDeletedRow(stripBody(repaired, version.updatedAt));
                this.deps.repos.runtime.scrubImportedSkillCopies(version.id);
                scrubbedDeleted += 1;
              } else {
                this.migrateLiveRecord(version, current, this.isDisconnected(sourceAgentId), versions);
              }
              migrated += 1;
            }
          }
        }
        if (migrated === before) throw new Error("imported Skill migration made no progress");
      }
    });
    return { migrated, scrubbedDeleted };
  }

  /**
   * Updates imported descriptions and repairs the current retrieval representation.
   * Canonical imported retrieval retains the body; the description is display
   * metadata. Previous values are kept in `retrieval_previous` so
   * restoreRetrievalRepresentation can put them back. Startup's retrieval
   * index repair re-embeds the records whose retrieval text changed.
   */
  upgradeRetrievalRepresentation(limit: number): number {
    let upgraded = 0;
    this.deps.repos.transaction(() => {
      for (;;) {
        const batch = this.deps.repos.memories.listImportedSkillsByRetrievalVersion(IMPORTED_SKILL_RETRIEVAL_VERSION, "below", Math.max(1, limit));
        if (batch.length === 0) break;
        for (const memory of batch) {
          const next = applyRetrievalRepresentation(withImportedSkillRawHash(memory), memory);
          const saved = this.deps.repos.memories.updateMaintenance(next);
          this.reconcileSkillIndex(saved, this.deps.nowIso());
          upgraded += 1;
        }
      }
    });
    return upgraded;
  }

  /** Puts back the summary and retrieval text imported skills had before the upgrade. */
  restoreRetrievalRepresentation(limit: number): number {
    let restored = 0;
    this.deps.repos.transaction(() => {
      for (;;) {
        const batch = this.deps.repos.memories.listImportedSkillsByRetrievalVersion(IMPORTED_SKILL_RETRIEVAL_VERSION, "at", Math.max(1, limit));
        if (batch.length === 0) break;
        for (const memory of batch) {
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
          const saved = this.deps.repos.memories.updateMaintenance({ ...next, properties: { ...next.properties, internal_info: internal } });
          this.reconcileSkillIndex(saved, this.deps.nowIso());
          restored += 1;
        }
      }
    });
    return restored;
  }

  /** Detaches old tool-created Skills before directory inventory can consume them. */
  repairLegacyManualSkills(at: string, limit = 200, sourceAgentId?: string): number {
    return this.deps.repos.transaction(() => this.repairLegacyManualSkillsInTransaction(at, limit, sourceAgentId));
  }

  private repairLegacyManualSkillsInTransaction(at: string, limit: number, sourceAgentId?: string): number {
    let repaired = 0;
    const batchSize = Math.max(1, limit);
    // Repaired rows leave the read-only query, so the paging offset
    // advances only for genuine source rows that remain in that query.
    let offset = 0;
    for (;;) {
      const batch = this.deps.repos.memories.listLegacyReadOnlySkills(batchSize, offset, sourceAgentId);
      if (batch.length === 0) break;
      for (const memory of batch) {
        if (hasImportedSkillSourceEvidence(memory)) { offset += 1; continue; }
        const old = memory.properties.internal_info;
        const sourceAgentId = String(old.source_agent_id ?? "");
        const inventoryKey = agentSkillInstallationsKey(sourceAgentId);
        const storedInventory = this.deps.repos.runtime.getKv(inventoryKey)?.value as AgentSkillInstallations | undefined;
        // Resolve provenance while the original manual and its false successors
        // still exist; detaching either row must not erase that evidence.
        const repairedInventory = storedInventory?.version === 1
          ? this.deps.repos.memories.resolvedSkillInstallationsForAgent(sourceAgentId, [memory]) : undefined;
        // Persist row-level connection evidence before detaching its source fields.
        this.recordConnection({ sourceAgentId: String(old.source_agent_id ?? ""), complete: false, skills: [] }, at);
        const reason = importedSkillArchiveReason(memory);
        // Source scans could have archived a tool write by mistake. User archives
        // retain their intent, and stripped content stays archived until supplied.
        const accidentalArchive = reason === "source_missing" || reason === "disconnected" || reason === "scan_pending";
        const archived = memory.status === "archived" && (!accidentalArchive || !memory.memoryValue.trim());
        const status = isDeleted(memory) ? "deleted" : archived ? "archived" : "activated";
        const title = typeof memory.info.title === "string" ? memory.info.title : String(old.name ?? "");
        const defaults = skillInternalFields(title, archived ? "archived" : "active");
        const previousSkill = skillRecord(memory);
        const procedures = [old.procedure_json, previousSkill.procedure_json].map(value => {
          const procedure: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value)
            ? { ...value as Record<string, unknown> } : {};
          if (procedure.summary === memory.memoryValue) delete procedure.summary;
          if (Number(old.retrieval_representation_version ?? 0) > 0) {
            delete procedure.retrievalBlurb;
            delete procedure.retrieval_blurb;
          }
          return procedure;
        });
        const internal: MemoryRow["properties"]["internal_info"] = { ...defaults, ...old, read_only: false, source_kind: "manual",
          summary: firstLine(memory.memoryValue), procedure_json: procedures[0],
          skill: { ...defaults.skill as Record<string, unknown>, ...previousSkill,
            name: title, status: archived ? "archived" : "active",
            eta: typeof previousSkill.eta === "number" ? previousSkill.eta : 0.5, procedure_json: procedures[1] } };
        for (const field of ["source_agent_id", "source_skill_id", "source_skill_path", "source_skill_key", "source_skill_version",
          "source_content_hash", "source_raw_content_hash", "source_modified_at", "imported_at", "normalized_name", "import_state_version",
          "retrieval_representation_version", "retrieval_previous", "archive_reason", "source_state",
          "deleted_current", "superseded_by_skill_id", "invocation", "policy_error", "frontmatter_error", "skill_description"]) delete internal[field];
        const skill = internal.skill as Record<string, unknown>;
        for (const guide of ["invocation_guide", "invocationGuide"]) {
          if (internal[guide] === memory.memoryValue) delete internal[guide];
          if (skill[guide] === memory.memoryValue) delete skill[guide];
        }
        const next: MemoryRow = { ...memory, status,
          info: { ...memory.info, summary: firstLine(memory.memoryValue) },
          properties: { ...memory.properties, status,
            info: { ...memory.properties.info, summary: firstLine(memory.memoryValue) }, internal_info: internal } };
        const saved = isDeleted(memory)
          ? (this.deps.repos.memories.rewriteDeletedRow(next), next)
          : this.deps.repos.memories.updateMaintenance(next);
        this.repairSourceVersionsSupersededByManual(memory, at);
        if (repairedInventory) this.deps.repos.runtime.setKv(inventoryKey, repairedInventory, at);
        if (isDeleted(saved)) this.clearSkillIndex(saved.id);
        else this.reconcileSkillIndex(saved, at);
        repaired += 1;
      }
    }
    return repaired;
  }

  /** Persist the same collision history projection used by cold readers. */
  private repairLegacySourceFacts(at: string, limit: number, sourceAgentId?: string): number {
    let repaired = 0;
    const inventories = new Map<string, AgentSkillInstallations>();
    const batchSize = Math.max(1, limit);
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const batch = this.deps.repos.memories.listImportedSkillsWithLegacyCollisionHistory(batchSize, cursor, sourceAgentId);
      if (batch.length === 0) break;
      const last = batch.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
      for (const memory of batch) {
        const source = String(memory.properties.internal_info.source_agent_id ?? "");
        const successorId = memory.properties.internal_info.superseded_by_skill_id;
        const successor = typeof successorId === "string" ? this.deps.repos.memories.getIncludingDeleted(successorId) : undefined;
        const successorPolicy = successor?.properties.internal_info.invocation;
        // A real scan has already superseded these ambiguous bytes. Keep that
        // evidence when the user later archives just this historical record.
        if (isUnverifiedLegacySkillCollision(memory) && memory.status === "archived"
          && (importedSkillArchiveReason(memory) === "superseded" || importedSkillArchiveReason(memory) === "user")
          && successor && importedSkillSourceIdentity(successor) === importedSkillSourceIdentity(memory)
          && normalizeAgentIdKey(String(successor.properties.internal_info.source_agent_id ?? "")) === normalizeAgentIdKey(source)
          && importedSkillSourceState(successor) === "present" && successorPolicy && typeof successorPolicy === "object"
          && !Array.isArray(successorPolicy) && (successorPolicy as Record<string, unknown>).policy_observed === true) continue;
        let resolved = this.deps.repos.memories.resolveLegacyImportedSkillVersion(memory);
        const unchangedProjection = resolved.status === memory.status
          && JSON.stringify(resolved.properties.internal_info) === JSON.stringify(memory.properties.internal_info);
        if (unchangedProjection && (!isDeleted(resolved) || resolved.properties.internal_info.deleted_current !== false)) continue;
        if (!inventories.has(source)) {
          const stored = this.deps.repos.runtime.getKv(agentSkillInstallationsKey(source))?.value as AgentSkillInstallations | undefined;
          if (stored?.version === 1) inventories.set(source, this.deps.repos.memories.resolvedSkillInstallationsForAgent(source));
        }
        const reason = importedSkillArchiveReason(resolved);
        const state = resolved.properties.internal_info.source_state;
        if (memory.properties.internal_info.superseded_by_skill_id
          && !resolved.properties.internal_info.superseded_by_skill_id
          && (!state || state === "present") && (reason === undefined || reason === "user")) {
          resolved = withImportFields(resolved, { source_state: "source_review_pending" }, resolved.updatedAt);
        }
        if (isDeleted(resolved)) {
          const versions = this.deps.repos.memories.listImportedSkillsForSource(source)
            .filter(version => importedSkillSourceIdentity(version) === importedSkillSourceIdentity(resolved))
            .map(version => version.id === resolved.id ? resolved : this.deps.repos.memories.resolveLegacyImportedSkillVersion(version));
          const inventory = inventories.get(source);
          const preserveContentScope = resolved.properties.internal_info.deleted_current === false
            && inventory?.version === 1
            && ![...inventory.skills, ...inventory.registrations]
              .some(entry => entry.sourceSkillId === importedSkillSourceIdentity(resolved));
          const contentOnly = isUnverifiedLegacySkillCollision(resolved)
            || importedSkillSourceState(resolved) === "source_missing"
            || preserveContentScope
            || isHistoricalImportedSkill(resolved, versions);
          const rewritten = stripBody(withImportFields(resolved, {
            deleted_current: !contentOnly
          }, resolved.updatedAt), resolved.updatedAt);
          if (unchangedProjection
            && !memory.memoryValue
            && JSON.stringify(rewritten.properties.internal_info) === JSON.stringify(memory.properties.internal_info)) continue;
          this.deps.repos.memories.rewriteDeletedRow(rewritten);
          this.deps.repos.runtime.scrubImportedSkillCopies(resolved.id);
          this.clearSkillIndex(resolved.id);
        } else {
          const sourceState = this.sourceState(resolved, this.isDisconnected(source));
          const desired = desiredFromRepairedSource(resolved, sourceState);
          const successor = typeof resolved.properties.internal_info.superseded_by_skill_id === "string"
            ? resolved.properties.internal_info.superseded_by_skill_id : undefined;
          this.applyState(resolved, desired, at, "legacy_manual_supersession_repaired", successor, memory);
        }
        repaired += 1;
      }
    }
    for (const [source, inventory] of inventories) this.deps.repos.runtime.setKv(agentSkillInstallationsKey(source), inventory, at);
    return repaired;
  }

  /** A tool turn was never a successor of a source file, even when their ids collided. */
  private repairSourceVersionsSupersededByManual(manual: MemoryRow, at: string): Set<string> {
    const sourceAgentId = String(manual.properties.internal_info.source_agent_id ?? "");
    const versions = this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId).filter(hasImportedSkillSourceEvidence);
    const inventory = this.deps.repos.runtime.getKv(agentSkillInstallationsKey(sourceAgentId))?.value as AgentSkillInstallations | undefined;
    const affected = new Set(versions.filter(version => version.properties.internal_info.superseded_by_skill_id === manual.id).map(version => version.id));
    if (affected.size === 0) return new Set();
    const repaired = versions.map(version => {
      if (!affected.has(version.id)) return version;
      const resolved = this.deps.repos.memories.resolveLegacyImportedSkillVersion(version);
      const internal = { ...resolved.properties.internal_info };
      const manualMissing = importedSkillArchiveReason(manual) === "source_missing"
        || manual.properties.internal_info.source_state === "source_missing";
      if (manualMissing) internal.source_state = "source_missing";
      // A collision may make an installed file look historical, but explicit
      // source-missing evidence must keep its deletion scoped to these bytes.
      return { ...resolved, properties: { ...resolved.properties, internal_info: internal } };
    });
    for (const group of groupBySourceIdentity(repaired).values()) {
      for (const version of group) {
        if (!affected.has(version.id)) continue;
        const sourceMissing = importedSkillArchiveReason(version) === "source_missing"
          || version.properties.internal_info.source_state === "source_missing";
        if (isDeleted(version)) {
          // A round6 supersede could erase a missing reason. Preserve the
          // existing content-only scope when inventory also lacks this identity;
          // inventory absence alone never invents a missing state for live rows.
          const preserveContentScope = version.properties.internal_info.deleted_current === false
            && inventory?.version === 1 && ![...inventory.skills, ...inventory.registrations]
              .some(entry => entry.sourceSkillId === importedSkillSourceIdentity(version));
          const deleted = withImportFields(version, { deleted_current: !sourceMissing && !preserveContentScope
            && !isHistoricalImportedSkill(version, group) }, version.updatedAt);
          this.deps.repos.memories.rewriteDeletedRow(stripBody(deleted, version.updatedAt));
          this.deps.repos.runtime.scrubImportedSkillCopies(version.id);
          continue;
        }
        const original = versions.find(previous => previous.id === version.id)!;
        const reason = importedSkillArchiveReason(version);
        const disconnected = this.isDisconnected(sourceAgentId);
        const priorState = version.properties.internal_info.source_state;
        const evidence = withImportFields(version, {
          source_state: priorState && priorState !== "present" ? priorState
            : reason && reason !== "user" && reason !== "superseded" ? reason : "source_review_pending"
        }, version.updatedAt);
        const desired = desiredFromRepairedSource(evidence, this.sourceState(evidence, disconnected));
        const successor = typeof evidence.properties.internal_info.superseded_by_skill_id === "string"
          ? evidence.properties.internal_info.superseded_by_skill_id : undefined;
        // The resolved row carries historical source facts and any genuine
        // successor restored from before the manual collision. Keep the original
        // only as the audit-log before snapshot, never as the persisted evidence.
        this.applyState(sourceMissing && disconnected ? stripBody(evidence, at) : evidence,
          desired, at, "legacy_manual_supersession_repaired", successor, original);
      }
    }
    return new Set(versions.filter(version => affected.has(version.id)).map(importedSkillSourceIdentity));
  }

  private migrateLiveRecord(memory: MemoryRow, current: MemoryRow | undefined, disconnected: boolean, versions: readonly MemoryRow[]): void {
    memory = withImportedSkillRawHash(memory);
    const internal = memory.properties.internal_info;
    const modern = Number(internal.import_state_version ?? 0) >= 1;
    const frontmatter = parseSkillFrontmatter(memory.memoryValue);
    const refreshedByLegacyWriter = hasStaleImportedSkillSupersession(memory, versions);
    const title = typeof internal.name === "string" ? internal.name
      : typeof memory.info.title === "string" ? memory.info.title : "";
    const description = frontmatterString(frontmatter.data, "description");
    const previousInvocation = internal.invocation;
    const legacyFields: Record<string, unknown> = modern ? {} : {
      source_kind: internal.source_kind ?? "skill",
      normalized_name: normalizeSkillName(title),
      source_modified_at: memory.timeline ?? memory.createdAt,
      ...(description ? { skill_description: description } : {}),
      frontmatter_error: frontmatter.error ?? internal.frontmatter_error ?? null,
      invocation: {
        ...(previousInvocation && typeof previousInvocation === "object" && !Array.isArray(previousInvocation) ? previousInvocation : {}),
        disable_model_invocation: previousInvocation && typeof previousInvocation === "object" && !Array.isArray(previousInvocation)
          && (previousInvocation as Record<string, unknown>).disable_model_invocation === true
          || frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true
      }
    };
    const repairFields: Record<string, unknown> = refreshedByLegacyWriter ? {
      frontmatter_error: frontmatter.error ?? null,
      invocation: {
        ...(previousInvocation && typeof previousInvocation === "object" && !Array.isArray(previousInvocation) ? previousInvocation : {}),
        disable_model_invocation: frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true
      }
    } : {};
    const reason = archiveReasonForReconcile(memory, versions);
    const evidence = withImportFields(memory, { ...legacyFields, ...repairFields }, memory.updatedAt);
    const sourceState = this.sourceState(evidence, disconnected);
    // User intent belongs to the source identity; it never supplies source facts.
    const userArchived = versions.some(version => !isDeleted(version) && archiveReasonForReconcile(version, versions) === "user"
      && (!isUnverifiedLegacySkillCollision(version) || version.id === memory.id));
    const historical = current && current.id !== memory.id || reason === "superseded";
    const desired: DesiredState = historical
      ? { status: "archived", reason: "superseded", ...(sourceState !== "present" ? { sourceState } : {}) }
      : reason === "registration" ? { status: "archived", reason }
        : desiredFromSource(sourceState, userArchived || reason === "user");
    let next = withImportFields(memory, { ...legacyFields, ...repairFields, ...stateFields(desired),
      ...(desired.reason === "superseded" && current ? { superseded_by_skill_id: current.id } : {}) }, memory.updatedAt);
    if (desired.reason !== "superseded") delete next.properties.internal_info.superseded_by_skill_id;
    if (!desired.reason) delete next.properties.internal_info.archive_reason;
    if (!desired.sourceState) delete next.properties.internal_info.source_state;
    next = { ...next, status: desired.status, properties: { ...next.properties, status: desired.status } };
    next = withFixedImportEta(next);
    const restricted = disconnected || desiredIdentityOnly(desired)
      || next.properties.internal_info.source_kind === "plugin"
      || hasRestrictedImportedSkillContent(next);
    if (restricted || isIdentityOnlyImportedSkill(next)) {
      if (restricted || !importedSkillBodyMatchesSource(next)) next = stripBody(next, memory.updatedAt);
      this.clearSkillIndex(memory.id);
    }
    const saved = this.deps.repos.memories.updateMaintenance(next);
    if (restricted || isIdentityOnlyImportedSkill(saved)) this.deps.repos.runtime.scrubImportedSkillCopies(saved.id);
    if (!this.deps.repos.isImportedSkillEligibleForEmbedding(saved)) this.clearSkillIndex(saved.id);
  }

  /**
   * Undoes the user's archive of an imported skill. The record goes back to
   * the state the rest of its source says it should have: superseded when a
   * newer version is current, identity-only when the source Agent marks it
   * user-invoked only, otherwise current again. Archives made by scans
   * (superseded, source missing, ...) are not the user's and are left alone.
   */
  restoreUserArchive(memory: MemoryRow, at: string): MemoryRow {
    return this.deps.repos.transaction(() => this.preparedRestoreUserArchive(this.preparedMemory(memory, at), at));
  }

  private preparedRestoreUserArchive(memory: MemoryRow, at: string): MemoryRow {
    const identity = importedSkillSourceIdentity(memory);
    const versions = this.deps.repos.memories
      .listImportedSkillsForSource(String(memory.properties.internal_info.source_agent_id ?? ""))
      .filter((version) => importedSkillSourceIdentity(version) === identity);
    if (archiveReasonForReconcile(memory, versions) !== "user") return memory;
    const selected = currentImportedSkillVersion(versions);
    if (Number(memory.properties.internal_info.import_state_version ?? 0) < IMPORTED_SKILL_STATE_VERSION) {
      this.migrateLiveRecord(memory, selected, this.isDisconnected(String(memory.properties.internal_info.source_agent_id ?? "")), versions);
      memory = this.deps.repos.memories.get(memory.id) ?? memory;
    }
    const current = selected?.id !== memory.id ? selected : undefined;
    const sourceState = this.sourceState(memory, this.isDisconnected(String(memory.properties.internal_info.source_agent_id ?? "")));
    const desired: DesiredState = current && sourceState !== "source_missing"
      ? { status: "archived", reason: "superseded", ...(sourceState !== "present" ? { sourceState } : {}) }
      : desiredFromSource(sourceState);
    if (desired.status === "archived") {
      this.applyState(memory, desired, at, "agent_skill_user_restored", desired.reason === "superseded" ? current?.id : undefined);
      return this.deps.repos.memories.get(memory.id) ?? memory;
    }
    const internal = { ...memory.properties.internal_info };
    delete internal.archive_reason;
    delete internal.superseded_by_skill_id;
    delete internal.source_state;
    internal.skill = { ...skillRecord(memory), status: "active" };
    const next = applyRetrievalRepresentation({
      ...memory,
      status: "activated",
      properties: { ...memory.properties, status: "activated", internal_info: internal },
      updatedAt: at
    }, memory);
    const saved = this.deps.repos.memories.update(next);
    this.appendChange(saved, memory, "updated", "agent_skill_user_restored", at);
    this.reconcileSkillIndex(saved, at);
    return saved;
  }

  private sourceState(memory: MemoryRow, disconnected: boolean): ImportedSkillSourceState {
    const state = importedSkillSourceState(memory);
    if (state === "source_missing") return state;
    if (disconnected) return "disconnected";
    return state === "disconnected" ? "scan_pending" : state;
  }

  /** Whether this Agent's skills were archived because the user disconnected it. */
  isDisconnected(sourceAgentId: string): boolean {
    return this.deps.repos.isAgentSkillSourceDisconnected(sourceAgentId);
  }

  connectionState(sourceAgentId: string): AgentSkillConnectionState | undefined {
    const state = this.deps.repos.runtime.getKv(agentSkillConnectionKey(sourceAgentId))?.value;
    return state === "connected" || state === "disconnected" ? state : undefined;
  }

  connectionEvent(sourceAgentId: string): AgentSkillConnectionEvent | undefined {
    const value = this.deps.repos.runtime.getKv(`${agentSkillConnectionKey(sourceAgentId)}:event`)?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const event = value as Record<string, unknown>;
    if (typeof event.id !== "string" || !event.id.trim()
      || event.state !== "connected" && event.state !== "disconnected"
      || event.kind !== undefined && event.kind !== "skill" && event.kind !== "plugin"
      || event.revision !== undefined && (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision < 1)) return undefined;
    return { id: event.id, state: event.state, ...(event.kind === "skill" || event.kind === "plugin" ? { kind: event.kind } : {}),
      ...(typeof event.revision === "number" ? { revision: event.revision } : {}) };
  }

  /** Records the user's own archive so later scans keep it. */
  markUserArchived(memory: MemoryRow, at: string): MemoryRow {
    return this.deps.repos.transaction(() => this.preparedMarkUserArchived(this.preparedMemory(memory, at), at));
  }

  private preparedMarkUserArchived(memory: MemoryRow, at: string): MemoryRow {
    const versions = this.deps.repos.memories.listImportedSkillsForSource(String(memory.properties.internal_info.source_agent_id ?? ""))
      .filter(version => importedSkillSourceIdentity(version) === importedSkillSourceIdentity(memory));
    const ambiguous = isUnverifiedLegacySkillCollision(memory);
    if (!ambiguous && isHistoricalImportedSkill(memory, versions)) return this.deps.repos.memories.update(withImportFields(memory, { archive_reason: "superseded" }, at));
    const sourceState = this.sourceState(memory, this.isDisconnected(String(memory.properties.internal_info.source_agent_id ?? "")));
    const desired = desiredFromSource(sourceState, true);
    const base = desiredIdentityOnly(desired) ? stripBody(memory, at) : memory;
    const current = withImportFields(base, {
      archive_reason: "user",
      source_state: sourceState,
      skill: { ...skillRecord(base), status: "archived" }
    }, at);
    if (!ambiguous) delete current.properties.internal_info.superseded_by_skill_id;
    if (!ambiguous) this.supersedeOtherVersions(memory.id, versions, desired, at);
    const saved = this.deps.repos.memories.update(current);
    this.reconcileSkillIndex(saved, at);
    return saved;
  }

  /**
   * Strips the skill body before the record is soft-deleted. Only the source
   * identity stays, which is what stops the next scan from importing it again.
   */
  stripBeforeDelete(memory: MemoryRow, at: string): MemoryRow {
    return this.deps.repos.transaction(() => this.preparedStripBeforeDelete(this.preparedMemory(memory, at), at));
  }

  private preparedStripBeforeDelete(memory: MemoryRow, at: string): MemoryRow {
    const sourceAgentId = String(memory.properties.internal_info.source_agent_id ?? "");
    this.seedInstallations(sourceAgentId, at);
    this.recordConnection({ sourceAgentId, complete: false, skills: [] }, at);
    for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(memory.id, field);
    // Deleting the version the source currently has means "do not import this
    // skill again"; deleting an old, superseded version only removes that one.
    const versions = this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId)
      .filter(version => importedSkillSourceIdentity(version) === importedSkillSourceIdentity(memory));
    const reason = importedSkillArchiveReason(memory);
    const ambiguous = isUnverifiedLegacySkillCollision(memory);
    const deletedCurrent = !ambiguous && reason !== "source_missing" && memory.properties.internal_info.source_state !== "source_missing"
      && !isHistoricalImportedSkill(memory, versions);
    const stripped = withImportFields(stripBody(memory, at), {
      import_state_version: IMPORTED_SKILL_STATE_VERSION, deleted_current: deletedCurrent
    }, at);
    if (!ambiguous && !isHistoricalImportedSkill(memory, versions)) {
      this.supersedeOtherVersions(memory.id, versions, { status: "archived" }, at);
      delete stripped.properties.internal_info.superseded_by_skill_id;
      if (reason === "superseded") delete stripped.properties.internal_info.archive_reason;
    }
    return this.deps.repos.memories.update(stripped);
  }

  /** Adapts memory.add's key, namespace and caller metadata to a source observation. */
  upsertMemoryAdd(memory: MemoryRow, at: string, options: ImportedSkillMemoryAddOptions = {}): { memory: MemoryRow; created: boolean; previous?: MemoryRow } {
    return this.deps.repos.transaction(() => {
      this.prepareSource(String(memory.properties.internal_info.source_agent_id ?? ""), at);
      return this.upsertPreparedMemoryAdd(memory, at, options);
    });
  }

  private upsertPreparedMemoryAdd(memory: MemoryRow, at: string, options: ImportedSkillMemoryAddOptions): { memory: MemoryRow; created: boolean; previous?: MemoryRow } {
    const internal = memory.properties.internal_info;
    const sourceAgentId = normalizeAgentIdKey(String(internal.source_agent_id));
    let all = this.deps.repos.memories.listImportedSkillsForSource(sourceAgentId);
    const explicitId = String(internal.source_skill_id ?? "");
    const suppliedPath = String(internal.source_skill_path ?? "");
    const occupied = memory.memoryKey ? this.deps.repos.memories.getByKeyIncludingDeleted("Skill", memory.memoryKey) : undefined;
    const byKey = occupied && compatibleObservationSource(occupied, sourceAgentId, explicitId, suppliedPath) ? occupied : undefined;
    const legacyTitles = new Set([String(memory.info.title),
      ...(!options.titleProvided ? [firstLine(sanitizeMemmyProtocolText(memory.memoryValue)).slice(0, 120) || "Untitled memory"] : [])]);
    const legacyManualKeys = new Set([...legacyTitles].flatMap(title =>
      [memory.memoryValue, sanitizeMemmyProtocolText(memory.memoryValue)]
        .map(content => `manual:${stableHash(`Skill:${title}:${content}`).slice(0, 20)}`)));
    const legacyManual = !byKey && memory.memoryKey?.startsWith("manual:")
      ? [...legacyManualKeys].map(key => this.deps.repos.memories.getByKeyIncludingDeleted("Skill", key))
        .find((candidate): candidate is MemoryRow => candidate !== undefined
          && compatibleObservationSource(candidate, sourceAgentId, explicitId, suppliedPath)
          && importedSkillMatchesContent(candidate, memory.memoryValue, String(internal.source_content_hash)))
      : undefined;
    const anchor = byKey ?? legacyManual;
    // An old adapter/request or turn key can identify a source observation,
    // but never proves that two different raw bodies are the same version.
    const anchoredId = explicitId || String(anchor?.properties.internal_info.source_skill_id ?? "");
    const anchoredPath = suppliedPath || String(anchor?.properties.internal_info.source_skill_path ?? "");
    const virtualKey = !anchoredId && !anchoredPath
      ? String(anchor?.properties.internal_info.source_skill_key || anchor?.memoryKey || memory.memoryKey || memory.id) : undefined;
    if (anchor && virtualKey && !anchor.properties.internal_info.source_skill_key) {
      const aligned = withImportFields(anchor, { source_skill_key: virtualKey }, anchor.updatedAt);
      if (isDeleted(anchor)) this.deps.repos.memories.rewriteDeletedRow(aligned);
      else this.deps.repos.memories.updateMaintenance(aligned);
      all = all.map(version => version.id === anchor.id ? aligned : version);
    }
    const versions = observationVersions(all, anchoredId || virtualKey || "", anchoredPath, anchor?.id);
    const current = currentImportedSkillVersion(versions);
    const currentInternal = current?.properties.internal_info;
    const invocation = currentInternal?.invocation;
    const policy = invocation && typeof invocation === "object" && !Array.isArray(invocation) ? invocation as Record<string, unknown> : {};
    const knownId = versions.find(version => version.properties.internal_info.source_skill_id)?.properties.internal_info.source_skill_id;
    const path = suppliedPath || String(currentInternal?.source_skill_path || anchoredPath);
    const samePolicySource = path === String(currentInternal?.source_skill_path ?? "");
    const policyObserved = samePolicySource && policy.policy_observed === true;
    const ambiguousVersions = versions.filter(isUnverifiedLegacySkillCollision);
    const reviewedAfterCollision = current && policyObserved && importedSkillSourceState(current) === "present"
      && ambiguousVersions.every(version => version.properties.internal_info.superseded_by_skill_id === current.id);
    const sourceReviewRequired = ambiguousVersions.length > 0 && !reviewedAfterCollision;
    const parsedName = frontmatterString(parseSkillFrontmatter(memory.memoryValue).data, "name");
    const frontmatterName = parsedName && normalizeSkillName(parsedName) ? parsedName : undefined;
    const skill = normalizeSkillObservation({
      sourceSkillId: explicitId || String(knownId || path || virtualKey || anchor?.id || memory.id),
      sourceSkillPath: path,
      title: options.titleProvided ? String(memory.info.title)
        : frontmatterName || String(current?.info.title || memory.info.title || internal.name || ""),
      content: memory.memoryValue,
      contentHash: String(internal.source_content_hash),
      modifiedAt: typeof internal.source_modified_at === "string" ? internal.source_modified_at
        : typeof currentInternal?.source_modified_at === "string" ? currentInternal.source_modified_at
          : current?.timeline ?? memory.timeline ?? memory.createdAt,
      version: typeof internal.source_skill_version === "string" ? internal.source_skill_version : undefined,
      // Direct requests do not observe supporting files or Codex's sidecar policy.
      hasSupportingFiles: currentInternal?.has_supporting_files === true,
      ...(typeof policy.allow_implicit_invocation === "boolean" && (samePolicySource || policy.allow_implicit_invocation === false)
        ? { allowImplicitInvocation: policy.allow_implicit_invocation } : {}),
      ...(typeof currentInternal?.policy_error === "string" ? { policyError: currentInternal.policy_error } : {})
    });
    const observation = { sourceAgentId, complete: false, skills: [skill] };
    this.recordConnection(observation, at);
    this.recordInstallations(observation, at);
    const sameBody = anchor && importedSkillMatchesContent(anchor, memory.memoryValue, String(internal.source_content_hash));
    const key = sameBody && anchor.memoryKey ? anchor.memoryKey : occupied
      ? memoryAddKey({ content: skill.content, sourceAgentId, sourceSkillId: skill.sourceSkillId }, "Skill", skill.title)
      : memory.memoryKey;
    const direct = { ...memory, memoryKey: key,
      tags: options.tagsProvided ? memory.tags : [...new Set([...(anchor?.tags ?? current?.tags ?? []), ...memory.tags])],
      properties: { ...memory.properties, internal_info: {
      ...internal, ...(virtualKey ? { source_skill_key: virtualKey } : {}),
      ...(sourceReviewRequired ? { source_review_required: true } : {})
    } } };
    return this.observeSkill(sourceAgentId, memory.userId, skill, versions, this.isDisconnected(sourceAgentId), at, direct, policyObserved);
  }

  private reconcileSkill(
    sourceAgentId: string,
    userId: string,
    skill: AgentSkillReconcileSkill,
    versions: MemoryRow[],
    disconnected: boolean,
    at: string
  ): AgentSkillReconcileResult["skills"][number] {
    const result = this.observeSkill(sourceAgentId, userId, skill, versions, disconnected, at);
    return { sourceSkillId: skill.sourceSkillId, outcome: result.outcome,
      ...(result.outcome === "deleted_by_user" ? {} : { memoryId: result.memory.id }) };
  }

  private observeSkill(
    sourceAgentId: string,
    userId: string,
    skill: AgentSkillReconcileSkill,
    versions: MemoryRow[],
    disconnected: boolean,
    at: string,
    direct?: MemoryRow,
    policyObserved = direct === undefined
  ): { memory: MemoryRow; created: boolean; previous?: MemoryRow; outcome: AgentSkillReconcileOutcome } {
    const known = currentImportedSkillVersion(versions);
    if (skill.frontmatterError && known && typeof known.info.title === "string") skill = { ...skill, title: known.info.title };
    // An exact path may bridge an older path-only identity. Different explicit
    // directory ids keep their own lifecycle even when their paths coincide.
    versions = versions.map(version => {
      if (version.properties.internal_info.source_skill_id || !skill.sourceSkillPath
        || version.properties.internal_info.source_skill_path !== skill.sourceSkillPath
        || skill.sourceSkillId === skill.sourceSkillPath) return version;
      const aligned = withImportFields(version, { source_skill_id: skill.sourceSkillId }, version.updatedAt);
      if (isDeleted(version)) this.deps.repos.memories.rewriteDeletedRow(aligned);
      else this.deps.repos.memories.updateMaintenance(aligned);
      return aligned;
    });
    const blocked = deletedCurrentVersion(versions);
    if (blocked) return { memory: blocked, created: false, previous: blocked, outcome: "deleted_by_user" };
    const key = direct?.memoryKey ?? memoryAddKey({ content: skill.content, layer: "Skill", sourceAgentId,
      sourceSkillId: skill.sourceSkillId, sourceContentHash: skill.contentHash }, "Skill", skill.title);
    const matching = versions.filter(version => importedSkillMatchesContent(version, skill.content, skill.contentHash));
    const existing = matching.find(isDeleted)
      ?? matching.find(version => version.memoryKey === key)
      ?? matching.find(version => version.id === known?.id)
      ?? matching[0];
    if (existing && isDeleted(existing)) {
      const active = versions.filter(version => version.status === "activated" || version.status === "resolving");
      this.supersedeOtherVersions(existing.id, active, { status: "archived", reason: "superseded" }, at);
      return { memory: existing, created: false, previous: existing, outcome: "deleted_by_user" };
    }
    const live = versions.filter(version => !isDeleted(version));
    const template = direct ?? existing ?? this.deps.buildMemory({
      userId, agentId: sourceAgentId, layer: "Skill", kind: "skill", memoryType: "SkillMemory", key,
      value: skill.content, tags: ["agent-source", "cross-agent-skill", sourceAgentId],
      info: { title: skill.title, source: sourceAgentId, turn_id: `skill:${skill.sourceSkillId}:${skill.contentHash}`, ...importedSkillInfoFields(skill.title) },
      internal: { source: sourceAgentId, title: skill.title }, createdAt: skill.modifiedAt
    });
    // A source observation supplies new body/policy facts; user archive and
    // supersession are projected separately after those facts are resolved.
    const evidence = withImportFields({ ...template, memoryValue: skill.content }, {
      ...scanFields(skill, policyObserved), source_agent_id: sourceAgentId,
      source_raw_content_hash: importedSkillContentHash(skill.content),
      source_state: undefined, archive_reason: undefined,
      source_review_required: direct?.properties.internal_info.source_review_required === true ? true : undefined
    }, at);
    const desired = desiredState(evidence, live, disconnected, existing?.id);
    const persisted = this.persistVersion(sourceAgentId, skill, desired, at, template, policyObserved, existing, direct);
    this.supersedeOtherVersions(persisted.memory.id, live, desired, at);
    return persisted;
  }

  private supersedeOtherVersions(currentId: string, versions: readonly MemoryRow[], desired: DesiredState, at: string): void {
    for (const version of versions) {
      if (version.id === currentId || isDeleted(version)) continue;
      const sourceState = desiredIdentityOnly(desired) ? desired.sourceState ?? desired.reason as DesiredState["sourceState"] : undefined;
      if (version.status === "archived" && importedSkillArchiveReason(version) === "superseded"
        && version.properties.internal_info.superseded_by_skill_id === currentId
        && (!sourceState || version.properties.internal_info.source_state === sourceState && !version.memoryValue)) continue;
      this.applyState(version, { status: "archived", reason: "superseded", sourceState }, at, "read_only_skill_superseded", currentId);
    }
  }

  private persistVersion(
    sourceAgentId: string,
    skill: AgentSkillReconcileSkill,
    desired: DesiredState,
    at: string,
    template: MemoryRow,
    policyObserved: boolean,
    existing?: MemoryRow,
    direct?: MemoryRow
  ): { memory: MemoryRow; created: boolean; previous?: MemoryRow; outcome: AgentSkillReconcileOutcome } {
    const restricted = desiredIdentityOnly(desired);
    const content = restricted ? "" : skill.content;
    const summary = content.trim() ? skillSummary(skill) : "";
    const previousInternal = existing?.properties.internal_info;
    const sourceSkillId = direct
      ? String(direct.properties.internal_info.source_skill_id || previousInternal?.source_skill_id || "") || undefined
      : skill.sourceSkillId;
    const fields = importedSkillInternalFields({
      sourceAgentId: String(previousInternal?.source_agent_id ?? direct?.properties.internal_info.source_agent_id ?? sourceAgentId),
      sourceSkillId, sourceSkillPath: skill.sourceSkillPath || undefined,
      sourceSkillVersion: skill.version ?? (typeof previousInternal?.source_skill_version === "string" ? previousInternal.source_skill_version : skill.contentHash),
      sourceContentHash: existing && importedSkillMatchesContent(existing, skill.content, skill.contentHash)
        ? String(previousInternal?.source_content_hash ?? skill.contentHash) : skill.contentHash,
      importedAt: typeof previousInternal?.imported_at === "string" ? previousInternal.imported_at : at,
      title: skill.title, content, skillStatus: desired.status === "activated" ? "active" : "archived"
    });
    const tags = direct ? template.tags : [...new Set([...(existing?.tags ?? []), ...template.tags])];
    const info = { ...existing?.info, ...template.info, title: skill.title, summary, tags, ...importedSkillInfoFields(skill.title) };
    const internal: MemoryRow["properties"]["internal_info"] = { ...previousInternal, ...template.properties.internal_info, ...fields,
      ...scanFields(skill, policyObserved), ...stateFields(desired), title: skill.title, summary,
      source_review_required: direct?.properties.internal_info.source_review_required === true ? true : undefined,
      source_raw_content_hash: importedSkillContentHash(skill.content),
      skill: { ...fields.skill as Record<string, unknown>, ...skillRecord(existing ?? template),
        name: skill.title, status: desired.status === "activated" ? "active" : "archived", eta: 0.5 }
    };
    delete internal.superseded_by_skill_id;
    if (!desired.reason) delete internal.archive_reason;
    if (!desired.sourceState) delete internal.source_state;
    let next: MemoryRow = {
      ...template, ...(existing ? { id: existing.id, createdAt: existing.createdAt, version: existing.version,
        memoryKey: existing.memoryKey, timeline: skill.modifiedAt,
        conversationId: direct?.conversationId ?? existing.conversationId, sessionId: direct?.sessionId ?? existing.sessionId,
        appId: direct?.appId ?? existing.appId } : {}),
      status: desired.status, memoryValue: content, tags, info,
      properties: { ...existing?.properties, ...template.properties, status: desired.status, tags,
        info: { ...existing?.properties.info, ...template.properties.info, ...info }, internal_info: internal },
      contentHash: importedSkillContentHash(content), updatedAt: at
    };
    if (restricted) next = stripBody(next, at);
    next = applyRetrievalRepresentation(next, existing);
    const unchanged = existing && isUnchanged(existing, skill, desired);
    if (unchanged) {
      const maintenance = { ...next, updatedAt: existing.updatedAt };
      const metadataChanged = JSON.stringify(existing.info) !== JSON.stringify(maintenance.info)
        || JSON.stringify(existing.properties) !== JSON.stringify(maintenance.properties)
        || JSON.stringify(existing.tags) !== JSON.stringify(maintenance.tags)
        || existing.timeline !== maintenance.timeline
        || existing.sessionId !== maintenance.sessionId || existing.conversationId !== maintenance.conversationId || existing.appId !== maintenance.appId;
      const saved = metadataChanged ? this.deps.repos.memories.updateMaintenance(maintenance) : existing;
      if (restricted) this.deps.repos.runtime.scrubImportedSkillCopies(saved.id);
      this.reconcileSkillIndex(saved, at);
      return { memory: saved, created: false, previous: existing, outcome: "unchanged" };
    }
    const saved = existing ? this.deps.repos.memories.update(next) : this.deps.repos.memories.insert(next);
    this.appendChange(saved, existing, existing ? "updated" : "created", existing ? "update" : "create", at);
    if (restricted) this.deps.repos.runtime.scrubImportedSkillCopies(saved.id);
    this.reconcileSkillIndex(saved, at);
    return { memory: saved, created: !existing, previous: existing, outcome: existing ? "updated" : "created" };
  }

  private applyState(memory: MemoryRow, desired: DesiredState, at: string, changeType: string, supersededBy?: string, previous: MemoryRow = memory): void {
    const restricted = desiredIdentityOnly(desired)
      || memory.properties.internal_info.source_kind === "plugin"
      || hasRestrictedImportedSkillContent(memory);
    const identityOnly = restricted || !memory.memoryValue.trim();
    const stripContent = restricted || (identityOnly && !importedSkillBodyMatchesSource(memory));
    const base = stripContent ? stripBody(memory, at) : memory;
    const next = withImportFields({ ...base, status: desired.status, properties: { ...base.properties, status: desired.status } }, {
      ...stateFields(desired),
      ...(supersededBy !== undefined ? { superseded_by_skill_id: supersededBy } : {}),
      skill: { ...skillRecord(base), status: desired.status === "activated" ? "active" : "archived" }
    }, at);
    if (!desired.reason) delete next.properties.internal_info.archive_reason;
    if (!desired.sourceState) delete next.properties.internal_info.source_state;
    if (supersededBy === undefined) delete next.properties.internal_info.superseded_by_skill_id;
    const saved = this.deps.repos.memories.update(applyRetrievalRepresentation(next, memory));
    this.reconcileSkillIndex(saved, at);
    this.appendChange(saved, previous, "archived", changeType, at);
    if (restricted) this.deps.repos.runtime.scrubImportedSkillCopies(saved.id);
  }

  /** Representation metadata alone does not invalidate a current vector or owned retry. */
  private reconcileSkillIndex(memory: MemoryRow, at: string): void {
    if (!this.deps.repos.isImportedSkillEligibleForEmbedding(memory)) {
      this.clearSkillIndex(memory.id);
      return;
    }
    const retry = this.deps.repos.runtime.getEmbeddingRetryByTarget("skill", memory.id, "vec");
    const staleRetry = retry !== undefined && retry.sourceText !== retrievalDocumentForMemory(memory);
    const current = retrievalDocumentIsCurrent(memory);
    if (!current) {
      for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(memory.id, field);
    }
    if (staleRetry) this.deps.repos.runtime.deleteEmbeddingRetriesForMemory(memory.id);
    const retryNeedsRequeue = staleRetry && retry?.status !== "succeeded";
    if (!current || !this.deps.repos.memories.hasVector(memory.id, "vec") || retryNeedsRequeue) {
      this.enqueueEmbedding(memory, at);
    }
  }

  private clearSkillIndex(memoryId: string): void {
    this.deps.repos.runtime.invalidateImportedSkillResponseCopies(memoryId);
    for (const field of SKILL_VECTOR_FIELDS) this.deps.repos.memories.deleteVector(memoryId, field);
    this.deps.repos.runtime.deleteEmbeddingRetriesForMemory(memoryId);
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
    if (!this.deps.embedAfterCapture() || !this.deps.repos.isImportedSkillEligibleForEmbedding(memory) || this.deps.repos.runtime.hasPendingJob(memory.id, "embedding")) return;
    const retry = this.deps.repos.runtime.getEmbeddingRetryByTarget("skill", memory.id, "vec");
    // Matching work keeps its lease, backoff and terminal policy, including
    // model migration work that does not change the document's representation.
    if (retry && retry.status !== "succeeded" && retry.sourceText === retrievalDocumentForMemory(memory)) return;
    this.deps.enqueueJob({
      jobType: "embedding",
      userId: memory.userId,
      sessionId: memory.sessionId,
      targetMemoryId: memory.id,
      payload: { source: RECONCILE_SOURCE, retrievalSourceHash: retrievalDocumentSourceHash(memory) },
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

/** Source policy and descriptions always come from the same parser for both adapters. */
function normalizeSkillObservation(skill: AgentSkillReconcileSkill): AgentSkillReconcileSkill {
  const frontmatter = parseSkillFrontmatter(skill.content);
  return { ...skill,
    contentHash: skill.contentHash?.trim() || importedSkillContentHash(skill.content),
    description: frontmatterString(frontmatter.data, "description") || skill.description?.trim(),
    disableModelInvocation: skill.disableModelInvocation === true || frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true,
    ...(frontmatter.error ? { frontmatterError: frontmatter.error } : {})
  };
}

/** Exact paths bridge path-only imports without merging different explicit directories. */
function observationVersions(memories: readonly MemoryRow[], sourceSkillId: string, path: string, previousId?: string): MemoryRow[] {
  const previous = memories.find(memory => memory.id === previousId);
  const pathIds = new Set(memories.filter(memory => path && memory.properties.internal_info.source_skill_path === path)
    .map(memory => memory.properties.internal_info.source_skill_id).filter((value): value is string => typeof value === "string" && Boolean(value)));
  const knownId = sourceSkillId || String(previous?.properties.internal_info.source_skill_id || (pathIds.size === 1 ? [...pathIds][0] : ""));
  const identities = new Set<string>(knownId ? [knownId] : path ? [path] : []);
  const bridgePath = pathIds.size <= 1 && (pathIds.size === 0 || pathIds.has(knownId));
  for (const memory of memories) {
    const internal = memory.properties.internal_info;
    if (memory.id === previousId || bridgePath && path && internal.source_skill_path === path
      && (!internal.source_skill_id || internal.source_skill_id === knownId)) identities.add(importedSkillSourceIdentity(memory));
  }
  return memories.filter(memory => identities.has(importedSkillSourceIdentity(memory)) || memory.id === previousId);
}

/** A legacy key is usable only within a compatible source, before raw matching. */
function compatibleObservationSource(memory: MemoryRow, sourceAgentId: string, sourceSkillId: string, path: string): boolean {
  const internal = memory.properties.internal_info;
  if (normalizeAgentIdKey(String(internal.source_agent_id ?? "")) !== sourceAgentId) return false;
  if (sourceSkillId && internal.source_skill_id) return sourceSkillId === internal.source_skill_id;
  return !path || !internal.source_skill_path || path === internal.source_skill_path;
}

/** One representation transform for creation, rewriting, direct observations and startup repair. */
function applyRetrievalRepresentation(memory: MemoryRow, previous?: MemoryRow): MemoryRow {
  const frontmatter = parseSkillFrontmatter(memory.memoryValue);
  const internal = memory.properties.internal_info;
  const description = frontmatterString(frontmatter.data, "description")
    ?? (typeof internal.skill_description === "string" ? internal.skill_description : undefined);
  const hasBody = memory.memoryValue.trim().length > 0 && !isIdentityOnlyImportedSkill(memory);
  const summary = hasBody ? skillSummary({ description, title: String(memory.info.title ?? internal.name ?? "") }) : "";
  const blurb = hasBody ? description?.trim() || undefined : undefined;
  const next = withRetrievalText(memory, blurb, summary);
  return withImportFields(next, retrievalFields(previous, previous ? existingRetrievalBlurb(previous) : undefined), memory.updatedAt);
}

/** Reconciliation can run before startup has marked legacy user archives. */
function archiveReasonForReconcile(memory: MemoryRow, versions: readonly MemoryRow[] = []): ImportedSkillArchiveReason | undefined {
  const stale = hasStaleImportedSkillSupersession(memory, versions);
  const storedReason = importedSkillArchiveReason(memory);
  const reason = stale && storedReason === "superseded" ? undefined : storedReason;
  if (reason !== undefined || memory.status !== "archived") return reason;
  const internal = memory.properties.internal_info;
  if (Number(internal.import_state_version ?? 0) < IMPORTED_SKILL_STATE_VERSION) {
    return !stale && typeof internal.superseded_by_skill_id === "string" ? "superseded" : "user";
  }
  return undefined;
}

function desiredFromSource(sourceState: ImportedSkillSourceState, userArchived = false): DesiredState {
  if (userArchived) return { status: "archived", reason: "user", sourceState };
  return sourceState === "present" ? { status: "activated" } : { status: "archived", reason: sourceState };
}

/** History repair removes only proven false edges; remaining markers stay historical. */
function desiredFromRepairedSource(memory: MemoryRow, sourceState: ImportedSkillSourceState): DesiredState {
  const reason = importedSkillArchiveReason(memory);
  if (reason === "user") return desiredFromSource(sourceState, true);
  if (reason === "superseded" || typeof memory.properties.internal_info.superseded_by_skill_id === "string") {
    return { status: "archived", reason: "superseded", ...(sourceState !== "present" ? { sourceState } : {}) };
  }
  return desiredFromSource(sourceState);
}

function desiredState(memory: MemoryRow, versions: readonly MemoryRow[], disconnected: boolean, existingId?: string): DesiredState {
  const sourceState = disconnected ? "disconnected" : importedSkillSourceState(memory);
  const userArchived = versions.some(version => !isDeleted(version) && archiveReasonForReconcile(version, versions) === "user"
    && (!isUnverifiedLegacySkillCollision(version) || version.id === existingId));
  return desiredFromSource(sourceState, userArchived);
}

function desiredIdentityOnly(desired: DesiredState): boolean {
  return isIdentityOnlyReason(desired.reason) || isIdentityOnlyReason(desired.sourceState === "present" ? undefined : desired.sourceState);
}

function withFixedImportEta(memory: MemoryRow): MemoryRow {
  return {
    ...memory,
    info: { ...memory.info, eta: 0.5 },
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        eta: 0.5,
        skill: { ...skillRecord(memory), eta: 0.5 }
      }
    }
  };
}

function isUnchanged(existing: MemoryRow, skill: AgentSkillReconcileSkill, desired: DesiredState): boolean {
  const internal = existing.properties.internal_info;
  if (internal.import_state_version !== IMPORTED_SKILL_STATE_VERSION) return false;
  if (existing.info.title !== skill.title || internal.normalized_name !== normalizeSkillName(skill.title)) return false;
  if (internal.retrieval_representation_version !== IMPORTED_SKILL_RETRIEVAL_VERSION) return false;
  if (!importedSkillMatchesContent(existing, skill.content, skill.contentHash)) return false;
  if (internal.source_raw_content_hash !== importedSkillContentHash(skill.content)) return false;
  if (existing.status !== desired.status || importedSkillArchiveReason(existing) !== desired.reason) return false;
  if ((internal.source_state ?? undefined) !== desired.sourceState) return false;
  if (internal.superseded_by_skill_id !== undefined) return false;
  const expectedBody = desiredIdentityOnly(desired) ? "" : skill.content;
  const summary = expectedBody.trim() ? skillSummary(skill) : "";
  if (existing.info.summary !== summary || internal.summary !== summary) return false;
  const blurb = expectedBody.trim() ? skill.description?.trim() || null : null;
  if (existingRetrievalBlurb(existing) !== blurb) return false;
  const compact = withoutImportedSkillBodyCopies(existing);
  if (expectedBody.trim() && JSON.stringify(compact.properties) !== JSON.stringify(existing.properties)) return false;
  return existing.memoryValue === expectedBody;
}

/** Fields that describe the scanned file; they never trigger a rewrite on their own. */
function scanFields(skill: AgentSkillReconcileSkill, policyObserved: boolean): Record<string, unknown> {
  return {
    source_kind: "file",
    normalized_name: normalizeSkillName(skill.title),
    source_modified_at: skill.modifiedAt,
    skill_description: skill.description ?? null,
    has_supporting_files: skill.hasSupportingFiles === true,
    invocation: {
      ...(policyObserved ? { policy_observed: true } : {}),
      disable_model_invocation: skill.disableModelInvocation === true,
      ...(skill.allowImplicitInvocation === undefined ? {} : { allow_implicit_invocation: skill.allowImplicitInvocation })
    },
    policy_error: skill.policyError ?? null,
    frontmatter_error: skill.frontmatterError ?? null
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
  return stripImportedSkillBody(memory, at);
}

function skillRecord(memory: MemoryRow): Record<string, unknown> {
  const skill = memory.properties.internal_info.skill;
  return typeof skill === "object" && skill !== null && !Array.isArray(skill) ? skill as Record<string, unknown> : {};
}

function groupBySourceIdentity(memories: readonly MemoryRow[]): Map<string, MemoryRow[]> {
  const groups = new Map<string, MemoryRow[]>();
  for (const memory of memories) {
    const identity = importedSkillSourceIdentity(memory);
    const group = groups.get(identity) ?? [];
    group.push(memory);
    groups.set(identity, group);
  }
  return groups;
}

function isRegistrationGroup(versions: readonly MemoryRow[]): boolean {
  return versions.some((version) => version.properties.internal_info.source_kind === "plugin");
}

function deletedCurrentVersion(versions: readonly MemoryRow[]): MemoryRow | undefined {
  return versions.find(version => isDeleted(version) && version.properties.internal_info.deleted_current !== false
    && importedSkillArchiveReason(version) !== "source_missing"
    && version.properties.internal_info.source_state !== "source_missing"
    && !isHistoricalImportedSkill(version, versions));
}

function isDeleted(memory: MemoryRow): boolean {
  return Boolean(memory.deletedAt) || memory.status === "deleted";
}

/** The summary shown for an imported skill: its frontmatter description, else its name. */
function skillSummary(skill: Pick<AgentSkillReconcileSkill, "description" | "title">): string {
  return skill.description?.trim() || skill.title;
}

function existingRetrievalBlurb(memory: MemoryRow): string | null {
  const procedure = skillRecord(memory).procedure_json;
  const blurb = procedure && typeof procedure === "object" && !Array.isArray(procedure)
    ? (procedure as Record<string, unknown>).retrievalBlurb
    : undefined;
  return typeof blurb === "string" ? blurb : null;
}

/**
 * Marks the current description metadata/retrieval representation and remembers
 * values from before the first upgrade so display metadata can be restored.
 */
function retrievalFields(existing: MemoryRow | undefined, previousBlurb: string | null | undefined): Record<string, unknown> {
  const internal = existing?.properties.internal_info;
  const alreadyUpgraded = Number(internal?.retrieval_representation_version ?? 0) >= 1;
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

/** Sets (or removes, when undefined) the retrieval blurb and sets the summary everywhere they are stored. */
function withRetrievalText(memory: MemoryRow, blurb: string | undefined, summary: string): MemoryRow {
  if (!isIdentityOnlyImportedSkill(memory)) memory = withoutImportedSkillBodyCopies(memory);
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
