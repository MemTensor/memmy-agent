import { dirname, basename } from "node:path";
import { frontmatterString, parseSkillFrontmatter } from "@memmy/agent-source-core";
import { hasImportedSkillSourceEvidence, importedSkillContentHash, normalizeSkillName } from "../../storage/imported-skill.js";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { EvolutionJobRecord,SessionRecord } from "../../storage/repositories.js";
import type {
  JobRef,
  JobType,
  MemoryAddRequest,
  MemoryKind,
  MemoryLayer,
  MemoryProcessingRecord,
  MemoryRow,
  MemoryStatus,
  MemoryProcessingState as ProcessingState,
  RequestEnvelope
} from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { normalizeAgentIdKey } from "../../utils/agent-source-id.js";
import { sanitizeMemmyProtocolText } from "../../utils/memmy-context-tags.js";
import { clip, firstLine } from "../../utils/text.js";
import { turnJudgeJobFlags } from "../evolution/turn-judge.js";
import { isObservationMemory, observationJobPayload } from "../observation-memory-state.js";
import { externalSkillJobPayload } from "../evidence/history-skill-policy.js";
import { canRetryMemoryProcessing, isManualRecoveryCandidate, processingWithRetryAction } from "./processing-retry-policy.js";
import { importedSkillInfoFields, importedSkillInternalFields, isImportedSkillObservation, skillInternalFields, type ImportedSkillMemoryAddOptions } from "./memory-import-pipeline.js";



export interface TraceMeta {
  summary?: string;
  userText?: string;
  agentText?: string;
  toolCalls: Array<{ name: string; input?: unknown; output?: unknown; error?: string }>;
}

export const IMPORT_SUMMARY_QUEUED_TAG = "摘要排队中";
export const IMPORT_STATUS_TAGS = [
  IMPORT_SUMMARY_QUEUED_TAG,
  "摘要整理中",
  "摘要总结中",
  "建立索引中",
  "索引建立中",
  "索引已建立",
  "处理失败"
] as const;
export const IMPORT_DEFAULT_ALPHA = 0;
export const IMPORT_DEFAULT_VALUE = 0;
export const IMPORT_DEFAULT_PRIORITY = 0.5;

type EnqueueInput = {
  jobType: JobType;
  userId: string;
  sessionId?: string;
  episodeId?: string;
  targetMemoryId?: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  createdAt?: string;
};

