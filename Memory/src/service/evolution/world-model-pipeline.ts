import {
  L3_ABSTRACTION_PROMPT,
  buildWorldModelDraft,
  cosine,
  detectDominantLanguage,
  languageSteeringLine,
  policyMetaFromMemory,
  shapeWorldModelConfidence,
  traceMetaFromMemory,
  worldModelMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import { kindFromMemory,type EvolutionJobRecord,type Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { nowIso } from "../../utils/time.js";
import { profileIdFromMemory,projectIdFromMemory } from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { logEvolutionDecision } from "./evolution-logging.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;
type WorldModelMeta = NonNullable<ReturnType<typeof worldModelMetaFromMemory>>;
type WorldModelDraft = ReturnType<typeof buildWorldModelDraft>[number];
type WorldModelEnhancementResult =
  | { ok: true; draft: WorldModelDraft }
  | { ok: false; fallback: WorldModelDraft; reason: string };

const SKILL_HTML_BLOCK_RE = /<\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SKILL_DANGEROUS_TAG_RE = /<\/?\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>/gi;
const SKILL_HTML_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi;
const SKILL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SKILL_MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(((?:\\.|[^()\n]|\([^()\n]*\))+)\)/g;

export interface WorldModelPipelineDeps {
  repos: Repositories;
  config: MemmyConfig;
  skillLlm: LlmClient;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  isArchivedEvolutionMemory(memory: MemoryRow): boolean;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
}

export class WorldModelPipeline {
  constructor(private readonly deps: WorldModelPipelineDeps) {}

  async abstractL3(job: EvolutionJobRecord): Promise<void> {
    const source = this.l3AbstractionSourceForJob(job);
    const userId = source?.userId ?? job.userId;
    const at = nowIso();
    const policies = this.deps.repos.memories
      .list({ memoryLayer: "L2", status: "activated" }, 1000)
      .map(policyMetaFromMemory)
      .filter((policy): policy is NonNullable<ReturnType<typeof policyMetaFromMemory>> =>
        Boolean(policy)
      );
    const domainTagsFilter = stringArray(job.payload.domainTagsFilter);
    const filteredPolicies = domainTagsFilter.length > 0
      ? policies.filter((policy) =>
          policy.memory.tags.some((tag) => domainTagsFilter.includes(tag.toLowerCase()))
        )
      : policies;
    const fallbackDrafts = buildWorldModelDraft({
      policies: filteredPolicies,
      minPolicies: this.deps.config.algorithm.l3Abstraction.minPolicies,
      minPolicyGain: this.deps.config.algorithm.l3Abstraction.minPolicyGain,
      minPolicySupport: this.deps.config.algorithm.l3Abstraction.minPolicySupport,
      clusterMinSimilarity: this.deps.config.algorithm.l3Abstraction.clusterMinSimilarity
    });
    if (fallbackDrafts.length === 0) {
      logEvolutionDecision(job, "l3_abstraction", "no_eligible_cluster", {
        policyCount: policies.length,
        filteredPolicyCount: filteredPolicies.length,
        minPolicies: this.deps.config.algorithm.l3Abstraction.minPolicies,
        minPolicyGain: this.deps.config.algorithm.l3Abstraction.minPolicyGain,
        minPolicySupport: this.deps.config.algorithm.l3Abstraction.minPolicySupport,
        clusterMinSimilarity: this.deps.config.algorithm.l3Abstraction.clusterMinSimilarity
      });
    }
    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const readyDrafts: WorldModelDraft[] = [];
    for (const draft of fallbackDrafts) {
      if (this.l3DomainInCooldown(userId, draft.domainKey, at)) {
        logEvolutionDecision(job, "l3_abstraction", "cooldown", {
          policyCount: draft.policyIds.length
        });
        this.deps.repos.runtime.appendChange({
          memoryId: source?.id ?? draft.key,
          namespaceId: source ? this.deps.namespaceIdFromMemory(source) : undefined,
          kind: "world_model",
          op: "skipped",
          entityId: draft.key,
          userId,
          changeType: "l3_abstraction_skipped",
          after: {
            domainKey: draft.domainKey,
            policyIds: draft.policyIds,
            reason: "cooldown"
          },
          source: "worker.l3_abstraction.v7",
          createdAt: at
        });
        continue;
      }
      readyDrafts.push(draft);
    }
    const enhancements = await this.enhanceWorldModelDrafts(readyDrafts, policies, userId);
    for (const enhancement of enhancements) {
      if (!enhancement.ok) {
        const anchorPolicy = enhancement.fallback.policyIds
          .map((policyId) => policyById.get(policyId))
          .find((policy): policy is PolicyMeta => Boolean(policy));
        const anchorMemory = source ?? anchorPolicy?.memory;
        logEvolutionDecision(job, "l3_abstraction", enhancement.reason, {
          sourceMemoryId: anchorMemory?.id,
          policyCount: enhancement.fallback.policyIds.length
        });
        this.deps.repos.runtime.appendChange({
          memoryId: anchorMemory?.id ?? enhancement.fallback.key,
          namespaceId: anchorMemory ? this.deps.namespaceIdFromMemory(anchorMemory) : undefined,
          kind: "world_model",
          op: "skipped",
          entityId: enhancement.fallback.key,
          userId,
          changeType: "l3_abstraction_skipped",
          after: {
            domainKey: enhancement.fallback.domainKey,
            policyIds: enhancement.fallback.policyIds,
            reason: enhancement.reason
          },
          source: "worker.l3_abstraction.v7",
          createdAt: at
        });
        continue;
      }
      const rawDraft = enhancement.draft;
      const existing = this.findWorldModelMergeTarget(rawDraft, userId);
      const draft = existing
        ? mergeWorldModelDraftForUpdate(rawDraft, existing, this.deps.config.algorithm.l3Abstraction.confidenceDelta)
        : rawDraft;
      const l3 = this.deps.buildMemory({
        userId,
        conversationId: source?.conversationId,
        sessionId: source?.sessionId ?? job.sessionId,
        agentId: source?.agentId,
        appId: source?.appId,
        projectId: source ? projectIdFromMemory(source) : undefined,
        profileId: source ? profileIdFromMemory(source) : undefined,
        layer: "L3",
        kind: "world_model",
        memoryType: "LongTermMemory",
        key: draft.key,
        value: draft.body,
        tags: draft.tags,
        info: {
          domain_key: draft.domainKey,
          confidence: draft.confidence,
          cohesion: draft.cohesion,
          admission: draft.admission,
          source_memory_ids: draft.policyIds
        },
        internal: {
          source: "worker.l3_abstraction.v7",
          plugin_algorithm: "l3.abstraction.v7",
          source_memory_ids: draft.policyIds,
          title: draft.title,
          body: draft.body,
          structure: draft.structure,
          domain_tags: draft.domainTags,
          source_policy_ids: draft.policyIds,
          world_model_confidence: draft.confidence,
          world_model: {
            title: draft.title,
            domain_key: draft.domainKey,
            domain_tags: draft.domainTags,
            policy_ids: draft.policyIds,
            confidence: draft.confidence,
            cohesion: draft.cohesion,
            admission: draft.admission,
            structure: draft.structure,
            body: draft.body,
            vec: draft.vec
          }
        },
        createdAt: at
      });
      const upsert = this.deps.upsertEvolutionMemory(l3);
      this.markL3DomainRun(userId, draft.domainKey, at);
      const sourceEpisodeIds = uniq(
        policies
          .filter((policy) => draft.policyIds.includes(policy.id))
          .flatMap((policy) => policy.sourceEpisodeIds)
      );
      for (const episodeId of sourceEpisodeIds) {
        this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L3", upsert.memory.id, at);
      }
      this.deps.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId,
        changeType: upsert.created ? "create" : "l3_merge",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.l3_abstraction.v7",
        createdAt: at
      });
      if (this.deps.config.algorithm.capture.embedAfterCapture) {
        this.deps.enqueueJob({
          jobType: "embedding",
          userId,
          sessionId: source?.sessionId ?? job.sessionId,
          episodeId: job.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "l3.upserted" },
          createdAt: at
        });
      }
    }
  }

