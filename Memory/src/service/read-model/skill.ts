/**
 * Read/write projection for Skill memories.
 *
 * This module deliberately does not import MemoryService.  The service owns
 * authorization, session lifecycle, and persistence policy; this projection
 * receives those capabilities through SkillReadModelDeps instead.
 */
import type {
  EpisodeRecord,
  SessionRecord,
  SkillTrialRecord
} from "../../storage/repositories.js";
import type {
  MemoryDetailItem,
  MemoryFilter,
  MemoryListItem,
  MemoryRow,
  RequestEnvelope,
  RuntimeNamespace,
  SkillUseRequest
} from "../../types.js";

export type SkillServiceErrorCode =
  | "invalid_argument"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export interface SkillMetadata {
  name: string;
  eta: number;
  support: number;
  sourcePolicyIds: string[];
  sourceWorldModelIds: string[];
  evidenceAnchorIds: string[];
  invocationGuide: string;
  trialsAttempted: number;
  trialsPassed: number;
  successRate: number;
  betaPosterior: SkillBetaPosterior;
}

export interface SkillBetaPosterior {
  alpha: number;
  beta: number;
  mean: number;
}

export interface SkillUsageStats {
  usageCount: number;
  lastUsedAt?: string;
  pendingTrials: number;
  trialsAttempted: number;
  trialsPassed: number;
  successRate: number;
  betaPosterior: SkillBetaPosterior;
}

export interface SkillMemoryRepository {
  get(id: string): MemoryRow | undefined;
  getMany(ids: string[]): MemoryRow[];
  list(filter: MemoryFilter, limit?: number, offset?: number): MemoryRow[];
  search(query: string, filter: MemoryFilter, limit?: number): Array<{ id: string }>;
  toListItem(memory: MemoryRow): MemoryListItem;
}

export interface SkillRuntimeRepository {
  getIdempotency(key: string): {
    requestHash: string;
    response: unknown;
  } | undefined;
  saveIdempotency(key: string, requestHash: string, response: unknown): void;
  listSkillTrials(input?: {
    userId?: string;
    skillMemoryId?: string;
    sessionId?: string;
    episodeId?: string;
    l1MemoryId?: string;
    rawTurnId?: string;
    status?: SkillTrialRecord["status"];
    outcome?: SkillTrialRecord["outcome"];
    limit?: number;
  }): SkillTrialRecord[];
  latestChangeSeq(userId?: string, namespaceId?: string): number;
  insertSkillTrial(trial: SkillTrialRecord): SkillTrialRecord;
  appendEpisodeDerivedMemory(
    episodeId: string,
    memoryLayer: "Skill",
    memoryId: string,
    createdAt: string
  ): void;
  appendChange(change: {
    memoryId: string;
    namespaceId: string;
    kind: "skill_trial";
    op: "created";
    entityId: string;
    userId: string;
    changeType: "skill_trial";
    after: SkillTrialRecord;
    source: "skill.use";
    createdAt: string;
  }): number;
}

export interface SkillReadModelDeps {
  repositories: {
    memories: SkillMemoryRepository;
    runtime: SkillRuntimeRepository;
  };

  /** Read/write feature gates and all authorization/scope enforcement. */
  assertMemorySearchEnabled(): void;
  assertMemoryAddEnabled(): void;
  assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void;
  assertSessionInScope(session: SessionRecord, namespace?: RuntimeNamespace): void;
  requireOpenSession(sessionId: string): SessionRecord;

  /** Session and trial-evidence policy stays owned by the composing service. */
  ensureEpisode(session: SessionRecord, episodeId?: string): EpisodeRecord;
  resolveSkillTrialEvidence(
    request: SkillUseRequest,
    session: SessionRecord,
    episode: EpisodeRecord
  ): { l1MemoryId?: string; rawTurnId?: string };

  /** Cursor encoding is externally owned to keep sync compatibility stable. */
  encodeChangeCursor(changeSeq: number, namespace?: RuntimeNamespace): string;

  /** Domain read-model adapters, injected to avoid hidden service coupling. */
  skillMetaFromMemory(memory: MemoryRow): SkillMetadata | null;
  detailFromMemory(memory: MemoryRow): MemoryDetailItem;
  procedureFromSkillMemory(memory: MemoryRow): string[] | undefined;
  namespaceForSession(session: SessionRecord): RuntimeNamespace;
  namespaceForMemory(memory: MemoryRow): RuntimeNamespace;

  nowIso(): string;
  newId(prefix: string): string;
  stableHash(value: unknown): string;
  createError(code: SkillServiceErrorCode, message: string): Error;
}

export interface ListSkillsRequest extends RequestEnvelope {
  userId?: string;
  q?: string;
  tags?: string[];
  limit?: number;
  cursor?: number;
}

export type SkillListItem = MemoryListItem & {
  name: string;
  invocationGuide?: string;
  reliabilityScore?: number;
  usageCount?: number;
  pendingTrials?: number;
  successRate?: number;
  betaPosterior?: SkillBetaPosterior;
  utilityScore?: number;
  evidenceCount?: number;
  lastUsedAt?: string;
};