/** All former MemoryService collaborators are host-provided. */
export interface ImportJobProcessorDeps {
  config: { algorithm: { enableMemoryAdd: boolean; capture: { embedAfterCapture: boolean } } };
  nowIso(): string;
  transaction<T>(run: () => T): T;
  createError(code: "invalid_argument" | "not_found" | "conflict", message: string): Error;
  assertMemoryAddEnabled(): void;
  assertMemoryInScope(memory: MemoryRow, namespace: unknown): void;
  sanitizeMemoryAddRequest(request: MemoryAddRequest): MemoryAddRequest;
  resolveContext(request: MemoryAddRequest): { userId: string; namespace: { source?: string; projectId?: string; profileId?: string } };
  requireSession(id: string): SessionRecord;
  assertSessionInScope(session: ReturnType<ImportJobProcessorDeps["requireSession"]>, namespace: unknown): void;
  normalizeMemoryAddCreatedAt(value: string | undefined, timeZone?: string): string | undefined;
  memoryAddImportTrace(request: MemoryAddRequest, at: string): Record<string, unknown> | null;
  memoryAddQaPair(request: MemoryAddRequest): { query: string; answer: string } | null;
  memoryCaptureQaHash(query: string, answer: string): string;
  normalizeMemoryCaptureSource(source: string): string;
  isAgentSourceImportMemoryAdd(request: MemoryAddRequest): boolean;
  titleFromImportTrace(trace: Record<string, unknown>): string | undefined;
  memoryAddTags(request: MemoryAddRequest, isImport: boolean, traceTags: string[]): string[];
  memoryAddKey(request: MemoryAddRequest, layer: MemoryLayer, title: string): string;
  toolCallsFromUnknown(value: unknown): TraceMeta["toolCalls"];
  renderTraceMemoryValue(input: {
    summary: string; rawTurnId?: string; stepIndex?: number; userText?: string; agentText?: string;
    toolCalls: TraceMeta["toolCalls"]; reflection: { text: string | null; alpha: number }; value: number; priority: number;
  }): string;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  repairManualSkillsForSource(sourceAgentId: string, at: string): void;
  upsertImportedSkill(memory: MemoryRow, at: string, options?: ImportedSkillMemoryAddOptions): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  kindFromMemory(memory: MemoryRow): string;
  namespaceIdFromMemory(memory: MemoryRow): string;
  enqueueJob(input: EnqueueInput): EvolutionJobRecord;
  jobToRef(job: EvolutionJobRecord): JobRef;
  recordApiLog?(
    operation: "memory_add" | "memory_search" | "skill_generate" | "skill_evolve",
    request: Record<string, unknown>,
    result: Record<string, unknown>,
    latencyMs: number,
    success: boolean,
    at: string,
    agentId?: string
  ): void;
  memories: {
    get(id: string): MemoryRow | undefined;
    getMany(ids: string[], options?: { includeVectors?: boolean }): MemoryRow[];
    getIncludingDeleted(id: string): MemoryRow | undefined;
    getByKeyIncludingDeleted(layer: MemoryLayer, key: string): MemoryRow | undefined;
    getByKey(layer: MemoryLayer, key: string): MemoryRow | undefined;
    updateMaintenance(memory: MemoryRow): MemoryRow;
    upsertByKey(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
    deleteVector(id: string, field: "vec_summary"): void;
    hasVector(id: string, field: "vec_summary"): boolean;
    listPendingAgentSourceImportSummaries(limit: number, ids?: readonly string[]): MemoryRow[];
    listUnprocessedAgentSourceImports(limit: number): MemoryRow[];
    toListItem(memory: MemoryRow): { id: string; kind: MemoryKind; memoryLayer: MemoryLayer; status: MemoryStatus; title: string; summary: string; tags: string[] };
    update(memory: MemoryRow): MemoryRow;
  };
  captureClaims: {
    claim(input: {
      userId: string;
      source: string;
      qaHash: string;
      primaryMemoryId: string;
      capturedBy: "agent_source_scan";
      createdAt: string;
    }): {
      claimed: boolean;
      claim: { primaryMemoryId: string; capturedBy: "turn_complete" | "agent_source_scan" };
    };
  };
  processing: {
    get(memoryId: string): MemoryProcessingRecord | undefined;
    getMany(memoryIds: string[]): MemoryProcessingRecord[];
    listByStates(states: readonly ProcessingState[], limit: number): MemoryProcessingRecord[];
    save(record: MemoryProcessingRecord): MemoryProcessingRecord;
    update(memoryId: string, patch: Partial<Omit<MemoryProcessingRecord, "memoryId">>, expectedStates?: readonly ProcessingState[]): MemoryProcessingRecord | undefined;
  };
  runtime: {
    appendChange(change: Record<string, unknown>): number;
    getJob(id: string): EvolutionJobRecord | undefined;
    latestJobForTarget(targetMemoryId: string, jobType: JobType): { payload: Record<string, unknown> } | undefined;
  };
}

export class ImportJobProcessor {
  constructor(private readonly deps: ImportJobProcessorDeps) {}