private l3DomainInCooldown(userId: string, domainKey: string, at: string): boolean {
    const cooldownDays = this.deps.config.algorithm.l3Abstraction.cooldownDays;
    if (cooldownDays <= 0) return false;
    const item = this.deps.repos.runtime.getKv(l3CooldownKey(userId, domainKey));
    const lastRunAt = isRecord(item?.value) && typeof item.value.at === "string"
      ? Date.parse(item.value.at)
      : item?.updatedAt
      ? Date.parse(item.updatedAt)
      : NaN;
    const now = Date.parse(at);
    if (!Number.isFinite(lastRunAt) || !Number.isFinite(now)) return false;
    return now - lastRunAt < cooldownDays * 24 * 60 * 60 * 1000;
  }

private markL3DomainRun(userId: string, domainKey: string, at: string): void {
    this.deps.repos.runtime.setKv(l3CooldownKey(userId, domainKey), { at, domainKey }, at);
  }

private l3AbstractionSourceForJob(job: EvolutionJobRecord): MemoryRow | undefined {
    const seedPolicyId = typeof job.payload.seedPolicyId === "string"
      ? job.payload.seedPolicyId
      : typeof job.payload.l2MemoryId === "string"
      ? job.payload.l2MemoryId
      : typeof job.payload.policyId === "string"
      ? job.payload.policyId
      : undefined;
    const seedPolicy = seedPolicyId ? this.deps.repos.memories.get(seedPolicyId) : undefined;
    if (seedPolicy && seedPolicy.memoryLayer === "L2") {
      return seedPolicy;
    }
    const payloadSourceMemoryId = typeof job.payload.sourceMemoryId === "string"
      ? job.payload.sourceMemoryId
      : typeof job.payload.l1MemoryId === "string"
      ? job.payload.l1MemoryId
      : undefined;
    const payloadSource = payloadSourceMemoryId ? this.deps.repos.memories.get(payloadSourceMemoryId) : undefined;
    if (payloadSource) {
      return payloadSource;
    }
    return job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
  }

