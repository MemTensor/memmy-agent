import {
  canonicalJson,
  sha256Hex,
  type JsonValue
} from "../../contracts/index.js";
import type { Embedder, LlmClient } from "../../model/types.js";
import type {
  EvolutionJobRecord,
  L3WorldModelEvidenceBatchRecord,
  Repositories
} from "../../storage/repositories.js";
import type { MemoryFilter, MemoryRow } from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";

export interface WorkMemoryQaPair {
  user: string;
  assistant: string;
}

export interface WorkMemoryCandidate {
  requirement: string;
  reason: string;
}

export interface WorkMemoryDecision {
  candidate_ref: string;
  action: "create" | "merge";
  matched_memory_ref: string | null;
  work_topic: string;
  merged_requirement?: string;
  merged_reason?: string;
}

export interface WorkMemoryPipelineDependencies {
  repos: Repositories;
  llm: LlmClient;
  embedder: Embedder;
  embedAfterCapture: boolean;
  nowIso: () => string;
}

const WORK_MEMORY_SCHEMA_VERSION = 1;
const WORK_MEMORY_CANDIDATE_TOP_K = 5;

const EXTRACTION_SYSTEM_PROMPT = `Extract reusable work requirements from the conversation.

Return JSON only in this exact shape:
{"work_memories":[{"requirement":"...","reason":"..."}]}

Only include requirements explicitly requested or confirmed in the conversation. The reason is the design or business rationale for the requirement; summarize that rationale from the conversation even when it is not stated verbatim. Do not include work_topic, evidence, source IDs, or extraction commentary. Return an empty array when there is no reusable requirement.`;

const MERGE_SYSTEM_PROMPT = `Classify each new Work Memory candidate against its provided existing candidates.

Merge only when the candidates concern the same work object, requirement, or evolution of the same requirement. A shared project or broad topic is not sufficient. Create a new memory for a different object.

Return JSON only with one decision for every candidate:
{"decisions":[{"candidate_ref":"new_1","action":"create","matched_memory_ref":null,"work_topic":"..."}]}

For merge, matched_memory_ref must be one of that candidate's candidate_refs, work_topic must reuse the matched memory topic, and merged_requirement and merged_reason must contain the final non-duplicated text. For create, matched_memory_ref must be null and work_topic must be a new concise classification label.`;

export class WorkMemoryPipeline {
  constructor(private readonly deps: WorkMemoryPipelineDependencies) {}