  addMemory(request: MemoryAddRequest): {
    id: string; kind: MemoryKind; memoryLayer: MemoryLayer; status: MemoryStatus;
    title: string; summary: string; tags: string[]; createdAt: string; serverTime: string; duplicate?: boolean;
  } {
    const d = this.deps;
    d.assertMemoryAddEnabled();
    const readOnlySkill = isImportedSkillObservation(request);
    const skillContent = request.layer === "Skill" ? request.content : undefined;
    request = d.sanitizeMemoryAddRequest(request);
    const fallbackTitleContent = request.content;
    if (readOnlySkill && skillContent !== undefined) request = { ...request, content: skillContent };
    const startedAt = Date.now();
    const receivedAt = d.nowIso();
    if (!request.content?.trim()) throw d.createError("invalid_argument", "memory.add requires content");

    const context = d.resolveContext(request);
    const session = request.sessionId ? d.requireSession(request.sessionId) : undefined;
    if (session) d.assertSessionInScope(session, request.namespace);

    const layer = request.layer ?? "L1";
    const kind = kindForLayer(layer);
    const at = d.normalizeMemoryAddCreatedAt(request.createdAt, request.timeZone) ?? receivedAt;
    const importTrace = layer === "L1" ? d.memoryAddImportTrace(request, at) : null;
    const sourceAgentId = readOnlySkill
      ? request.sourceAgentId?.trim() || request.source?.trim() || context.namespace.source?.trim()
      : undefined;
    if (readOnlySkill && !sourceAgentId) {
      throw d.createError("invalid_argument", "memory.add Skill requires sourceAgentId or source");
    }
    const agentSourceImport = Boolean(importTrace && d.isAgentSourceImportMemoryAdd(request));
    const importTitle = agentSourceImport && importTrace ? d.titleFromImportTrace(importTrace) : undefined;
    const explicitSkillTitle = Boolean(request.title?.trim() && normalizeSkillName(request.title));
    const parsedName = layer === "Skill" ? frontmatterString(parseSkillFrontmatter(request.content).data, "name") : undefined;
    const sourceTitle = layer === "Skill" ? (parsedName && normalizeSkillName(parsedName) ? parsedName : undefined)
      || (request.sourceSkillId?.trim() ? basename(request.sourceSkillId.trim())
        : request.sourceSkillPath?.trim() ? basename(dirname(request.sourceSkillPath.trim())) : undefined) : undefined;
    const fallbackTitle = firstLine(fallbackTitleContent).slice(0, 120);
    const legacySkillTitle = !explicitSkillTitle
      ? request.title?.trim() || fallbackTitle || "Untitled memory" : undefined;
    const title = importTitle
      ?? (agentSourceImport
        ? `${request.source?.trim() || "Agent"} conversation`
        : (layer === "Skill" && !explicitSkillTitle ? sourceTitle : request.title?.trim())
          || (layer === "Skill" && !normalizeSkillName(fallbackTitle) ? "" : fallbackTitle) || "Untitled memory");
    const importSummary = importTrace ? stringFromRecord(importTrace, "summary") || IMPORT_SUMMARY_QUEUED_TAG : undefined;
    const tags = d.memoryAddTags(request, importTrace !== null, importTrace ? stringArray(importTrace.tags) : []);
    const skillKeySource = sourceAgentId || request.source?.trim() || context.namespace.source?.trim() || "";
    const keyRequest = layer === "Skill" ? { ...request, sourceAgentId: skillKeySource,
      ...(readOnlySkill ? { sourceSkillId: request.sourceSkillId?.trim() || request.turnId?.trim() || undefined } : {}) } : request;
    const memoryKey = d.memoryAddKey(keyRequest, layer, title);
    let memory = d.buildMemory({
      userId: session?.userId ?? context.userId,
      conversationId: session?.conversationId,
      sessionId: session?.id ?? request.sessionId,
      agentId: session?.source ?? request.source?.trim() ?? context.namespace.source,
      appId: session?.workspaceId,
      projectId: session?.projectId ?? context.namespace.projectId,
      profileId: session?.profileId ?? context.namespace.profileId,
      layer, kind, memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory",
      key: memoryKey,
      value: importTrace ? d.renderTraceMemoryValue({
        summary: importSummary ?? IMPORT_SUMMARY_QUEUED_TAG,
        userText: stringFromRecord(importTrace, "user_text"), agentText: stringFromRecord(importTrace, "agent_text"),
        toolCalls: d.toolCallsFromUnknown(importTrace.tool_calls),
        reflection: { text: null, alpha: IMPORT_DEFAULT_ALPHA }, value: IMPORT_DEFAULT_VALUE, priority: IMPORT_DEFAULT_PRIORITY
      }) : request.content,
      tags,
      info: {
        title,
        summary: importSummary ?? firstLine(request.content),
        source: request.source ?? "manual",
        turn_id: request.turnId,
        time_zone: request.timeZone,
        ...(layer === "Skill" ? importedSkillInfoFields(title) : {})
      },
      internal: {
        source: request.source ?? "manual", title, summary: importSummary ?? firstLine(request.content), turn_id: request.turnId, time_zone: request.timeZone,
        ...(readOnlySkill ? importedSkillInternalFields({
          sourceAgentId: sourceAgentId!,
          sourceSkillId: request.sourceSkillId?.trim() || request.turnId?.trim() || undefined,
          sourceSkillPath: request.sourceSkillPath?.trim() || undefined,
          sourceSkillVersion: request.sourceSkillVersion?.trim() || undefined,
          sourceContentHash: request.sourceContentHash?.trim() || importedSkillContentHash(request.content),
          importedAt: receivedAt,
          title,
          content: request.content
        }) : {}),
        ...(layer === "Skill" && !readOnlySkill ? { ...skillInternalFields(title), read_only: false, source_kind: "manual" } : {}),
        ...(readOnlySkill && request.createdAt !== undefined ? { source_modified_at: at } : {}),
        ...(importTrace ? { plugin_algorithm: "memory.add.import_async.v2", trace: importTrace } : {})
      },
      createdAt: at
    });

    const qaPair = layer === "L1" && d.isAgentSourceImportMemoryAdd(request)
      ? d.memoryAddQaPair(request)
      : null;
    const captureSource = qaPair
      ? d.normalizeMemoryCaptureSource(memory.agentId ?? request.source ?? context.namespace.source ?? "")
      : "";
    const persisted = d.transaction(() => {
      if (qaPair && captureSource) {
        const priorCaptureMemory = d.memories.getByKeyIncludingDeleted(layer, memoryKey);
        const capturePrimaryMemoryId = priorCaptureMemory &&
          priorCaptureMemory.status !== "deleted" &&
          !priorCaptureMemory.deletedAt
          ? priorCaptureMemory.id
          : memory.id;
        const capture = d.captureClaims.claim({
          userId: memory.userId,
          source: captureSource,
          qaHash: d.memoryCaptureQaHash(qaPair.query, qaPair.answer),
          primaryMemoryId: capturePrimaryMemoryId,
          capturedBy: "agent_source_scan",
          createdAt: at
        });
        if (!capture.claimed && capture.claim.capturedBy !== "agent_source_scan") {
          const existing = d.memories.getIncludingDeleted(capture.claim.primaryMemoryId);
          if (!existing) {
            throw d.createError("conflict", "memory capture claim points to a missing memory");
          }
          d.assertMemoryInScope(existing, request.namespace);
          return { duplicateMemory: existing } as const;
        }
      }
      if (layer === "Skill" && !readOnlySkill) {
        d.repairManualSkillsForSource(skillKeySource, receivedAt);
        memory = this.prepareManualSkillUpsert(
          memory, skillContent ?? request.content, skillKeySource, request.turnId, legacySkillTitle
        );
      }
      const existingByKey = memory.memoryKey
        ? d.memories.getByKeyIncludingDeleted(layer, memory.memoryKey)
        : undefined;
      if (
        importTrace &&
        existingByKey &&
        existingByKey.status !== "deleted" &&
        !existingByKey.deletedAt &&
        importSourceFingerprint(existingByKey) === importSourceFingerprint(memory)
      ) {
        repairPlaceholderImportSummary(d, existingByKey, receivedAt);
        return { upsert: { memory: existingByKey, created: false, previous: existingByKey }, changeSeq: 0, duplicateMemory: existingByKey } as const;
      }
      const upsert = readOnlySkill ? d.upsertImportedSkill(memory, receivedAt, { titleProvided: explicitSkillTitle, tagsProvided: request.tags !== undefined }) : d.memories.upsertByKey(memory);
      const inserted = upsert.memory;
      if (readOnlySkill) {
        return { upsert, changeSeq: 0, duplicateMemory: undefined };
      }
      const changeSeq = d.runtime.appendChange({
        memoryId: inserted.id, namespaceId: d.namespaceIdFromMemory(inserted), kind: d.kindFromMemory(inserted),
        op: upsert.created ? "created" : "updated", entityId: inserted.id, userId: inserted.userId,
        changeType: upsert.created ? "create" : "update", before: upsert.previous, after: inserted,
        source: "memory.add", createdAt: at
      });
      if (importTrace) {
        const existing = d.processing.get(inserted.id);
        const contentChanged = Boolean(!upsert.created && upsert.previous?.contentHash && upsert.previous.contentHash !== inserted.contentHash);
        if (contentChanged) d.memories.deleteVector(inserted.id, "vec_summary");
        const processing = !existing || contentChanged ? d.processing.save({
          memoryId: inserted.id, state: "summary_pending", stage: "summary", activeJobId: null, attemptCount: 0,
          manualRetryCount: existing?.manualRetryCount ?? 0, retryAction: "retry", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
        }) : existing;
        if (!request.deferProcessing && processing.state === "summary_pending" && !processing.activeJobId) {
          const job = d.enqueueJob({ jobType: "import_summary", userId: inserted.userId, sessionId: inserted.sessionId, targetMemoryId: inserted.id,
            payload: { source: "memory.add", changeSeq, contentHash: inserted.contentHash }, maxAttempts: 3, createdAt: at });
          d.processing.update(inserted.id, { activeJobId: job.id, updatedAt: at }, ["summary_pending"]);
        }
      }
      if (!importTrace && d.config.algorithm.capture.embedAfterCapture) {
        d.enqueueJob({ jobType: "embedding", userId: inserted.userId, sessionId: inserted.sessionId, targetMemoryId: inserted.id,
          payload: { source: "memory.add", changeSeq }, createdAt: at });
      }
      return { upsert, changeSeq, duplicateMemory: undefined };
    });
    if (persisted.duplicateMemory) {
      const item = d.memories.toListItem(persisted.duplicateMemory);
      return {
        id: item.id,
        kind: item.kind,
        memoryLayer: item.memoryLayer,
        status: item.status,
        title: item.title,
        summary: item.summary,
        tags: item.tags,
        createdAt: persisted.duplicateMemory.createdAt,
        serverTime: d.nowIso(),
        duplicate: true
      };
    }
    const inserted = persisted.upsert.memory;
    if (persisted.upsert.created && !d.isAgentSourceImportMemoryAdd(request)) {
      d.enqueueJob({ jobType: "episode_idle_close", userId: inserted.userId, sessionId: inserted.sessionId,
        dedupeKey: `episode_idle_close:memory.add:${inserted.id}`,
        payload: { triggerMemoryId: inserted.id, triggerSource: "memory.add", triggeredAt: receivedAt }, createdAt: receivedAt });
    }
    const item = d.memories.toListItem(inserted);
    const response = { id: item.id, kind: item.kind, memoryLayer: item.memoryLayer, status: item.status, title: item.title,
      summary: item.summary, tags: item.tags, createdAt: inserted.createdAt, serverTime: d.nowIso() };
    const loggedContent = readOnlySkill ? inserted.memoryValue : request.content;
    if (inserted.status !== "deleted" && !d.isAgentSourceImportMemoryAdd(request)) d.recordApiLog?.("memory_add", {
      sessionId: request.sessionId, turnId: request.turnId, layer, source: request.source, tags: request.tags, content: loggedContent
    }, { stored: 1, details: [{ role: item.kind, action: "stored", summary: item.summary, content: loggedContent, traceId: item.id }] }, Date.now() - startedAt, true, response.serverTime, inserted.agentId);
    return response;
  }

