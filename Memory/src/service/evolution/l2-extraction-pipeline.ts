import { createHash, randomUUID } from "node:crypto";
import { languageSteeringLine, packL2TraceContext, policyMetaFromMemory, steeredPromptLanguage, traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import { embeddingIdentity, vectorEmbeddingIdentity } from "../../model/embedding-identity.js";
import type { Embedder, LlmClient } from "../../model/types.js";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import { profileIdFromMemory, projectIdFromMemory } from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { listL2Candidates, markL2CandidatesProcessed, type L2Candidate } from "./l2-candidate-service.js";
import { L2_EXTRACTION_SYSTEM_PROMPT, validateL2ExtractionResult, type L2ExtractionOperation, type NewL2Lesson } from "./l2-extraction-contract.js";
import { logEvolutionDecision } from "./evolution-logging.js";

export interface UnifiedL2ExtractionDeps {
  repos: Repositories;
  config: MemmyConfig;
  skillLlm: LlmClient;
  embedder: Embedder;
  nowIso?: () => string;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string | undefined;
  recomputePolicyStats?(policyId: string, at: string): MemoryRow | undefined;
}

type HistoricalL2 = ReturnType<typeof l2ComparisonRecord>;
type SourceRecord = ReturnType<typeof l1ExtractionRecord>;
type Batch = { sources: L2Candidate[]; records: SourceRecord[]; targets: HistoricalL2[] };
const LEASE_MS = 15 * 60_000;
const MAX_L1_PER_BATCH = 5;
const SOURCE = "worker.l2_extraction.v1";

/** Exact hashing: stableHash intentionally truncates long strings and cannot version full evidence. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function l1ExtractionRecord(candidate: L2Candidate) {
  const memory = candidate.memory;
  const trace = traceMetaFromMemory(memory);
  return {
    id: memory.id,
    version: memory.version,
    source_version: candidate.sourceVersion,
    episode_id: candidate.episodeId,
    routes: candidate.routes,
    // Keep the L1 summary whole; memoryValue may duplicate unbounded dialogue/logs.
    // Older L1 without a summary uses a bounded stored-content fallback.
    content: trace?.summary.trim() ? trace.summary : clip(memory.memoryValue, 1_000),
    ...packL2TraceContext(trace),
    context_note: "Auxiliary dialogue, reflection, tool and feedback text may be truncated. Only the first 3 tool calls are shown; this is not the complete execution history. Do not infer success or failure from omitted content.",
    // Rule-generated drafts are recovery artifacts, never independent source evidence.
    evidence_signals: candidate.signals.map(({ fallback: _fallback, ...signal }) => ({ ...signal, text: clip(signal.text, 1_000) }))
  };
}

export function l2ComparisonRecord(memory: MemoryRow) {
  const policy = policyMetaFromMemory(memory);
  const internal = memory.properties.internal_info;
  const data = isRecord(internal.policy) ? internal.policy : {};
  return {
    id: memory.id,
    version: memory.version,
    type: data.lesson_type ?? internal.lesson_type ?? null,
    generation_method: data.generation_method ?? internal.generation_method ?? "legacy",
    extraction_status: data.extraction_status ?? internal.extraction_status ?? "complete",
    title: policy?.title ?? memory.memoryKey ?? "",
    applicability: policy?.trigger ?? "",
    content: policy?.procedure ?? memory.memoryValue,
    verification: policy?.verification ?? "",
    exclusions: policy?.boundary ?? "",
    // Historical policies may carry extra conditions outside the legacy five text fields.
    decision_guidance: data.decision_guidance ?? null,
    expected_outcome: data.expected_outcome ?? null,
    explicit_exclusions: data.exclusions ?? null,
    stored_content: memory.memoryValue
  };
}

export function l2ComparisonText(memory: MemoryRow): string {
  const { id: _id, version: _version, ...content } = l2ComparisonRecord(memory);
  return JSON.stringify(content);
}

function scopeOf(memory: MemoryRow): string {
  return JSON.stringify([memory.userId, projectIdFromMemory(memory) ?? memory.appId ?? null, profileIdFromMemory(memory) ?? "default"]);
}

function validL2(memory: MemoryRow): boolean {
  if (memory.memoryLayer !== "L2" || memory.deletedAt || !["activated", "resolving"].includes(memory.status)) return false;
  const policy = policyMetaFromMemory(memory);
  const lifecycle = policy?.status ?? memory.info.status;
  return lifecycle === "candidate" || lifecycle === "active";
}

function validL1(memory: MemoryRow): boolean {
  return memory.memoryLayer === "L1" && ["activated", "resolving"].includes(memory.status) && !memory.deletedAt;
}

function ordinarySuccess(candidate: L2Candidate): boolean {
  return candidate.routes.length === 1 && candidate.routes[0] === "ordinary"
    && (traceMetaFromMemory(candidate.memory)?.value ?? 0) > 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error("l2 extraction: incompatible embedding dimensions");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!, bv = b[i]!;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error("l2 extraction: invalid embedding component");
    dot += av * bv; aa += av * av; bb += bv * bv;
  }
  if (aa === 0 || bb === 0) throw new Error("l2 extraction: empty embedding norm");
  return dot / Math.sqrt(aa * bb);
}

export class UnifiedL2ExtractionPipeline {
  private vectorSpace?: string;
  constructor(private readonly deps: UnifiedL2ExtractionDeps) {}

  async induce(job: EvolutionJobRecord): Promise<void> {
    const sourceId = typeof job.payload.sourceMemoryId === "string" ? job.payload.sourceMemoryId
      : typeof job.payload.l1MemoryId === "string" ? job.payload.l1MemoryId : job.targetMemoryId;
    const source = sourceId ? this.deps.repos.memories.get(sourceId) : undefined;
    if (source && (source.userId !== job.userId || !validL1(source))) return;
    const episodeId = job.episodeId ?? (source ? traceMetaFromMemory(source)?.episodeId : undefined) ?? null;
    const all = listL2Candidates(this.deps.repos, { userId: job.userId, episodeId });
    // An unbound L1 is a single-source batch, never a synthetic cross-Episode group.
    const pending = all.filter((candidate) => episodeId !== null || candidate.sourceMemoryId === sourceId);
    const scopes = new Map<string, L2Candidate[]>();
    for (const candidate of pending) {
      const scope = scopeOf(candidate.memory);
      const group = scopes.get(scope) ?? [];
      group.push(candidate); scopes.set(scope, group);
    }
    for (const [scope, candidates] of scopes) await this.processScope(job, scope, candidates);
    const originalVersions = new Set(pending.map((candidate) => `${candidate.id}:${candidate.sourceVersion}`));
    const arrived = listL2Candidates(this.deps.repos, { userId: job.userId, episodeId })
      .filter((candidate) => (episodeId !== null || candidate.sourceMemoryId === sourceId)
        && !originalVersions.has(`${candidate.id}:${candidate.sourceVersion}`));
    if (arrived.length) {
      const first = arrived[0]!;
      this.deps.enqueueJob({ jobType: "l2_induction", userId: job.userId, sessionId: first.memory.sessionId,
        episodeId: episodeId ?? undefined, targetMemoryId: first.sourceMemoryId,
        dedupeKey: `l2.extract.continue:${digest(arrived.map((candidate) => [candidate.id, candidate.sourceVersion]).sort())}`,
        payload: { sourceMemoryId: first.sourceMemoryId, reason: "unified_candidates_arrived_during_extraction" }, createdAt: this.now() });
    }
  }

  private now(): string { return this.deps.nowIso?.() ?? new Date().toISOString(); }

  private async processScope(job: EvolutionJobRecord, scope: string, candidates: L2Candidate[]): Promise<void> {
    const leaseKey = `l2.extract.lease.v1:${digest(scope)}`;
    const owner = `${job.id}:${randomUUID()}`;
    this.deps.repos.transaction(() => {
      const previous = this.deps.repos.runtime.getKv(leaseKey)?.value;
      if (isRecord(previous) && typeof previous.until === "number" && previous.until > Date.now()) {
        throw new Error("l2 extraction: scope already being processed; retry pending candidates");
      }
      this.deps.repos.runtime.setKv(leaseKey, { owner, until: Date.now() + LEASE_MS }, this.now());
    });
    const renew = () => this.deps.repos.transaction(() => {
      const lease = this.deps.repos.runtime.getKv(leaseKey)?.value;
      if (!isRecord(lease) || lease.owner !== owner) throw new Error("l2 extraction: scope lease changed");
      this.deps.repos.runtime.setKv(leaseKey, { owner, until: Date.now() + LEASE_MS }, this.now());
    });
    try {
      if (!this.deps.skillLlm.isConfigured() || !this.deps.config.algorithm.l2Induction.useLlm) {
        this.persistFeedbackFallbacks(candidates, renew);
        logEvolutionDecision(job, "l2_induction", "unified_model_unavailable_candidates_pending", { candidates: candidates.length });
        if (this.deps.config.algorithm.l2Induction.useLlm) throw new Error("l2 extraction: configured evolution model unavailable; candidates pending");
        return;
      }
      let remaining = [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      while (remaining.length) {
        renew();
        // Rebuild the index after every committed batch. New candidates are immediately visible
        // through full-text vectors; legacy retrieval vectors are never used for comparison.
        const historical = this.listHistorical(remaining[0]!.memory, scope);
        const vectors = await this.vectors(historical.map(l2ComparisonText), "document", renew);
        renew();
        const batch = await this.nextBatch(remaining, historical, vectors, renew);
        renew();
        await this.extractBatch(job, scope, batch, renew);
        remaining = remaining.slice(batch.sources.length);
      }
    } catch (error) {
      // Only the existing, evidence-backed feedback rules can supply a fallback. Never mark
      // the L1 processed: model recovery must still compare all its evidence and increments.
      this.persistFeedbackFallbacks(candidates, renew);
      throw error;
    } finally {
      this.deps.repos.transaction(() => {
        const lease = this.deps.repos.runtime.getKv(leaseKey)?.value;
        if (isRecord(lease) && lease.owner === owner) this.deps.repos.runtime.setKv(leaseKey, null, this.now());
      });
    }
  }

  private listHistorical(source: MemoryRow, scope: string): MemoryRow[] {
    const result: MemoryRow[] = [];
    // Pagination avoids silently omitting older policies from the comparison corpus.
    for (let offset = 0; ; offset += 500) {
      const page = this.deps.repos.memories.list({ userId: source.userId, memoryLayer: "L2", status: ["activated", "resolving"] }, 500, offset);
      result.push(...page.filter((memory) => validL2(memory) && scopeOf(memory) === scope));
      if (page.length < 500) break;
    }
    return result;
  }

  private async vectors(texts: string[], role: "query" | "document", heartbeat: () => void = () => {}): Promise<number[][]> {
    const config = this.deps.embedder.config;
    // Endpoint and role are part of identity: equal dimensions do not imply compatible models.
    const space = digest({ provider: config.provider, mode: config.mode, endpoint: config.endpoint,
      model: config.model, sourceProvider: config.sourceProvider, actualModelContext: config.actualModelContext,
      extraBody: config.extraBody, normalize: config.normalize });
    if (this.vectorSpace && this.vectorSpace !== space) throw new Error("l2 extraction: embedding model changed; retry snapshot");
    this.vectorSpace = space;
    const modelKey = digest({ space, role });
    const expectedIdentity = embeddingIdentity(config);
    const output: number[][] = new Array(texts.length);
    const missing: Array<{ index: number; key: string; text: string }> = [];
    for (const [index, text] of texts.entries()) {
      const key = `l2.extract.vector.v1:${modelKey}:${digest(text)}`;
      const cached = this.deps.repos.runtime.getKv(key)?.value;
      if (Array.isArray(cached) && cached.length > 0 && cached.every((n) => typeof n === "number" && Number.isFinite(n))) {
        output[index] = cached as number[]; continue;
      }
      // The existing embedder owns provider input guards/retries; no fallback to a different
      // model or shortened title vector is allowed when the requested full text fails.
      missing.push({ index, key, text });
    }
    const batchSize = Math.max(1, Math.min(128, config.batchSize));
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      heartbeat();
      const batch = missing.slice(offset, offset + batchSize);
      const vectors = await this.deps.embedder.embed(batch.map((item) => item.text), role);
      if (vectors.length !== batch.length) throw new Error("l2 extraction: embedding response count mismatch");
      vectors.forEach((vector, index) => {
        const actual = vectorEmbeddingIdentity(vector);
        if (actual && (actual.provider !== expectedIdentity.provider || actual.model !== expectedIdentity.model)) {
          throw new Error("l2 extraction: embedding provenance changed; retry snapshot");
        }
        cosineSimilarity(vector, vector);
        const item = batch[index]!;
        this.deps.repos.runtime.setKv(item.key, vector, this.now());
        output[item.index] = vector;
      });
    }
    return output;
  }

  private async nextBatch(sources: L2Candidate[], historical: MemoryRow[], vectors: number[][], heartbeat: () => void): Promise<Batch> {
    const settings = this.deps.config.algorithm.l2Induction;
    const maxChars = settings.maxInputChars;
    const batch: Batch = { sources: [], records: [], targets: [] };
    const targets = new Map<string, HistoricalL2>();
    for (const source of sources) {
      // Stop before retrieving the next source: its batch must see newly committed L2.
      if (batch.sources.length >= MAX_L1_PER_BATCH) break;
      const record = l1ExtractionRecord(source);
      const { id: _id, version: _version, source_version: _sourceVersion, episode_id: _episodeId, routes: _routes, ...text } = record;
      const [query] = await this.vectors([JSON.stringify(text)], "query", heartbeat);
      const recalled = historical.map((memory, i) => ({ memory, score: cosineSimilarity(query!, vectors[i]!) }))
        .filter(({ score }) => score >= settings.recallCosine)
        .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
        .slice(0, settings.recallTopK).map(({ memory }) => l2ComparisonRecord(memory));
      // Recovery must revisit the exact rule candidate even if its draft phrasing has low cosine.
      const fallbackTargets = historical.filter((memory) => this.isPendingFallback(memory)
        && policyMetaFromMemory(memory)?.sourceTraceIds.includes(source.sourceMemoryId));
      recalled.push(...fallbackTargets.map(l2ComparisonRecord));
      const nextTargets = new Map(targets);
      recalled.forEach((target) => nextTargets.set(target.id, target));
      const next: Batch = { sources: [...batch.sources, source], records: [...batch.records, record], targets: [...nextTargets.values()] };
      if (this.batchInput(next).length + L2_EXTRACTION_SYSTEM_PROMPT.length > maxChars) {
        if (!batch.sources.length) throw new Error(`l2 extraction: complete L1 ${source.sourceMemoryId} and comparison candidates exceed input budget; evidence retained pending`);
        break;
      }
      batch.sources = next.sources; batch.records = next.records; batch.targets = next.targets;
      recalled.forEach((target) => targets.set(target.id, target));
    }
    return batch;
  }

  private batchInput(batch: Batch): string {
    return JSON.stringify({ L1_RECORDS: batch.records, HISTORICAL_L2_CANDIDATES: batch.targets });
  }

  private async extractBatch(job: EvolutionJobRecord, scope: string, batch: Batch, renew: () => void): Promise<void> {
    const input = this.batchInput(batch);
    const snapshotKey = `l2.extract.snapshot.v1:${digest({ scope, input })}`;
    const snapshot = this.deps.repos.runtime.getKv(snapshotKey)?.value;
    if (isRecord(snapshot) && snapshot.status === "committed") return;
    const at = this.now();
    this.deps.repos.runtime.setKv(snapshotKey, {
      status: "pending", jobId: job.id, scope, input: JSON.parse(input), createdAt: at
    }, at);
    const targetVersions = new Map(batch.targets.map((target) => [target.id, target.version]));
    let operations: L2ExtractionOperation[] | undefined;
    let invalid: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      renew();
      const response = await this.deps.skillLlm.completeJson<Record<string, unknown>>([
        { role: "system", content: L2_EXTRACTION_SYSTEM_PROMPT },
        { role: "system", content: languageSteeringLine(steeredPromptLanguage(this.deps.config.language, batch.sources.flatMap((source) => {
          const trace = traceMetaFromMemory(source.memory);
          return [trace?.userText, trace?.agentText, trace?.reflection];
        }))) },
        { role: "user", content: input }
      ], {
        operation: "l2.extraction.v1", thinkingMode: "disabled", temperature: 0.1,
        maxTokens: this.deps.config.algorithm.l2Induction.maxOutputTokens,
        retryTokenCeiling: this.deps.config.algorithm.l2Induction.maxOutputTokens, requireCompleteJson: true
      });
      try {
        operations = validateL2ExtractionResult(response, batch.sources.map((source) => source.sourceMemoryId), targetVersions);
        break;
      } catch (error) { invalid = error; }
    }
    if (!operations) throw invalid ?? new Error("l2 extraction: model output validation failed");
    const validated = operations;
    this.deps.repos.transaction(() => {
      renew();
      this.assertSourcesCurrent(batch.sources);
      for (const target of batch.targets) {
        const current = this.deps.repos.memories.get(target.id);
        if (!current || !validL2(current) || scopeOf(current) !== scope || digest(l2ComparisonRecord(current)) !== digest(target)) {
          throw new Error(`l2 extraction: target changed during extraction: ${target.id}`);
        }
      }
      for (const operation of validated) this.applyOperation(operation, batch.sources, at);
      this.reconcileFallbacks(batch, validated, at);
      markL2CandidatesProcessed(this.deps.repos, batch.sources, validated, at);
      this.deps.repos.runtime.setKv(snapshotKey, { status: "committed", jobId: job.id, scope,
        input: JSON.parse(input), operations: validated, createdAt: at, committedAt: this.now() }, this.now());
    });
  }

  private assertSourcesCurrent(sources: L2Candidate[]): void {
    for (const source of sources) {
      const memory = this.deps.repos.memories.get(source.sourceMemoryId);
      const persisted = this.deps.repos.runtime.getUnifiedL2Candidate(source.id, source.userId);
      const evidence = isRecord(persisted?.evidence) ? persisted.evidence : {};
      if (!memory || !validL1(memory) || memory.version !== source.memory.version
        || digest(evidence.routes) !== digest(source.routes)
        || scopeOf(memory) !== scopeOf(source.memory)
        || digest(l1ExtractionRecord({ ...source, memory })) !== digest(l1ExtractionRecord(source))) {
        throw new Error(`l2 extraction: source changed during extraction: ${source.sourceMemoryId}`);
      }
    }
  }

  private applyOperation(operation: L2ExtractionOperation, sources: L2Candidate[], at: string): void {
    const evidence = sources.filter((source) => operation.l1_ids.includes(source.sourceMemoryId));
    const key = `l2.extract.operation.v1:${digest({ operation, sources: evidence.map((source) => [source.sourceMemoryId, source.sourceVersion]) })}`;
    if (this.deps.repos.runtime.getKv(key)) return;
    if (operation.operation === "create") {
      this.createLesson(operation.new_l2, evidence, key, at, false);
    } else if (operation.operation === "support" || operation.operation === "refute") {
      const target = this.deps.repos.memories.get(operation.target_l2.id)!;
      for (const source of evidence) {
        this.deps.repos.runtime.insertTracePolicyLink({ userId: source.userId, l1MemoryId: source.sourceMemoryId,
          l2MemoryId: target.id, relation: operation.operation === "support" ? "supports" : "refutes_pending", strength: 1, createdAt: at });
        if (source.episodeId) this.deps.repos.runtime.appendEpisodeDerivedMemory(source.episodeId, "L2", target.id, at);
      }
      if (operation.operation === "support") this.addSupport(target, evidence, at);
      // Refutation is deliberately just a pending relation, never a lifecycle/gain change.
    }
    this.deps.repos.runtime.setKv(key, { operation, committedAt: at }, at);
  }

  private addSupport(memory: MemoryRow, sources: L2Candidate[], at: string): void {
    const meta = policyMetaFromMemory(memory);
    const policy = isRecord(memory.properties.internal_info.policy) ? memory.properties.internal_info.policy : {};
    const traceIds = [...new Set([...(meta?.sourceTraceIds ?? []), ...sources.map((source) => source.sourceMemoryId)])];
    const episodeIds = [...new Set([...(meta?.sourceEpisodeIds ?? []), ...sources.flatMap((source) => source.episodeId ? [source.episodeId] : [])])];
    const support = Math.max(meta?.support ?? 0, episodeIds.length);
    const specialIds = [...new Set([...strings(policy.special_source_trace_ids),
      ...sources.filter((source) => source.routes.some((route) => route !== "ordinary")).map((source) => source.sourceMemoryId)])];
    const successfulIds = [...new Set([...strings(policy.successful_source_trace_ids),
      ...sources.filter(ordinarySuccess).map((source) => source.sourceMemoryId)])].filter((id) => !specialIds.includes(id));
    const fields = { support, source_memory_ids: traceIds, source_l1_memory_ids: traceIds, source_trace_ids: traceIds,
      source_episode_ids: episodeIds, special_source_trace_ids: specialIds, successful_source_trace_ids: successfulIds };
    const updated = this.deps.repos.memories.update({ ...memory, updatedAt: at,
      info: { ...memory.info, ...fields },
      properties: { ...memory.properties, info: { ...(memory.properties.info ?? {}), ...fields },
        internal_info: { ...memory.properties.internal_info, ...fields,
          policy: { ...policy, ...fields } } }
    });
    this.appendChange(updated, memory, "unified_l2_supported", at);
    if (!this.isPendingFallback(updated)) this.deps.recomputePolicyStats?.(updated.id, at);
  }

  private createLesson(lesson: NewL2Lesson, sources: L2Candidate[], operationKey: string, at: string, fallback: boolean): MemoryRow {
    const source = sources[0]!.memory;
    const traceIds = sources.map((candidate) => candidate.sourceMemoryId);
    const episodeIds = [...new Set(sources.flatMap((candidate) => candidate.episodeId ? [candidate.episodeId] : []))];
    const signals = sources.flatMap((candidate) => candidate.signals);
    const feedbackIds = [...new Set(signals.flatMap((signal) => signal.feedbackId ? [signal.feedbackId] : []))];
    const repairIds = [...new Set(signals.flatMap((signal) => signal.repairId ? [signal.repairId] : []))];
    const key = `l2:unified:${digest(operationKey)}`;
    const existing = this.deps.repos.memories.getByKey("L2", key);
    if (existing) {
      const added = sources.filter((candidate) => !policyMetaFromMemory(existing)?.sourceTraceIds.includes(candidate.sourceMemoryId));
      if (validL2(existing) && added.length) {
        for (const candidate of added) {
          this.deps.repos.runtime.insertTracePolicyLink({ userId: source.userId, l1MemoryId: candidate.sourceMemoryId,
            l2MemoryId: existing.id, relation: "supports", createdAt: at });
          if (candidate.episodeId) this.deps.repos.runtime.appendEpisodeDerivedMemory(candidate.episodeId, "L2", existing.id, at);
        }
        this.addSupport(existing, added, at);
      }
      return this.deps.repos.memories.get(existing.id)!;
    }
    const negative = sources.some((candidate) => candidate.routes.includes("negative"))
      || signals.some((signal) => signal.polarity === "negative" || signal.polarity === "mixed");
    const ordinaryOnly = sources.every((candidate) => candidate.routes.length === 1 && candidate.routes[0] === "ordinary");
    const successfulIds = sources.filter(ordinarySuccess).map((candidate) => candidate.sourceMemoryId);
    const specialIds = sources.filter((candidate) => candidate.routes.some((route) => route !== "ordinary")).map((candidate) => candidate.sourceMemoryId);
    const confidenceCaps = signals.flatMap((signal) => typeof signal.confidenceCap === "number" ? [signal.confidenceCap] : []);
    const fields = { schema_version: 2, lesson_type: lesson.type, support: episodeIds.length, gain: 0, raw_gain: 0,
      status: "candidate", source_memory_ids: traceIds, source_l1_memory_ids: traceIds,
      source_trace_ids: traceIds, source_episode_ids: episodeIds, source_feedback_ids: feedbackIds, source_repair_ids: repairIds,
      successful_source_trace_ids: successfulIds, special_source_trace_ids: specialIds,
      evidence_event_count: traceIds.length,
      successful_episode_count: new Set(sources.filter(ordinarySuccess).flatMap((candidate) => candidate.episodeId ? [candidate.episodeId] : [])).size,
      pending_conflict_count: 0, gain_status: "not_computed",
      generation_method: fallback ? "rule_fallback" : "model", extraction_status: fallback ? "pending_model" : "complete",
      source_routes: [...new Set(sources.flatMap((candidate) => candidate.routes))],
      source_basis: [...new Set(signals.flatMap((signal) => signal.sourceBasis ? [signal.sourceBasis] : []))],
      ...(confidenceCaps.length ? { policy_confidence: Math.min(...confidenceCaps), confidence_cap: Math.min(...confidenceCaps) } : {}),
      // A model's support/create decision is not a successful execution or Skill validation.
      skill_eligible: !fallback && ordinaryOnly && successfulIds.length > 0,
      evidence_polarity: negative ? "negative" : ordinaryOnly ? "positive" : "neutral",
      experience_type: negative ? "failure_avoidance" : ordinaryOnly ? "success_pattern" : "repair_instruction" };
    const memory = this.deps.buildMemory({ userId: source.userId, conversationId: source.conversationId,
      sessionId: source.sessionId, agentId: source.agentId, appId: source.appId,
      projectId: projectIdFromMemory(source), profileId: profileIdFromMemory(source),
      layer: "L2", kind: "policy", lifecycleStatus: "candidate", memoryType: "LongTermMemory", key,
      value: [`# ${lesson.title}`, `Applicability: ${lesson.applicability}`, `Content: ${lesson.content}`,
        `Verification: ${lesson.verification}`, `Exclusions: ${lesson.exclusions}`].join("\n\n"),
      tags: ["policy", "unified-l2", lesson.type], info: fields,
      internal: { ...fields, source: SOURCE, plugin_algorithm: "l2.extraction.v1", rule_fallback: fallback,
        operation_key: operationKey, source_versions: Object.fromEntries(sources.map((candidate) => [candidate.sourceMemoryId, candidate.sourceVersion])),
        policy: { ...fields, title: lesson.title, trigger: lesson.applicability, procedure: lesson.content,
          verification: lesson.verification, boundary: lesson.exclusions } }, createdAt: at
    });
    const result = this.deps.upsertEvolutionMemory(memory);
    for (const candidate of sources) {
      this.deps.repos.runtime.insertTracePolicyLink({ userId: source.userId, l1MemoryId: candidate.sourceMemoryId,
        l2MemoryId: result.memory.id, relation: "supports", createdAt: at });
      if (candidate.episodeId) this.deps.repos.runtime.appendEpisodeDerivedMemory(candidate.episodeId, "L2", result.memory.id, at);
    }
    this.appendChange(result.memory, result.previous, fallback ? "unified_l2_feedback_rule_fallback" : "unified_l2_created", at);
    // New lessons always begin as candidates. A later support/reward lifecycle pass may
    // compute gain and activation; creation itself never schedules Skill crystallization.
    if (this.deps.config.algorithm.capture.embedAfterCapture) this.deps.enqueueJob({ jobType: "embedding", userId: source.userId,
      sessionId: source.sessionId, episodeId: sources[0]!.episodeId ?? undefined,
      targetMemoryId: result.memory.id, payload: { reason: "unified_l2.created" }, createdAt: at });
    return result.memory;
  }

  private persistFeedbackFallbacks(candidates: L2Candidate[], renew: () => void): void {
    this.deps.repos.transaction(() => {
      renew();
      for (const candidate of candidates) {
        const pending = listL2Candidates(this.deps.repos, { userId: candidate.userId, episodeId: candidate.episodeId })
          .find((item) => item.id === candidate.id && item.sourceVersion === candidate.sourceVersion);
        if (!pending) continue;
        const current = this.deps.repos.memories.get(candidate.sourceMemoryId);
        if (!current || !validL1(current) || current.version !== candidate.memory.version) continue;
        for (const signal of candidate.signals) {
          if (signal.route !== "feedback" || !signal.fallback) continue;
          const fallback = signal.fallback;
          const lesson: NewL2Lesson = { type: fallback.type, title: fallback.title,
            applicability: fallback.applicability.join("\n"), content: fallback.content.join("\n"),
            verification: fallback.verification.join("\n"), exclusions: fallback.exclusions.join("\n") };
          if (!lesson.title.trim() || !lesson.content.trim()) continue;
          const key = `l2.extract.fallback.v1:${digest({ scope: scopeOf(candidate.memory), event: signal.eventId, lesson })}`;
          const saved = this.deps.repos.runtime.getKv(key)?.value;
          if (isRecord(saved) && typeof saved.memoryId === "string") {
            const previous = this.deps.repos.memories.get(saved.memoryId);
            if (previous && policyMetaFromMemory(previous)?.sourceTraceIds.includes(candidate.sourceMemoryId)) continue;
          }
          const memory = this.createLesson(lesson, [candidate], key, this.now(), true);
          this.deps.repos.runtime.setKv(key, { memoryId: memory.id, eventId: signal.eventId, createdAt: this.now() }, this.now());
        }
      }
    });
  }

  private isPendingFallback(memory: MemoryRow): boolean {
    const internal = memory.properties.internal_info;
    const policy = isRecord(internal.policy) ? internal.policy : {};
    return (policy.generation_method ?? internal.generation_method) === "rule_fallback"
      && (policy.extraction_status ?? internal.extraction_status) === "pending_model";
  }

  private reconcileFallbacks(batch: Batch, operations: L2ExtractionOperation[], at: string): void {
    for (const target of batch.targets) {
      const memory = this.deps.repos.memories.get(target.id);
      if (!memory || !this.isPendingFallback(memory)) continue;
      const confirmed = operations.some((operation) => operation.operation === "support" && operation.target_l2.id === target.id);
      const internal = memory.properties.internal_info;
      const policy = isRecord(internal.policy) ? internal.policy : {};
      const sourceIds = policyMetaFromMemory(memory)?.sourceTraceIds ?? [];
      const reviewedIds = batch.sources.map((source) => source.sourceMemoryId).filter((id) => sourceIds.includes(id));
      // A similar fallback belonging to another L1 is merely a comparison candidate.
      // Ignoring the current evidence must not retire that unrelated pending draft.
      if (!confirmed && reviewedIds.length === 0) continue;
      const reviewed = [...new Set([...strings(policy.model_reviewed_source_trace_ids), ...reviewedIds])];
      const fullyReviewed = sourceIds.every((id) => reviewed.includes(id));
      const fields = confirmed
        ? { generation_method: "model_confirmed", extraction_status: "complete", rule_fallback: false }
        : fullyReviewed
          ? { generation_method: "rule_fallback", extraction_status: "retired", status: "archived", rule_fallback: true }
          : { generation_method: "rule_fallback", extraction_status: "pending_model", rule_fallback: true };
      const retire = !confirmed && fullyReviewed;
      const updated = this.deps.repos.memories.update({ ...memory, updatedAt: at,
        ...(retire ? { status: "archived" as const } : {}), info: { ...memory.info, ...fields },
        properties: { ...memory.properties, ...(retire ? { status: "archived" as const } : {}),
          info: { ...(memory.properties.info ?? {}), ...fields },
          internal_info: { ...internal, ...fields, policy: { ...policy, ...fields, model_reviewed_source_trace_ids: reviewed } } }
      });
      this.appendChange(updated, memory, confirmed ? "unified_l2_fallback_confirmed"
        : retire ? "unified_l2_fallback_retired" : "unified_l2_fallback_partially_reviewed", at);
      if (confirmed) this.deps.recomputePolicyStats?.(updated.id, at);
    }
  }

  private appendChange(memory: MemoryRow, previous: MemoryRow | undefined, changeType: string, at: string): void {
    this.deps.repos.runtime.appendChange({ memoryId: memory.id, namespaceId: this.deps.namespaceIdFromMemory(memory),
      kind: "policy", op: previous ? "updated" : "created", entityId: memory.id, userId: memory.userId,
      changeType, before: previous, after: memory, source: SOURCE, createdAt: at });
  }
}