  scheduleBatchesInTransaction(batchIds: readonly string[], at = this.deps.nowIso()): EvolutionJobRecord[] {
    const jobs: EvolutionJobRecord[] = [];
    for (const batchId of batchIds) {
      const job = this.scheduleBatchInTransaction(batchId, at);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  scheduleBatches(batchIds: readonly string[], at = this.deps.nowIso()): EvolutionJobRecord[] {
    return this.deps.repos.transaction(() => this.scheduleBatchesInTransaction(batchIds, at));
  }

  async extract(job: EvolutionJobRecord): Promise<void> {
    if (job.jobType !== "work_memory_extract") {
      throw new Error(`invalid work memory job type: ${job.id}`);
    }
    const payload = parseJobPayload(job);
    const qa = payload.qa;
    const trajectoryHash = trajectoryHashForQa(qa);
    if (trajectoryHash !== payload.trajectoryHash) {
      throw new Error(`work memory trajectory hash mismatch: ${job.id}`);
    }
    const session = job.sessionId ? this.deps.repos.runtime.getSession(job.sessionId) : undefined;
    if (!session || session.userId !== job.userId) {
      throw new Error(`work memory job session scope mismatch: ${job.id}`);
    }
    const projectId = normalizeProjectId(session.projectId);
    const source = session.source.trim() || "unknown";
    const expectedScopeKey = stableHash(["work_memory", job.userId, projectId]);
    const expectedDedupeKey = stableHash([
      "work_memory_extract",
      job.userId,
      source,
      projectId,
      payload.trajectoryHash
    ]);
    if (job.scopeKey !== expectedScopeKey || job.dedupeKey !== expectedDedupeKey) {
      throw new Error(`work memory job scope mismatch: ${job.id}`);
    }
    if (qa.length === 0 || !this.deps.llm.isConfigured()) return;

    const extraction = await this.deps.llm.completeJson<{
      work_memories?: unknown;
    }>([
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: renderQaPrompt(qa) }
    ], {
      operation: "capture.work_memory_extract",
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: 2_048,
      jsonMode: true
    });
    const candidates = validateExtractionOutput(extraction);
    if (candidates.length === 0) return;

    const filter: MemoryFilter = {
      memoryLayer: "L1",
      memoryKind: "work_memory",
      status: ["activated", "resolving"],
      workMemoryUserId: job.userId,
      workMemoryProjectId: projectId
    };
    const candidatesWithMatches = await this.retrieveCandidates(candidates, filter);
    const decisions = await this.decide(candidatesWithMatches);
    this.persistDecisions(job, projectId, payload.trajectoryHash, candidates, candidatesWithMatches, decisions);
  }

  private scheduleBatchInTransaction(batchId: string, at: string): EvolutionJobRecord | undefined {
    const batch = this.deps.repos.l3WorldModels.getBatch(batchId);
    if (!batch) throw new Error(`work memory batch not found: ${batchId}`);
    const session = this.deps.repos.runtime.getSession(batch.sessionId);
    if (!session || session.userId !== batch.userId || normalizeProjectId(session.projectId) !== normalizeProjectId(batch.projectId)) {
      throw new Error(`work memory batch session scope mismatch: ${batchId}`);
    }
    const qa = this.qaForBatch(batch);
    const trajectoryHash = trajectoryHashForQa(qa);
    const projectId = normalizeProjectId(batch.projectId);
    const source = session.source.trim() || "unknown";
    const dedupeKey = stableHash([
      "work_memory_extract",
      batch.userId,
      source,
      projectId,
      trajectoryHash
    ]);
    const existing = this.deps.repos.runtime.getJobByDedupeKey(dedupeKey);
    if (existing?.status === "queued" || existing?.status === "leased" || existing?.status === "succeeded" || existing?.status === "dead_letter") {
      return existing;
    }
    const scopeKey = stableHash(["work_memory", batch.userId, projectId]);
    const scopeSeq = existing?.scopeSeq ?? this.deps.repos.runtime.nextWorkMemoryScopeSeq(scopeKey);
    const job = this.deps.repos.runtime.enqueueJobInTransaction({
      id: existing?.id ?? newId("job"),
      jobType: "work_memory_extract",
      status: "queued",
      dedupeKey,
      userId: batch.userId,
      sessionId: batch.sessionId,
      scopeKey,
      scopeSeq,
      payload: {
        trajectoryHash,
        qa
      },
      attempts: existing?.attempts ?? 0,
      maxAttempts: Math.max(existing?.maxAttempts ?? 3, 3),
      leasedUntil: null,
      lastError: null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    });
    this.deps.repos.runtime.appendChange({
      memoryId: job.id,
      namespaceId: scopeKey,
      kind: "job",
      op: "queued",
      entityId: job.id,
      userId: job.userId,
      changeType: "job_queued",
      before: existing,
      after: job,
      source: "boundary.work_memory_extract",
      createdAt: at
    });
    return job;
  }

  private qaForBatch(batch: L3WorldModelEvidenceBatchRecord): WorkMemoryQaPair[] {
    const result: WorkMemoryQaPair[] = [];
    for (const rawTurnId of batch.rawTurnIds) {
      const rawTurn = this.deps.repos.runtime.getRawTurn(rawTurnId);
      if (!rawTurn || rawTurn.deletedAt || rawTurn.redactedAt) continue;
      if (rawTurn.userId !== batch.userId || rawTurn.sessionId !== batch.sessionId) {
        throw new Error(`work memory RawTurn scope mismatch: ${rawTurnId}`);
      }
      const user = normalizeQaText(rawTurn.userText ?? "");
      const assistant = normalizeQaText(rawTurn.assistantText ?? "");
      if (!user && !assistant) continue;
      result.push({ user, assistant });
    }
    return result;
  }

  private async retrieveCandidates(
    candidates: WorkMemoryCandidate[],
    filter: MemoryFilter
  ): Promise<Array<{ candidate: WorkMemoryCandidate; matches: MemoryRow[] }>> {
    const texts = candidates.map((candidate) => `${candidate.requirement}\n${candidate.reason}`);
    let vectors: number[][] = [];
    if (this.deps.embedder.isRemote() || this.deps.embedder.config.model) {
      try {
        vectors = await this.deps.embedder.embed(texts, "query");
      } catch {
        vectors = [];
      }
    }
    return candidates.map((candidate, index) => {
      const vector = vectors[index];
      const ids = vector && vector.length > 0
        ? this.deps.repos.memories.searchVectorIds(vector, "vec_summary", filter, WORK_MEMORY_CANDIDATE_TOP_K)
        : [];
      const terms = [candidate.requirement, candidate.reason]
        .flatMap((value) => value.split(/\s+/u).filter((term) => term.length >= 2))
        .slice(0, 16);
      const ftsMatch = terms
        .map((term) => `"${term.replace(/"/gu, '""')}"`)
        .join(" OR ");
      const ftsIds = ids.length > 0
        ? ids
        : this.deps.repos.memories.searchFtsIds(ftsMatch, filter, WORK_MEMORY_CANDIDATE_TOP_K);
      const fallbackIds = ftsIds.length > 0
        ? ftsIds
        : this.deps.repos.memories.searchPatternIds(terms, filter, WORK_MEMORY_CANDIDATE_TOP_K);
      const memories = this.deps.repos.memories.getMany(fallbackIds.map((hit) => hit.id));
      return { candidate, matches: memories.filter((memory) => isWorkMemoryInScope(memory, filter)) };
    });
  }

  private async decide(
    candidates: Array<{ candidate: WorkMemoryCandidate; matches: MemoryRow[] }>
  ): Promise<WorkMemoryDecision[]> {
    if (!this.deps.llm.isConfigured()) {
      return candidates.map((item, index) => ({
        candidate_ref: `new_${index + 1}`,
        action: "create",
        matched_memory_ref: null,
        work_topic: deriveWorkTopic(item.candidate.requirement)
      }));
    }
    const pool = new Map<string, MemoryRow>();
    for (const item of candidates) {
      for (const memory of item.matches) pool.set(memory.id, memory);
    }
    const existing = [...pool.values()].map((memory, index) => ({
      memory_ref: `existing_${index + 1}`,
      work_topic: workTopicFromMemory(memory),
      requirement: requirementFromMemory(memory),
      reason: reasonFromMemory(memory),
      memory
    }));
    const refById = new Map(existing.map((item) => [item.memory.id, item.memory_ref]));
    const input = {
      existing: existing.map(({ memory, ...item }) => item),
      candidates: candidates.map((item, index) => ({
        candidate_ref: `new_${index + 1}`,
        requirement: item.candidate.requirement,
        reason: item.candidate.reason,
        candidate_refs: item.matches.map((memory) => refById.get(memory.id)).filter((ref): ref is string => Boolean(ref))
      }))
    };
    const mergePrompt = [
      "## 统一候选 Work Memory 池",
      JSON.stringify(input.existing),
      "",
      "## 待判断的新 Work Memory",
      ...input.candidates.map((candidate) => `${candidate.candidate_ref}: ${JSON.stringify({
        requirement: candidate.requirement,
        reason: candidate.reason,
        candidate_refs: candidate.candidate_refs
      })}`)
    ].join("\n");
    const result = await this.deps.llm.completeJson<{ decisions?: unknown }>([
      { role: "system", content: MERGE_SYSTEM_PROMPT },
      { role: "user", content: mergePrompt }
    ], {
      operation: "capture.work_memory_merge",
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: 4_096,
      jsonMode: true
    });
    return validateDecisionOutput(result, candidates, input.candidates, existing);
  }

  private persistDecisions(
    job: EvolutionJobRecord,
    projectId: string | null,
    trajectoryHash: string,
    candidates: WorkMemoryCandidate[],
    candidatesWithMatches: Array<{ candidate: WorkMemoryCandidate; matches: MemoryRow[] }>,
    decisions: WorkMemoryDecision[]
  ): void {
    const candidateByRef = new Map(candidates.map((candidate, index) => [`new_${index + 1}`, candidate]));
    const matchesByRef = new Map(candidatesWithMatches.map((item, index) => [`new_${index + 1}`, item.matches]));
    const memoryRefById = new Map<string, string>();
    for (const item of candidatesWithMatches) {
      for (const memory of item.matches) {
        if (!memoryRefById.has(memory.id)) {
          memoryRefById.set(memory.id, `existing_${memoryRefById.size + 1}`);
        }
      }
    }
    this.deps.repos.transaction(() => {
      for (const decision of decisions) {
        const candidate = candidateByRef.get(decision.candidate_ref);
        if (!candidate) throw new Error(`work memory decision references unknown candidate: ${decision.candidate_ref}`);
        const matches = matchesByRef.get(decision.candidate_ref) ?? [];
        const at = this.deps.nowIso();
        const topic = normalizeWorkTopic(decision.work_topic);
        if (!topic) throw new Error(`work memory topic is empty: ${decision.candidate_ref}`);
        if (decision.action === "merge") {
          const target = matches.find((memory) => memoryRefById.get(memory.id) === decision.matched_memory_ref);
          if (!target) throw new Error(`work memory merge target is not a candidate: ${decision.candidate_ref}`);
          const currentTarget = this.deps.repos.memories.get(target.id) ?? target;
          const requirement = normalizeRequirement(decision.merged_requirement ?? candidate.requirement);
          const reason = normalizeRequirement(decision.merged_reason ?? candidate.reason);
          this.writeMemory(currentTarget, topicFromMemory(currentTarget), requirement, reason, trajectoryHash, at, job, projectId);
        } else {
          this.writeMemory(undefined, topic, normalizeRequirement(candidate.requirement), normalizeRequirement(candidate.reason), trajectoryHash, at, job, projectId);
        }
      }
    });
  }

  private writeMemory(
    existing: MemoryRow | undefined,
    topic: string,
    requirement: string,
    reason: string,
    trajectoryHash: string,
    at: string,
    sourceJob: EvolutionJobRecord,
    projectId?: string | null
  ): MemoryRow {
    if (!requirement || !reason) throw new Error("work memory requirement and reason must be non-empty");
    const memoryValue = canonicalWorkMemoryText(topic, requirement, reason);
    const info: Record<string, unknown> = { ...(existing?.info ?? {}) };
    if (projectId !== undefined) {
      if (projectId) info.project_id = projectId;
      else delete info.project_id;
    }
    const memory: MemoryRow = {
      id: existing?.id ?? newId("memory"),
      timeline: existing?.timeline ?? at,
      userId: existing?.userId ?? sourceJob.userId,
      ...(existing?.conversationId !== undefined ? { conversationId: existing.conversationId } : {}),
      sessionId: existing?.sessionId ?? sourceJob.sessionId,
      ...(existing?.agentId !== undefined ? { agentId: existing.agentId } : {}),
      ...(existing?.appId !== undefined ? { appId: existing.appId } : {}),
      memoryType: "LongTermMemory",
      status: "activated",
      visibility: "private",
      ...(existing?.memoryKey !== undefined ? { memoryKey: existing.memoryKey } : {}),
      memoryValue,
      tags: ["work_memory"],
      info,
      properties: {
        ...(existing?.properties ?? {}),
        memory_type: "LongTermMemory",
        status: "activated",
        tags: ["work_memory"],
        info,
        internal_info: {
          ...(existing?.properties.internal_info ?? {}),
          memory_layer: "L1",
          memory_kind: "work_memory",
          work_topic: topic,
          requirement,
          reason,
          trajectory_hash: trajectoryHash,
          schema_version: WORK_MEMORY_SCHEMA_VERSION
        }
      },
      memoryLayer: "L1",
      contentHash: stableHash(memoryValue),
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      deletedAt: null
    };
    if (existing) {
      this.deps.repos.memories.deleteVector(existing.id, "vec_summary");
    }
    const saved = existing ? this.deps.repos.memories.update(memory) : this.deps.repos.memories.insert(memory);
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: sourceJob.scopeKey,
      kind: "work_memory",
      op: existing ? "updated" : "created",
      entityId: saved.id,
      userId: saved.userId,
      changeType: existing ? "work_memory_updated" : "work_memory_created",
      before: existing,
      after: saved,
      source: "worker.work_memory_extract",
      createdAt: at
    });
    if (this.deps.embedAfterCapture) {
      const embeddingJob = this.deps.repos.runtime.enqueueJobInTransaction({
        id: newId("job"),
        jobType: "embedding",
        status: "queued",
        dedupeKey: `embedding:${saved.id}:${saved.contentHash ?? stableHash(saved.memoryValue)}`,
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: sourceJob.episodeId,
        targetMemoryId: saved.id,
        payload: { reason: "work_memory.updated", contentHash: saved.contentHash },
        attempts: 0,
        maxAttempts: 6,
        createdAt: at,
        updatedAt: at
      });
      this.deps.repos.runtime.appendChange({
        memoryId: embeddingJob.id,
        namespaceId: sourceJob.scopeKey,
        kind: "job",
        op: "queued",
        entityId: embeddingJob.id,
        userId: embeddingJob.userId,
        changeType: "job_queued",
        after: embeddingJob,
        source: "worker.work_memory_extract",
        createdAt: at
      });
      this.deps.repos.processing.save({
        memoryId: saved.id,
        state: "embedding_pending",
        stage: "embedding",
        activeJobId: embeddingJob.id,
        attemptCount: 0,
        manualRetryCount: 0,
        retryAction: "retry",
        updatedAt: at
      });
    } else {
      this.deps.repos.processing.save({
        memoryId: saved.id,
        state: "ready_text_only",
        stage: null,
        activeJobId: null,
        attemptCount: 0,
        manualRetryCount: 0,
        retryAction: "retry",
        updatedAt: at
      });
    }
    return saved;
  }
}