  /** Legacy aliases prove continuity only within the same native Skill scope. */
  private prepareManualSkillUpsert(
    memory: MemoryRow,
    rawContent: string,
    sourceAgentId: string,
    turnId?: string,
    legacyTitle?: string
  ): MemoryRow {
    const d = this.deps;
    const namespace = d.namespaceIdFromMemory(memory);
    const source = normalizeAgentIdKey(String(memory.properties.internal_info.source ?? ""));
    const compatible = (candidate: MemoryRow) => candidate.properties.internal_info.source_kind === "manual"
      && candidate.properties.internal_info.read_only !== true && !hasImportedSkillSourceEvidence(candidate)
      && d.namespaceIdFromMemory(candidate) === namespace
      && normalizeAgentIdKey(String(candidate.properties.internal_info.source ?? "")) === source;
    const key = memory.memoryKey!;
    const occupied = d.memories.getByKey("Skill", key) ?? d.memories.getByKeyIncludingDeleted("Skill", key);
    if (occupied && !compatible(occupied)) {
      memory = { ...memory, memoryKey: `${key}:namespace:${stableHash(namespace).slice(0, 20)}` };
    }
    const title = String(memory.info.title);
    const titles = new Set([title]);
    if (legacyTitle) titles.add(legacyTitle);
    const keys = new Set([memory.memoryKey!]);
    if (key.startsWith("manual:")) {
      for (const content of new Set([memory.memoryValue, rawContent])) {
        for (const candidateTitle of titles) {
          keys.add(`manual:${stableHash(`Skill:${candidateTitle}:${content}`).slice(0, 20)}`);
          for (const agent of new Set([normalizeAgentIdKey(sourceAgentId), ""])) {
            keys.add(`manual:${stableHash(["Skill", agent, candidateTitle, importedSkillContentHash(content)]).slice(0, 20)}`);
          }
        }
        // Old tool calls copied an ordinary turn id into source_skill_id.
        // A genuine directory row still fails the native compatibility guard.
        if (turnId?.trim() && !/^skill:\S/.test(turnId.trim())) {
          for (const hash of [stableHash(content), importedSkillContentHash(content)]) {
            keys.add(`skill.import:${stableHash([sourceAgentId, turnId.trim(), hash]).slice(0, 20)}`);
          }
        }
      }
    }
    let previous = [...keys].map(alias => d.memories.getByKey("Skill", alias)).find(candidate =>
      candidate && candidate.status !== "deleted" && !candidate.deletedAt && compatible(candidate)
      && titles.has(String(candidate.info.title))
      && sanitizeMemmyProtocolText(candidate.memoryValue) === memory.memoryValue);
    if (!previous) return memory;
    if (previous.memoryKey !== memory.memoryKey) {
      previous = d.memories.updateMaintenance({ ...previous, memoryKey: memory.memoryKey });
    }
    const priorSkill = isRecord(previous.properties.internal_info.skill) ? previous.properties.internal_info.skill : {};
    const initialSkill = isRecord(memory.properties.internal_info.skill) ? memory.properties.internal_info.skill : {};
    const status = previous.status;
    return {
      ...previous, ...memory, status,
      info: { ...previous.info, ...memory.info, eta: priorSkill.eta ?? previous.info.eta ?? memory.info.eta },
      properties: { ...previous.properties, ...memory.properties, status,
        internal_info: { ...memory.properties.internal_info, ...previous.properties.internal_info,
          title: memory.info.title, name: title, summary: memory.info.summary,
          skill: { ...initialSkill, ...priorSkill, name: title, status: status === "archived" ? "archived" : priorSkill.status ?? "active" } } }
    };
  }