private findWorldModelMergeTarget(
    draft: WorldModelDraft,
    userId: string
  ): MemoryRow | undefined {
    const exact = this.deps.repos.memories.getByKey(userId, "L3", draft.key);
    if (
      exact &&
      !this.deps.isArchivedEvolutionMemory(exact)
    ) {
      return exact;
    }
    const draftPolicyIds = new Set(draft.policyIds);
    let bestOverlap: { memory: MemoryRow; score: number; shared: number; confidence: number } | undefined;
    let bestVector: { memory: MemoryRow; score: number } | undefined;
    const candidates = this.deps.repos.memories
      .list({ memoryLayer: "L3", status: ["activated", "resolving"] }, 1000)
      .map((memory) => ({ memory, world: worldModelMetaFromMemory(memory) }))
      .filter((entry): entry is { memory: MemoryRow; world: WorldModelMeta } => Boolean(entry.world));

    for (const { memory, world } of candidates) {
      const overlap = l3PolicyOverlapScore([...draftPolicyIds], world.policyIds);
      if (overlap.score >= 0.6) {
        if (
          !bestOverlap ||
          overlap.score > bestOverlap.score ||
          (overlap.score === bestOverlap.score && overlap.shared > bestOverlap.shared) ||
          (
            overlap.score === bestOverlap.score &&
            overlap.shared === bestOverlap.shared &&
            world.confidence > bestOverlap.confidence
          )
        ) {
          bestOverlap = { memory, score: overlap.score, shared: overlap.shared, confidence: world.confidence };
        }
      }
      const sharesDomainTag = draft.domainTags.some((tag) => world.domainTags.includes(tag));
      if (!sharesDomainTag || !draft.vec || !world.vec) continue;
      const score = cosine(draft.vec, world.vec);
      if (
        score >= this.deps.config.algorithm.l3Abstraction.clusterMinSimilarity &&
        (!bestVector || score > bestVector.score)
      ) {
        bestVector = { memory, score };
      }
    }
    return bestOverlap?.memory ?? bestVector?.memory;
  }