export function trajectoryHashForQa(qa: readonly WorkMemoryQaPair[]): string {
  return sha256Hex(canonicalJson(qa as unknown as JsonValue));
}

export function renderQaPrompt(qa: readonly WorkMemoryQaPair[]): string {
  const lines = ["QUESTION & ANSWER:"];
  for (const pair of qa) {
    lines.push(`user: ${pair.user}`, "", `assistant: ${pair.assistant}`, "");
  }
  return lines.join("\n").trim();
}

export function canonicalWorkMemoryText(workTopic: string, requirement: string, reason: string): string {
  return [
    `Work topic: ${normalizeWorkTopic(workTopic)}`,
    `Requirement: ${normalizeRequirement(requirement)}`,
    `Requirement rationale: ${normalizeRequirement(reason)}`
  ].join("\n");
}

export function normalizeProjectId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeRequirement(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

export function normalizeWorkTopic(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseJobPayload(job: EvolutionJobRecord): { trajectoryHash: string; qa: WorkMemoryQaPair[] } {
  if (Object.keys(job.payload).sort().join(",") !== "qa,trajectoryHash") {
    throw new Error(`invalid work memory job payload: ${job.id}`);
  }
  const trajectoryHash = job.payload.trajectoryHash;
  if (typeof trajectoryHash !== "string" || !trajectoryHash) throw new Error(`invalid work memory trajectory hash: ${job.id}`);
  const qa = job.payload.qa;
  if (!Array.isArray(qa)) throw new Error(`invalid work memory qa snapshot: ${job.id}`);
  return {
    trajectoryHash,
    qa: qa.map((item) => {
      if (!isRecord(item) || Object.keys(item).sort().join(",") !== "assistant,user" || typeof item.user !== "string" || typeof item.assistant !== "string") {
        throw new Error(`invalid work memory qa pair: ${job.id}`);
      }
      return { user: normalizeQaText(item.user), assistant: normalizeQaText(item.assistant) };
    })
  };
}

function validateExtractionOutput(value: { work_memories?: unknown }): WorkMemoryCandidate[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, "work_memories")) {
    throw new Error("invalid work memory extraction output");
  }
  if (!Array.isArray(value.work_memories)) throw new Error("work_memories must be an array");
  return value.work_memories.map((item) => {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "reason,requirement" || typeof item.requirement !== "string" || typeof item.reason !== "string") {
      throw new Error("invalid work memory candidate");
    }
    const requirement = normalizeRequirement(item.requirement);
    const reason = normalizeRequirement(item.reason);
    if (!requirement || !reason) throw new Error("work memory candidate fields must be non-empty");
    return { requirement, reason };
  });
}