  memoryProcessingStatus(memoryIds: readonly string[], request: RequestEnvelope = {}): { items: MemoryProcessingRecord[]; serverTime: string } {
    const ids = dedupeStrings(memoryIds).slice(0, 10_000);
    void request;
    const records = this.deps.processing.getMany(ids);
    const recoveryIds = records.filter(isManualRecoveryCandidate).map(processing => processing.memoryId);
    const memoriesById = new Map(this.deps.memories.getMany(recoveryIds, { includeVectors: false })
      .map(memory => [memory.id, memory]));
    const items = records.map(processing => {
      if (!isManualRecoveryCandidate(processing)) return processing;
      const memory = memoriesById.get(processing.memoryId);
      return memory ? processingWithRetryAction(memory, processing) : processing;
    });
    return { items, serverTime: this.deps.nowIso() };
  }

  retryMemoryProcessing(memoryId: string, request: RequestEnvelope = {}): { accepted: boolean; processing: MemoryProcessingRecord; job?: JobRef; serverTime: string } {
    const d = this.deps;
    d.assertMemoryAddEnabled();
    const memory = d.memories.get(memoryId);
    if (!memory) throw d.createError("not_found", `memory not found: ${memoryId}`);
    d.assertMemoryInScope(memory, request.namespace);
    const current = d.processing.get(memoryId);
    if (!current) throw d.createError("invalid_argument", `memory has no asynchronous processing state: ${memoryId}`);
    if (current.state !== "failed") return { accepted: false, processing: current, serverTime: d.nowIso() };
    if (!canRetryMemoryProcessing(memory, current)) throw d.createError("conflict", current.errorMessage ?? "memory processing cannot be retried");
    const at = d.nowIso();
    const result = d.transaction(() => {
      const latest = d.processing.get(memoryId);
      if (!latest || !canRetryMemoryProcessing(memory, latest)) return latest ? { accepted: false, processing: latest } : undefined;
      const summaryJobType = summaryProcessingJobType(memory);
      const job = d.enqueueJob({ jobType: latest.stage === "summary" ? summaryJobType : "embedding", userId: memory.userId,
        sessionId: memory.sessionId, targetMemoryId: memory.id, payload: { source: "memory.processing.manual_retry", previousErrorCode: latest.errorCode ?? undefined, ...observationJobPayload(memory), ...externalSkillJobPayload(memory),
          ...(latest.stage === "summary" && summaryJobType === "trace_summary"
            ? turnJudgeJobFlags(d.runtime.latestJobForTarget(memory.id, "trace_summary")?.payload)
            : {}) },
        maxAttempts: latest.stage === "summary" ? 3 : 6, createdAt: at });
      const processing = d.processing.save({ ...latest, state: latest.stage === "summary" ? "summary_pending" : "embedding_pending", activeJobId: job.id,
        attemptCount: 0, manualRetryCount: latest.manualRetryCount + 1, retryAction: "retry", updatedAt: at });
      return { accepted: true, processing, job: d.jobToRef(job) };
    });
    if (!result) throw d.createError("not_found", `processing state not found: ${memoryId}`);
    return { ...result, serverTime: at };
  }