private gatherWorldModelEvidence(policy: PolicyMeta, userId: string): TraceMeta[] {
    const byId = new Map<string, TraceMeta>();
    for (const memory of this.deps.repos.memories.getMany(policy.sourceTraceIds)) {
      const trace = this.deps.traceMeta(memory);
      if (trace) byId.set(trace.id, trace);
    }
    if (byId.size === 0 && policy.sourceEpisodeIds.length > 0) {
      const episodeIds = new Set(policy.sourceEpisodeIds);
      const traces = this.deps.repos.memories
        .list({ memoryLayer: "L1", status: "activated" }, 1000)
        .map((memory) => this.deps.traceMeta(memory))
        .filter((trace): trace is TraceMeta =>
          Boolean(trace?.episodeId &&
            episodeIds.has(trace.episodeId))
        );
      for (const trace of traces) byId.set(trace.id, trace);
    }
    const cap = Math.max(1, this.deps.config.algorithm.l3Abstraction.traceCharCap);
    return Array.from(byId.values())
      .filter((trace) => trace.userText !== "[REDACTED]" && trace.agentText !== "[REDACTED]")
      .sort((a, b) => b.value - a.value || b.ts - a.ts)
      .slice(0, Math.max(0, this.deps.config.algorithm.l3Abstraction.traceEvidencePerPolicy))
      .map((trace) => ({
        ...trace,
        userText: capText(trace.userText, cap),
        agentText: capText(trace.agentText, cap)
      }));
  }