export interface SkillDetail extends MemoryDetailItem {
  name: string;
  invocationGuide: string;
  procedure?: string[];
  sourcePolicyIds: string[];
  sourceWorldModelIds: string[];
  evidenceAnchorIds: string[];
  reliability: {
    eta: number;
    supportCount: number;
    usageCount: number;
    lastUsedAt?: string;
    pendingTrials: number;
    successRate: number;
    betaPosterior: SkillBetaPosterior;
    trialsAttempted: number;
    trialsPassed: number;
  };
}

export interface SkillUseResponse {
  skillId: string;
  trialId: string;
  status: "pending";
  changeSeq: number;
  syncCursor: string;
  serverTime: string;
  duplicate?: boolean;
}

/**
 * A complete Skill projection. It may be composed into MemoryService or used
 * by another transport as long as its dependencies provide the same contract.
 */
export class SkillReadModel {
  constructor(private readonly deps: SkillReadModelDeps) {}

  listSkills(input: ListSkillsRequest = {}): {
    skills: SkillListItem[];
    items: MemoryListItem[];
    nextCursor?: string;
    serverTime: string;
  } {
    this.deps.assertMemorySearchEnabled();
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? 0;
    const filter: MemoryFilter = {
      memoryLayer: "Skill",
      status: ["activated", "resolving"],
      tags: input.tags
    };
    const poolLimit = Math.max(limit + cursor + 1, limit, 50);
    const memories = input.q?.trim()
      ? this.deps.repositories.memories.getMany(
          this.deps.repositories.memories.search(input.q, filter, poolLimit).map((hit) => hit.id)
        )
      : this.deps.repositories.memories.list(filter, poolLimit);
    const page = memories.slice(cursor, cursor + limit);
    const nextCursor = memories.length > cursor + limit ? String(cursor + limit) : undefined;
    const items = page.map((memory) => this.deps.repositories.memories.toListItem(memory));
    return {
      skills: page.map((memory) =>
        skillListItem(
          this.deps.repositories.memories.toListItem(memory),
          memory,
          this.skillUsageStats(memory.id),
          this.deps.skillMetaFromMemory
        )
      ),
      items,
      nextCursor,
      serverTime: this.deps.nowIso()
    };
  }

  getSkill(skillId: string, request: RequestEnvelope = {}): SkillDetail {
    this.deps.assertMemorySearchEnabled();
    const memory = this.deps.repositories.memories.get(skillId);
    if (!memory || memory.memoryLayer !== "Skill") {
      throw this.deps.createError("not_found", `skill not found: ${skillId}`);
    }
    this.deps.assertMemoryInScope(memory, request.namespace);
    const detail = this.deps.detailFromMemory(memory);
    const skill = this.deps.skillMetaFromMemory(memory);
    const usageStats = this.skillUsageStats(skillId);
    const trialsAttempted = usageStats.trialsAttempted || skill?.trialsAttempted || 0;
    const trialsPassed = usageStats.trialsAttempted ? usageStats.trialsPassed : skill?.trialsPassed ?? 0;
    return {
      ...detail,
      name: skill?.name ?? detail.title,
      invocationGuide: skill?.invocationGuide ?? detail.body,
      procedure: this.deps.procedureFromSkillMemory(memory),
      sourcePolicyIds: skill?.sourcePolicyIds ?? [],
      sourceWorldModelIds: skill?.sourceWorldModelIds ?? [],
      evidenceAnchorIds: skill?.evidenceAnchorIds ?? [],
      reliability: {
        eta: skill?.eta ?? 0,
        supportCount: skill?.support ?? 0,
        usageCount: usageStats.usageCount,
        lastUsedAt: usageStats.lastUsedAt,
        pendingTrials: usageStats.pendingTrials,
        successRate: usageStats.trialsAttempted ? usageStats.successRate : skill?.successRate ?? 0,
        betaPosterior: usageStats.trialsAttempted
          ? usageStats.betaPosterior
          : skill?.betaPosterior ?? skillBetaPosterior(0, 0),
        trialsAttempted,
        trialsPassed
      }
    };
  }

  skillUsageStats(skillId: string): SkillUsageStats {
    const trials = this.deps.repositories.runtime.listSkillTrials({ skillMemoryId: skillId, limit: 1000 });
    const resolved = trials.filter((trial) => trial.outcome !== "unknown");
    const passed = resolved.filter((trial) => trial.outcome === "success").length;
    return {
      usageCount: trials.length,
      lastUsedAt: trials[0]?.createdAt,
      pendingTrials: trials.filter((trial) => trial.status === "pending").length,
      trialsAttempted: resolved.length,
      trialsPassed: passed,
      successRate: skillSuccessRate(resolved.length, passed),
      betaPosterior: skillBetaPosterior(resolved.length, passed)
    };
  }