function validateDecisionOutput(
  value: { decisions?: unknown },
  candidates: Array<{ candidate: WorkMemoryCandidate; matches: MemoryRow[] }>,
  inputs: Array<{ candidate_ref: string; candidate_refs: string[] }>,
  existing: Array<{ memory_ref: string; memory: MemoryRow }>
): WorkMemoryDecision[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.decisions)) {
    throw new Error("invalid work memory decision output");
  }
  if (value.decisions.length !== candidates.length) throw new Error("work memory decision count mismatch");
  const existingByRef = new Map(existing.map((item) => [item.memory_ref, item.memory]));
  const inputByRef = new Map(inputs.map((item) => [item.candidate_ref, item]));
  const seen = new Set<string>();
  return value.decisions.map((item) => {
    if (!isRecord(item)) throw new Error("invalid work memory decision");
    const action = item.action;
    const allowedKeys = action === "merge"
      ? ["action", "candidate_ref", "matched_memory_ref", "merged_reason", "merged_requirement", "work_topic"]
      : ["action", "candidate_ref", "matched_memory_ref", "work_topic"];
    if (Object.keys(item).some((key) => !allowedKeys.includes(key))) throw new Error("invalid work memory decision fields");
    const candidateRef = item.candidate_ref;
    if (typeof candidateRef !== "string" || seen.has(candidateRef) || !inputByRef.has(candidateRef)) throw new Error("invalid work memory candidate_ref");
    seen.add(candidateRef);
    if (action !== "create" && action !== "merge") throw new Error("invalid work memory action");
    const matched = item.matched_memory_ref;
    if (matched !== null && typeof matched !== "string") throw new Error("invalid work memory matched_memory_ref");
    const workTopic = typeof item.work_topic === "string" ? normalizeWorkTopic(item.work_topic) : "";
    if (!workTopic) throw new Error("work memory topic must be non-empty");
    const input = inputByRef.get(candidateRef)!;
    if (action === "create") {
      if (matched !== null) throw new Error("create decision must not match an existing memory");
      return { candidate_ref: candidateRef, action, matched_memory_ref: null, work_topic: workTopic };
    }
    if (!matched || !input.candidate_refs.includes(matched) || !existingByRef.has(matched)) throw new Error("merge target is not a candidate");
    const matchedMemory = existingByRef.get(matched)!;
    if (workTopic !== workTopicFromMemory(matchedMemory)) throw new Error("merge decision must reuse the existing work topic");
    const mergedRequirement = typeof item.merged_requirement === "string" ? normalizeRequirement(item.merged_requirement) : "";
    const mergedReason = typeof item.merged_reason === "string" ? normalizeRequirement(item.merged_reason) : "";
    if (!mergedRequirement || !mergedReason) throw new Error("merge decision requires merged text");
    return {
      candidate_ref: candidateRef,
      action,
      matched_memory_ref: matched,
      work_topic: workTopic,
      merged_requirement: mergedRequirement,
      merged_reason: mergedReason
    };
  });
}