private async enhanceWorldModelDrafts(
    fallbacks: WorldModelDraft[],
    policies: PolicyMeta[],
    userId: string
  ): Promise<WorldModelEnhancementResult[]> {
    const out: WorldModelEnhancementResult[] = [];
    for (const fallback of fallbacks) {
      if (!fallback.vec) {
        out.push({ ok: false, fallback, reason: "no_centroid" });
        continue;
      }
      if (!this.deps.config.algorithm.l3Abstraction.useLlm || !this.deps.skillLlm.isConfigured()) {
        out.push({ ok: false, fallback, reason: "llm_disabled" });
        continue;
      }
      try {
        const selectedPolicies = policies
          .filter((policy) => fallback.policyIds.includes(policy.id))
          .slice(0, 8);
        const languageSamples: Array<string | null | undefined> = [];
        const policySummaries = selectedPolicies
          .map((policy) => {
            const traces = this.gatherWorldModelEvidence(policy, userId);
            languageSamples.push(
              policy.title,
              policy.trigger,
              policy.procedure,
              policy.verification,
              policy.boundary
            );
            for (const trace of traces) {
              languageSamples.push(trace.userText, trace.agentText, trace.reflection);
            }
            const traceBlocks = traces
              .map((trace) => [
                `  trace ${trace.id} (V=${roundNumber(trace.value)}):`,
                `  tags: ${trace.tags.join(",") || "-"}`,
                `  user: ${capText(trace.userText, 160)}`,
                `  agent: ${capText(trace.agentText, 240)}`,
                `  reflection: ${capText(trace.reflection ?? "-", 200)}`
              ].join("\n"))
              .join("\n");
            return capText([
              `- ${policy.title}`,
              `  trigger=${policy.trigger}`,
              `  procedure=${policy.procedure}`,
              `  verification=${policy.verification}`,
              `  boundary=${policy.boundary}`,
              `  support=${policy.support}; gain=${roundNumber(policy.gain)}`,
              traceBlocks ? `  evidence:\n${traceBlocks}` : undefined
            ].filter(Boolean).join("\n"), this.deps.config.algorithm.l3Abstraction.policyCharCap);
          })
          .join("\n");
        const result = await this.deps.skillLlm.completeJson<{
          title?: unknown;
          body?: unknown;
          structure?: unknown;
          environment?: unknown;
          inference?: unknown;
          constraints?: unknown;
          confidence?: unknown;
          domain_tags?: unknown;
          tags?: unknown;
        }>([
          {
            role: "system",
            content: L3_ABSTRACTION_PROMPT.system
          },
          {
            role: "system",
            content: languageSteeringLine(detectDominantLanguage(languageSamples))
          },
          {
            role: "user",
            content: [
              `CLUSTER_KEY: ${fallback.domainKey}`,
              `ADMISSION: ${fallback.admission} (cohesion=${roundNumber(fallback.cohesion)})`,
              `DOMAIN_TAGS: ${fallback.domainTags.join(", ") || "-"}`,
              `POLICIES (${selectedPolicies.length}):`,
              policySummaries
            ].join("\n")
          }
        ], {
          operation: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
          thinkingMode: "enabled",
          temperature: 0.15
        });
        const invalidReason = l3AbstractionInvalidReason(result);
        if (invalidReason) {
          out.push({ ok: false, fallback, reason: invalidReason });
          continue;
        }
        const title = skillText(result.title);
        const structure = coerceWorldModelStructure(result, fallback.structure);
        const body = typeof result.body === "string" && skillMarkdown(result.body)
          ? skillMarkdown(result.body)
          : renderWorldModelBody(title, structure);
        const domainTags = normaliseWorldModelTags(result.domain_tags);
        const effectiveDomainTags = domainTags.length > 0 ? domainTags : fallback.domainTags;
        out.push({
          ok: true,
          draft: {
            ...fallback,
            title,
            body,
            structure,
            confidence: shapeWorldModelConfidence(
              numberOr(result.confidence, fallback.confidence),
              fallback.admission,
              fallback.cohesion
            ),
            domainTags: effectiveDomainTags,
            tags: uniq([...fallback.tags, ...effectiveDomainTags, ...normaliseWorldModelTags(result.tags)])
          }
        });
      } catch (error) {
        out.push({ ok: false, fallback, reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}` });
      }
    }
    return out;
  }
}

function l3DraftInCooldown(existing: MemoryRow, cooldownDays: number, at: string): boolean {
  if (cooldownDays <= 0) return false;
  const updatedAt = Date.parse(existing.updatedAt);
  const now = Date.parse(at);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return false;
  return now - updatedAt < cooldownDays * 24 * 60 * 60 * 1000;
}

function l3PolicyOverlapScore(left: string[], right: string[]): { score: number; shared: number } {
  if (left.length === 0 || right.length === 0) return { score: 0, shared: 0 };
  const rightSet = new Set(right);
  let shared = 0;
  for (const id of new Set(left)) {
    if (rightSet.has(id)) shared += 1;
  }
  return {
    score: shared / Math.min(new Set(left).size, new Set(right).size),
    shared
  };
}

function mergeWorldModelDraftForUpdate(
  draft: WorldModelDraft,
  existing: MemoryRow,
  confidenceDelta: number
): WorldModelDraft {
  const world = worldModelMetaFromMemory(existing);
  if (!world) return draft;
  const policyIds = uniq([...world.policyIds, ...draft.policyIds]);
  const domainTags = uniq([...world.domainTags, ...draft.domainTags]);
  const confidence = clampNumber(world.confidence + confidenceDelta, 0, 1);
  return {
    ...draft,
    key: existing.memoryKey ?? draft.key,
    policyIds,
    domainTags,
    confidence,
    structure: mergeWorldModelStructure(world.structure, draft.structure),
    vec: draft.vec ?? world.vec,
    tags: uniq([...draft.tags, ...domainTags])
  };
}

function mergeWorldModelStructure(
  previous: WorldModelDraft["structure"],
  next: WorldModelDraft["structure"]
): WorldModelDraft["structure"] {
  return {
    environment: mergeWorldModelEntries(previous.environment, next.environment),
    inference: mergeWorldModelEntries(previous.inference, next.inference),
    constraints: mergeWorldModelEntries(previous.constraints, next.constraints)
  };
}

function mergeWorldModelEntries<T extends { label: string; description: string }>(previous: T[], next: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const entry of previous) byKey.set(worldModelEntryKey(entry), entry);
  for (const entry of next) byKey.set(worldModelEntryKey(entry), entry);
  return Array.from(byKey.values()).slice(0, 24);
}

function worldModelEntryKey(entry: { label: string; description: string }): string {
  return `${entry.label.toLowerCase().trim()}::${entry.description.toLowerCase().trim().slice(0, 64)}`;
}

function capText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function l3AbstractionInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: l3.abstraction.invalid: non-object output";
  if (!firstString(result.title)) return "llm-failed: l3.abstraction.invalid: missing title";
  for (const key of ["environment", "inference", "constraints"]) {
    if (!Array.isArray(result[key])) {
      return `llm-failed: l3.abstraction.invalid: missing ${key}`;
    }
  }
  return null;
}

function coerceWorldModelStructure(
  result: Record<string, unknown>,
  fallback: WorldModelDraft["structure"]
): WorldModelDraft["structure"] {
  const rawStructure = isRecord(result.structure) ? result.structure : {};
  return {
    environment: coerceWorldModelEntries(rawStructure.environment ?? result.environment, fallback.environment),
    inference: coerceWorldModelEntries(rawStructure.inference ?? result.inference, fallback.inference),
    constraints: coerceWorldModelEntries(rawStructure.constraints ?? result.constraints, fallback.constraints)
  };
}

function coerceWorldModelEntries(
  value: unknown,
  fallback: WorldModelDraft["structure"]["environment"]
): WorldModelDraft["structure"]["environment"] {
  if (!Array.isArray(value)) return fallback;
  const entries = value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label = skillText(item.label);
      const description = skillMarkdown(firstString(item.description, item.body, item.text));
      if (!label && !description) return null;
      const evidenceIds = stringArray(item.evidenceIds ?? item.evidence_ids);
      return {
        label: label || description.slice(0, 32),
        description,
        ...(evidenceIds.length > 0 ? { evidenceIds } : {})
      };
    })
    .filter((item): item is WorldModelDraft["structure"]["environment"][number] => Boolean(item))
    .slice(0, 16);
  return entries.length > 0 ? entries : fallback;
}

function normaliseWorldModelTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniq(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0 && item.length < 24)
  ).slice(0, 6);
}

function renderWorldModelBody(
  title: string,
  structure: WorldModelDraft["structure"]
): string {
  const lines: string[] = [`# ${title}`, ""];
  if (structure.environment.length > 0) {
    lines.push("## Environment");
    for (const entry of structure.environment) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  if (structure.inference.length > 0) {
    lines.push("## Inference rules");
    for (const entry of structure.inference) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  if (structure.constraints.length > 0) {
    lines.push("## Constraints");
    for (const entry of structure.constraints) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function skillText(value: unknown): string {
  return stripDangerousMarkdownLinks(stripUnsafeHtml(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillMarkdown(value: unknown): string {
  return stripDangerousMarkdownLinks(stripDangerousHtmlBlocks(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillRawString(value: unknown): string {
  return value == null ? "" : String(value);
}

function stripUnsafeHtml(text: string): string {
  return text
    .replace(SKILL_HTML_BLOCK_RE, "")
    .replace(SKILL_HTML_TAG_RE, "");
}

function stripDangerousHtmlBlocks(text: string): string {
  return text.replace(SKILL_HTML_BLOCK_RE, "").replace(SKILL_DANGEROUS_TAG_RE, "");
}

function stripDangerousMarkdownLinks(text: string): string {
  return text.replace(SKILL_MARKDOWN_LINK_RE, (_match, bang: string, label: string, rawUrl: string) => {
    const url = rawUrl.trim();
    const firstToken = url.split(/\s+/)[0] ?? "";
    if (!isSafeLinkTarget(firstToken)) return `${bang}${label}`;
    return `${bang}[${label}](${url})`;
  });
}

function isSafeLinkTarget(raw: string): boolean {
  const target = raw.trim().replace(/^["'<]+|[>"']+$/g, "");
  if (!target) return false;
  if (target.startsWith("#") || target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
    return true;
  }
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function errorMessageFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.error ?? value.message;
    if (typeof message === "string") return message;
  }
  return undefined;
}


function roundNumber(value: number, digits = 4): number {
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

function l3CooldownKey(userId: string, domainKey: string): string {
  return `l3.lastRun.${userId}.${stableHash(domainKey).slice(0, 24)}`;
}