  useSkill(skillId: string, request: SkillUseRequest): SkillUseResponse {
    this.deps.assertMemoryAddEnabled();
    const idempotencyKey = request.adapterId && request.requestId
      ? `skill.use:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = this.deps.stableHash({ skillId, request });
    if (idempotencyKey) {
      const existing = this.deps.repositories.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw this.deps.createError("conflict", "idempotency key reused with different skill.use request body");
        }
        return { ...(existing.response as SkillUseResponse), duplicate: true };
      }
    }

    const skill = this.deps.repositories.memories.get(skillId);
    if (!skill || skill.memoryLayer !== "Skill") {
      throw this.deps.createError("not_found", `skill not found: ${skillId}`);
    }
    if (skill.status !== "activated" && skill.status !== "resolving") {
      throw this.deps.createError("conflict", `skill is not invokable in status ${skill.status}`);
    }
    const session = this.deps.requireOpenSession(request.sessionId);
    this.deps.assertSessionInScope(session, request.namespace);
    this.deps.assertMemoryInScope(skill, request.namespace);
    const episode = this.deps.ensureEpisode(session, request.episodeId);
    const trialEvidence = this.deps.resolveSkillTrialEvidence(request, session, episode);
    const existingPendingTrial = this.deps.repositories.runtime.listSkillTrials({
      userId: session.userId,
      skillMemoryId: skill.id,
      episodeId: episode.id,
      status: "pending",
      limit: 1
    })[0];
    if (existingPendingTrial) {
      const changeSeq = this.deps.repositories.runtime.latestChangeSeq(
        session.userId,
        namespaceIdFromMemory(skill, this.deps.namespaceForMemory)
      );
      const body: SkillUseResponse = {
        skillId,
        trialId: existingPendingTrial.id,
        status: "pending",
        changeSeq,
        syncCursor: this.deps.encodeChangeCursor(changeSeq, this.deps.namespaceForSession(session)),
        serverTime: this.deps.nowIso(),
        duplicate: true
      };
      if (idempotencyKey) this.deps.repositories.runtime.saveIdempotency(idempotencyKey, requestHash, body);
      return body;
    }

    const trialId = this.deps.newId("trial");
    const trial = this.deps.repositories.runtime.insertSkillTrial({
      id: trialId,
      userId: session.userId,
      projectId: session.projectId,
      skillMemoryId: skill.id,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: trialEvidence.l1MemoryId,
      rawTurnId: request.rawTurnId ?? trialEvidence.rawTurnId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      status: "pending",
      outcome: "unknown",
      createdAt: this.deps.nowIso()
    });
    this.deps.repositories.runtime.appendEpisodeDerivedMemory(episode.id, "Skill", skill.id, trial.createdAt);
    const changeSeq = this.deps.repositories.runtime.appendChange({
      memoryId: skill.id,
      namespaceId: namespaceIdFromMemory(skill, this.deps.namespaceForMemory),
      kind: "skill_trial",
      op: "created",
      entityId: trial.id,
      userId: session.userId,
      changeType: "skill_trial",
      after: trial,
      source: "skill.use",
      createdAt: trial.createdAt
    });
    const body: SkillUseResponse = {
      skillId,
      trialId,
      status: "pending",
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq, this.deps.namespaceForSession(session)),
      serverTime: this.deps.nowIso()
    };
    if (idempotencyKey) this.deps.repositories.runtime.saveIdempotency(idempotencyKey, requestHash, body);
    return body;
  }
}

export function skillListItem(
  item: MemoryListItem,
  memory: MemoryRow,
  usageStats: SkillUsageStats | undefined,
  readSkillMeta: (memory: MemoryRow) => SkillMetadata | null
): SkillListItem {
  const skill = readSkillMeta(memory);
  return {
    ...item,
    name: skill?.name ?? item.title,
    invocationGuide: skill?.invocationGuide,
    reliabilityScore: skill?.eta,
    usageCount: usageStats?.usageCount,
    pendingTrials: usageStats?.pendingTrials,
    successRate: usageStats?.trialsAttempted ? usageStats.successRate : skill?.successRate,
    betaPosterior: usageStats?.trialsAttempted ? usageStats.betaPosterior : skill?.betaPosterior,
    utilityScore: skill?.eta,
    evidenceCount: skill?.evidenceAnchorIds.length,
    lastUsedAt: usageStats?.lastUsedAt
  };
}

export function skillSuccessRate(attempted: number, passed: number): number {
  if (attempted <= 0) return 0;
  return clampNumber(passed / attempted, 0, 1);
}

export function skillBetaPosterior(attempted: number, passed: number): SkillBetaPosterior {
  const safeAttempted = Math.max(0, Math.floor(attempted));
  const safePassed = Math.min(safeAttempted, Math.max(0, Math.floor(passed)));
  const alpha = safePassed + 1;
  const beta = safeAttempted - safePassed + 1;
  return { alpha, beta, mean: clampNumber(alpha / (alpha + beta), 0, 1) };
}

function namespaceIdFromMemory(
  memory: MemoryRow,
  namespaceForMemory: (memory: MemoryRow) => RuntimeNamespace
): string {
  const namespace = namespaceForMemory(memory);
  return [
    namespace.tenantId,
    namespace.userId,
    namespace.projectId ?? namespace.workspaceId,
    namespace.source,
    namespace.profileId
  ].filter(Boolean).join(":");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
