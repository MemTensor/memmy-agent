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
import { clip, firstLine } from "../../utils/text.js";



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
    getIncludingDeleted(id: string): MemoryRow | undefined;
    getByKeyIncludingDeleted(layer: MemoryLayer, key: string): MemoryRow | undefined;
    upsertByKey(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
    archivePriorReadOnlySkillVersions(input: {
      sourceAgentId: string;
      sourceSkillIdentity: string;
      currentMemoryId: string;
      at: string;
    }): MemoryRow[];
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
    request = d.sanitizeMemoryAddRequest(request);
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
    const readOnlySkill = layer === "Skill";
    const sourceAgentId = readOnlySkill
      ? request.sourceAgentId?.trim() || request.source?.trim() || context.namespace.source?.trim()
      : undefined;
    if (readOnlySkill && !sourceAgentId) {
      throw d.createError("invalid_argument", "memory.add Skill requires sourceAgentId or source");
    }
    const importTitle = importTrace && d.isAgentSourceImportMemoryAdd(request) ? d.titleFromImportTrace(importTrace) : undefined;
    const title = importTitle ?? (request.title?.trim() || firstLine(request.content).slice(0, 120) || "Untitled memory");
    const importSummary = importTrace ? stringFromRecord(importTrace, "summary") || IMPORT_SUMMARY_QUEUED_TAG : undefined;
    const tags = d.memoryAddTags(request, importTrace !== null, importTrace ? stringArray(importTrace.tags) : []);
    const memoryKey = d.memoryAddKey(request, layer, title);
    const deletedReadOnlySkill = readOnlySkill
      ? d.memories.getByKeyIncludingDeleted(layer, memoryKey)
      : undefined;
    if (deletedReadOnlySkill?.status === "deleted" || deletedReadOnlySkill?.deletedAt) {
      const item = d.memories.toListItem(deletedReadOnlySkill);
      return {
        id: item.id,
        kind: item.kind,
        memoryLayer: item.memoryLayer,
        status: "deleted",
        title: item.title,
        summary: item.summary,
        tags: item.tags,
        createdAt: deletedReadOnlySkill.createdAt,
        serverTime: d.nowIso()
      };
    }
    const memory = d.buildMemory({
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
        ...(readOnlySkill ? {
          name: title,
          eta: 0.5,
          support: 1,
          gain: 0,
          skill_status: "active",
          source_memory_ids: []
        } : {})
      },
      internal: {
        source: request.source ?? "manual", title, summary: importSummary ?? firstLine(request.content), turn_id: request.turnId, time_zone: request.timeZone,
        ...(readOnlySkill ? {
          read_only: true,
          source_agent_id: sourceAgentId,
          source_skill_id: request.sourceSkillId?.trim() || request.turnId?.trim() || undefined,
          source_skill_path: request.sourceSkillPath?.trim() || undefined,
          source_skill_version: request.sourceSkillVersion?.trim() || undefined,
          source_content_hash: request.sourceContentHash?.trim() || stableHash(request.content),
          imported_at: receivedAt,
          name: title,
          invocation_guide: request.content,
          procedure_json: { summary: request.content },
          eta: 0.5,
          support: 1,
          gain: 0,
          source_policy_ids: [],
          source_world_model_ids: [],
          evidence_anchor_ids: [],
          skill: {
            name: title,
            eta: 0.5,
            status: "active",
            support: 1,
            gain: 0,
            source_policy_ids: [],
            source_world_model_ids: [],
            evidence_anchor_ids: [],
            invocation_guide: request.content,
            procedure_json: { summary: request.content },
            trials_attempted: 0,
            trials_passed: 0,
            success_rate: 0,
            beta_posterior: { alpha: 1, beta: 1, mean: 0.5 }
          }
        } : {}),
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
      const upsert = d.memories.upsertByKey(memory);
      const inserted = upsert.memory;
      const changeSeq = d.runtime.appendChange({
        memoryId: inserted.id, namespaceId: d.namespaceIdFromMemory(inserted), kind: d.kindFromMemory(inserted),
        op: upsert.created ? "created" : "updated", entityId: inserted.id, userId: inserted.userId,
        changeType: upsert.created ? "create" : "update", before: upsert.previous, after: inserted,
        source: "memory.add", createdAt: at
      });
      if (readOnlySkill && upsert.created) {
        const sourceSkillIdentity = request.sourceSkillId?.trim() || request.sourceSkillPath?.trim();
        if (sourceAgentId && sourceSkillIdentity) {
          for (const archived of d.memories.archivePriorReadOnlySkillVersions({
            sourceAgentId,
            sourceSkillIdentity,
            currentMemoryId: inserted.id,
            at
          })) {
            d.runtime.appendChange({
              memoryId: archived.id,
              kind: "skill",
              op: "archived",
              entityId: archived.id,
              userId: archived.userId,
              changeType: "read_only_skill_superseded",
              after: archived,
              source: "memory.add",
              createdAt: at
            });
          }
        }
      }
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
    if (!importTrace && d.config.algorithm.capture.embedAfterCapture) {
      d.enqueueJob({ jobType: "embedding", userId: inserted.userId, sessionId: inserted.sessionId, targetMemoryId: inserted.id,
        payload: { source: "memory.add", changeSeq: persisted.changeSeq }, createdAt: at });
    }
    const item = d.memories.toListItem(inserted);
    const response = { id: item.id, kind: item.kind, memoryLayer: item.memoryLayer, status: item.status, title: item.title,
      summary: item.summary, tags: item.tags, createdAt: inserted.createdAt, serverTime: d.nowIso() };
    if (!d.isAgentSourceImportMemoryAdd(request)) d.recordApiLog?.("memory_add", {
      sessionId: request.sessionId, turnId: request.turnId, layer, source: request.source, tags: request.tags, content: request.content
    }, { stored: 1, details: [{ role: item.kind, action: "stored", summary: item.summary, content: request.content, traceId: item.id }] }, Date.now() - startedAt, true, response.serverTime, inserted.agentId);
    return response;
  }

  memoryProcessingStatus(memoryIds: readonly string[], request: RequestEnvelope = {}): { items: MemoryProcessingRecord[]; serverTime: string } {
    const ids = dedupeStrings(memoryIds).slice(0, 10_000);
    void request;
    return { items: this.deps.processing.getMany(ids), serverTime: this.deps.nowIso() };
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
    if (current.retryAction === "none" || !current.stage) throw d.createError("conflict", current.errorMessage ?? "memory processing cannot be retried");
    const at = d.nowIso();
    const result = d.transaction(() => {
      const latest = d.processing.get(memoryId);
      if (!latest || latest.state !== "failed" || !latest.stage) return latest ? { accepted: false, processing: latest } : undefined;
      const summaryJobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
      const job = d.enqueueJob({ jobType: latest.stage === "summary" ? summaryJobType : "embedding", userId: memory.userId,
        sessionId: memory.sessionId, targetMemoryId: memory.id, payload: { source: "memory.processing.manual_retry", previousErrorCode: latest.errorCode ?? undefined, contentHash: memory.contentHash },
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
      if (!failed.stage || failed.retryAction === "none") continue;
      const memory = d.memories.get(failed.memoryId);
      if (!memory) continue;
      if (d.memories.hasVector(memory.id, "vec_summary")) {
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
        const jobType = current.stage === "summary" ? (memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary") : "embedding";
        const job = d.enqueueJob({ jobType, userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
          payload: { source: "memory.processing.lifecycle_retry", previousErrorCode: current.errorCode ?? undefined, contentHash: memory.contentHash },
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

export function memoryNeedsImportSummary(memory: MemoryRow): boolean {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) return false;
  const summary = firstSummary(stringFromRecord(memory.info, "summary") ?? stringFromRecord(memory.properties.internal_info, "summary") ?? traceMetaFromMemory(memory)?.summary);
  return isImportSummaryPlaceholder(summary);
}

export function isImportSummaryPlaceholder(value: string | undefined): boolean {
  const first = value?.split(/\r?\n/).map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim()).find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中)$/i.test(first));
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

export function updateTraceImportSummary(memory: MemoryRow, input: { summary: string; alpha: number; value: number; priority: number; tags: string[]; updatedAt: string }): MemoryRow {
  const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
  const trace = traceMetaFromMemory(memory);
  if (!trace) return memory;
  const nextTrace = { ...internalTrace, summary: input.summary, reflection: null, alpha: input.alpha, usable: false, reflection_source: "none", value: input.value, priority: input.priority, import_summary_at: input.updatedAt };
  return {
    ...memory,
    memoryValue: renderTraceMemoryValue({ summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"), userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflection: { text: null, alpha: input.alpha }, value: input.value, priority: input.priority }),
    tags: input.tags,
    info: { ...memory.info, summary: input.summary, value: input.value, priority: input.priority, tags: input.tags },
    properties: { ...memory.properties, tags: input.tags, info: { ...(memory.properties.info ?? {}), summary: input.summary, value: input.value, priority: input.priority, tags: input.tags }, internal_info: { ...memory.properties.internal_info, summary: input.summary, alpha: input.alpha, value: input.value, priority: input.priority, trace: nextTrace } },
    updatedAt: input.updatedAt
  };
}

export function updateImportPipelineStatus(memory: MemoryRow, _status: "indexing" | "indexed", at: string): MemoryRow {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) return memory;
  const tags = importStatusTags(memory.tags, _status);
  return { ...memory, tags, info: { ...memory.info, tags }, properties: { ...memory.properties, tags, info: { ...(memory.properties.info ?? {}), tags } }, updatedAt: at };
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