  restartFailedProcessing(at: string, limit = 10_000): number {
    const d = this.deps;
    if (!d.config.algorithm.enableMemoryAdd) return 0;
    let restarted = 0;
    for (const failed of d.processing.listByStates(["failed"], limit)) {
      // Configuration blocks resume via the worker's configuration fingerprint
      // change or an explicit manual retry, never on every service restart.
      if (!failed.stage || failed.retryAction === "none") continue;
      if (failed.activeJobId && d.runtime.getJob(failed.activeJobId)?.blockedReason === "configuration") continue;
      const memory = d.memories.get(failed.memoryId);
      if (!memory) continue;
      if (failed.stage !== "summary" && d.memories.hasVector(memory.id, "vec_summary")) {
        d.processing.update(memory.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["failed"]);
        continue;
      }
      if (failed.stage === "embedding" && !d.config.algorithm.capture.embedAfterCapture) {
        d.processing.update(memory.id, {
          state: "ready_text_only",
          stage: null,
          activeJobId: null,
          attemptCount: 0,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["failed"]);
        continue;
      }
      const result = d.transaction(() => {
        const current = d.processing.get(memory.id);
        if (!current || current.state !== "failed" || !current.stage || current.retryAction === "none") return undefined;
        const jobType = current.stage === "summary" ? summaryProcessingJobType(memory) : "embedding";
        const job = d.enqueueJob({ jobType, userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
          payload: { source: "memory.processing.lifecycle_retry", previousErrorCode: current.errorCode ?? undefined, ...observationJobPayload(memory), ...externalSkillJobPayload(memory),
            ...(jobType === "trace_summary" ? turnJudgeJobFlags(d.runtime.latestJobForTarget(memory.id, jobType)?.payload) : {}) },
          maxAttempts: current.stage === "summary" ? 3 : 6, createdAt: at });
        const processing = d.processing.save({ ...current, state: current.stage === "summary" ? "summary_pending" : "embedding_pending", activeJobId: job.id,
          attemptCount: 0, retryAction: "retry", updatedAt: at });
        return { job, processing };
      });
      if (result) restarted += 1;
    }
    return restarted;
  }

  enqueuePendingImportSummaries(limit = 10_000, targetMemoryIds?: readonly string[]): { enqueued: number; memoryIds: string[]; serverTime: string } {
    const d = this.deps;
    const targets = targetMemoryIds ? dedupeStrings(targetMemoryIds) : undefined;
    const memories = d.memories.listPendingAgentSourceImportSummaries(limit, targets);
    d.transaction(() => {
      for (const memory of memories) {
        const job = d.enqueueJob({ jobType: "import_summary", userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
          payload: { source: "agent_source.scan.summary_stage", contentHash: memory.contentHash }, maxAttempts: 3, createdAt: memory.createdAt });
        d.processing.update(memory.id, { activeJobId: job.id, updatedAt: d.nowIso() }, ["summary_pending"]);
      }
    });
    return { enqueued: memories.length, memoryIds: targets ?? d.memories.listUnprocessedAgentSourceImports(limit).map((memory) => memory.id), serverTime: d.nowIso() };
  }
}

export function memoryHasImportPipeline(memory: MemoryRow): boolean {
  const algorithm = stringFromRecord(memory.properties.internal_info, "plugin_algorithm");
  return algorithm?.startsWith("memory.add.import_async.") === true || memory.tags.some((tag) => tag.trim().toLowerCase() === "agent-source");
}

export function summaryProcessingJobType(memory: MemoryRow): JobType {
  return isObservationMemory(memory) ? "observation_extract" : memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
}

export function memoryNeedsImportSummary(memory: MemoryRow): boolean {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) return false;
  const summary = firstSummary(stringFromRecord(memory.info, "summary") ?? stringFromRecord(memory.properties.internal_info, "summary") ?? traceMetaFromMemory(memory)?.summary);
  return isImportSummaryPlaceholder(summary);
}

export function isImportSummaryPlaceholder(value: string | undefined): boolean {
  const first = value?.split(/\r?\n/).map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim()).find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中|摘要总结中)$/i.test(first));
}