function isWorkMemoryInScope(memory: MemoryRow, filter: MemoryFilter): boolean {
  if (memory.memoryLayer !== "L1" || memory.properties.internal_info.memory_kind !== "work_memory") return false;
  if (filter.workMemoryUserId !== undefined && memory.userId !== filter.workMemoryUserId) return false;
  const project = normalizeProjectId(typeof memory.info.project_id === "string" ? memory.info.project_id : null);
  return filter.workMemoryProjectId === undefined || project === filter.workMemoryProjectId;
}

function workTopicFromMemory(memory: MemoryRow): string {
  const value = memory.properties.internal_info.work_topic;
  return typeof value === "string" ? normalizeWorkTopic(value) : "";
}

function topicFromMemory(memory: MemoryRow): string {
  return workTopicFromMemory(memory) || "Work requirements";
}

function requirementFromMemory(memory: MemoryRow): string {
  const value = memory.properties.internal_info.requirement;
  return typeof value === "string" ? normalizeRequirement(value) : "";
}

function reasonFromMemory(memory: MemoryRow): string {
  const value = memory.properties.internal_info.reason;
  return typeof value === "string" ? normalizeRequirement(value) : "";
}

function deriveWorkTopic(requirement: string): string {
  const first = normalizeWorkTopic(requirement).split(/[.!?。！？]/u)[0]?.trim();
  return first ? first.slice(0, 80) : "Work requirements";
}

function normalizeQaText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