export function importSourceFingerprint(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory);
  return stableHash({
    userText: (trace?.userText ?? "").trim(),
    agentText: (trace?.agentText ?? "").trim(),
    toolCalls: (trace?.toolCalls ?? []).map((call) => ({
      name: call.name,
      input: call.input,
      output: call.output,
      error: call.error
    }))
  });
}

export function firstSummary(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

export function firstRealSummary(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value && !isImportSummaryPlaceholder(value)));
}

export function importStatusTags(tags: string[], _status: "indexing" | "indexed"): string[] {
  return uniq(tags.filter((tag) => !(IMPORT_STATUS_TAGS as readonly string[]).includes(tag)));
}

export function updateTraceImportSummary(memory: MemoryRow, input: { summary: string; title?: string; alpha: number; value: number; priority: number; tags: string[]; updatedAt: string }): MemoryRow {
  const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
  const trace = traceMetaFromMemory(memory);
  if (!trace) return memory;
  const title = input.title?.trim();
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    reflection: null,
    alpha: input.alpha,
    usable: false,
    reflection_source: "none",
    value: input.value,
    priority: input.priority,
    import_summary_at: input.updatedAt,
    ...(title ? { title } : {})
  };
  const memoryValue = renderTraceMemoryValue({ summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"), userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflection: { text: null, alpha: input.alpha }, value: input.value, priority: input.priority });
  return {
    ...memory,
    memoryValue,
    contentHash: stableHash(memoryValue),
    tags: input.tags,
    info: { ...memory.info, summary: input.summary, value: input.value, priority: input.priority, tags: input.tags, ...(title ? { title } : {}) },
    properties: {
      ...memory.properties,
      tags: input.tags,
      info: { ...(memory.properties.info ?? {}), summary: input.summary, value: input.value, priority: input.priority, tags: input.tags, ...(title ? { title } : {}) },
      internal_info: { ...memory.properties.internal_info, summary: input.summary, ...(title ? { title } : {}), alpha: input.alpha, value: input.value, priority: input.priority, trace: nextTrace }
    },
    updatedAt: input.updatedAt
  };
}

export function updateImportPipelineStatus(memory: MemoryRow, _status: "indexing" | "indexed", at: string): MemoryRow {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) return memory;
  const tags = importStatusTags(memory.tags, _status);
  return { ...memory, tags, info: { ...memory.info, tags }, properties: { ...memory.properties, tags, info: { ...(memory.properties.info ?? {}), tags } }, updatedAt: at };
}

function repairPlaceholderImportSummary(
  d: ImportJobProcessorDeps,
  memory: MemoryRow,
  at: string
): void {
  if (!memoryNeedsImportSummary(memory)) return;
  const existing = d.processing.get(memory.id);
  // A scan replay must not turn a terminal model failure into an implicit retry.
  // Failed jobs retain their diagnostics and the explicit background retry policy.
  if (existing && (existing.state === "summary_pending" || existing.state === "summarizing" || existing.state === "failed")) return;
  d.memories.deleteVector(memory.id, "vec_summary");
  const processing = d.processing.save({
    memoryId: memory.id,
    state: "summary_pending",
    stage: "summary",
    activeJobId: null,
    attemptCount: 0,
    manualRetryCount: existing?.manualRetryCount ?? 0,
    retryAction: "retry",
    errorCode: null,
    errorMessage: null,
    failedAt: null,
    updatedAt: at
  });
  if (processing.state === "summary_pending" && !processing.activeJobId) {
    const job = d.enqueueJob({
      jobType: "import_summary",
      userId: memory.userId,
      sessionId: memory.sessionId,
      targetMemoryId: memory.id,
      payload: { source: "memory.add.placeholder_repair", contentHash: memory.contentHash },
      maxAttempts: 3,
      createdAt: at
    });
    d.processing.update(memory.id, { activeJobId: job.id, updatedAt: at }, ["summary_pending"]);
  }
}

function kindForLayer(layer: MemoryLayer): MemoryKind {
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}
function dedupeStrings(values: readonly string[]): string[] { return [...new Set(values)]; }
function uniq(values: readonly string[]): string[] { return [...new Set(values)]; }
function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined { const value = record[key]; return typeof value === "string" ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function renderTraceMemoryValue(input: { summary: string; rawTurnId?: string; stepIndex?: number; userText?: string; agentText?: string; toolCalls: TraceMeta["toolCalls"]; reflection: { text: string | null; alpha: number }; value: number; priority: number }): string {
  return [
    `Summary: ${input.summary}`,
    input.rawTurnId ? `RawTurn: ${input.rawTurnId}` : undefined,
    typeof input.stepIndex === "number" ? `TraceStep: ${input.stepIndex}` : undefined,
    input.userText ? `User:\n${input.userText}` : undefined,
    input.toolCalls.length ? ["Tool calls:", ...input.toolCalls.map((call) => `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`)].join("\n") : undefined,
    input.agentText ? `Agent:\n${input.agentText}` : undefined,
    input.reflection.text ? `Reflection: ${clip(input.reflection.text, 800)}` : undefined,
    `Alpha: ${input.reflection.alpha}`, `Value: ${input.value}`, `Priority: ${input.priority}`
  ].filter(Boolean).join("\n");
}
