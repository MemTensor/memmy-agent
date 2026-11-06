import { createHash } from "node:crypto";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { CandidatePoolRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { nowIso } from "../../utils/time.js";

export type L2CandidateRoute = "ordinary" | "feedback" | "negative";

export interface L2CandidateSignal {
  eventId: string;
  route: L2CandidateRoute;
  text: string;
  feedbackId?: string;
  repairId?: string;
  polarity?: string;
  sourceBasis?: string;
  confidenceCap?: number;
  evidenceStrength?: number;
  repairValidated?: boolean;
  fallback?: {
    type: "principle" | "local_procedure" | "check" | "troubleshooting";
    title: string;
    applicability: string[];
    content: string[];
    verification: string[];
    exclusions: string[];
  };
}

export interface L2CandidateEvidence {
  schemaVersion: 2;
  episodeId: string | null;
  routes: L2CandidateRoute[];
  sourceVersion: string;
  signals: L2CandidateSignal[];
  processedAt?: string;
  operations?: unknown;
}

export interface L2Candidate {
  id: string;
  userId: string;
  sourceMemoryId: string;
  sourceVersion: string;
  episodeId: string | null;
  routes: L2CandidateRoute[];
  signals: L2CandidateSignal[];
  memory: MemoryRow;
  status: CandidatePoolRecord["status"];
  createdAt: string;
  updatedAt: string;
}

export interface UpsertL2CandidateInput {
  sourceMemoryId: string;
  userId: string;
  /** The caller has already applied this route's admission rules. */
  route: L2CandidateRoute;
  signal?: L2CandidateSignal;
  episodeId?: string | null;
  at?: string;
}

const ROUTES = new Set<L2CandidateRoute>(["ordinary", "feedback", "negative"]);

/** A candidate is one real L1, irrespective of how many eligible routes refer to it. */
export function upsertL2Candidate(repos: Repositories, input: UpsertL2CandidateInput): L2Candidate | null {
  return repos.transaction(() => {
    const source = readSource(repos, input.sourceMemoryId, input.userId);
    if (!source || !ROUTES.has(input.route)) return null;
    if (input.episodeId !== undefined && input.episodeId !== source.episodeId) return null;
    if (input.signal && (!input.signal.eventId || input.signal.route !== input.route)) return null;

    const id = `l2c_${hash([input.userId, input.sourceMemoryId])}`;
    const existing = repos.runtime.getUnifiedL2Candidate(id, input.userId);
    const previous = candidateEvidence(existing?.evidence);
    const routes = [...new Set([...(previous?.routes ?? []), input.route])].sort();
    const signals = new Map((previous?.signals ?? []).map((signal) => [signalKey(signal), signal]));
    if (input.signal) signals.set(signalKey(input.signal), normalizeSignal(input.signal));
    const mergedSignals = [...signals.values()].sort((a, b) => signalKey(a).localeCompare(signalKey(b)));
    const sourceVersion = sourceVersionFor(source.memory, source.episodeId, mergedSignals);
    const evidence: L2CandidateEvidence = {
      ...(previous?.sourceVersion === sourceVersion ? previous : {}),
      schemaVersion: 2,
      episodeId: source.episodeId,
      routes,
      sourceVersion,
      signals: mergedSignals
    };
    // Keep retry timestamps stable unless evidence or route provenance actually changes.
    const unchanged = previous && hash(previous) === hash(evidence);
    if (!unchanged) {
      const at = input.at ?? nowIso();
      repos.runtime.upsertUnifiedL2Candidate({
        id,
        userId: input.userId,
        sessionId: source.memory.sessionId,
        sourceMemoryId: input.sourceMemoryId,
        candidateKey: `l2-v2:${hash([input.userId, source.episodeId])}`,
        candidateValue: source.memory.memoryValue,
        score: 0,
        evidence,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at
      });
    }
    const saved = repos.runtime.getUnifiedL2Candidate(id, input.userId);
    return saved ? toCandidate(saved, source.memory) : null;
  });
}

/** No ordinary-route value/vector gate is reapplied to admitted special-route evidence. */
export function listL2Candidates(repos: Repositories, input: {
  userId: string;
  episodeId: string | null;
  limit?: number;
}): L2Candidate[] {
  const candidates: L2Candidate[] = [];
  for (const row of repos.runtime.listUnifiedL2Candidates(input)) {
    const evidence = candidateEvidence(row.evidence);
    if (!evidence) continue;
    // Refresh textual source changes before taking a snapshot; a moved L1 leaves the old Episode.
    const candidate = upsertL2Candidate(repos, {
      sourceMemoryId: row.sourceMemoryId,
      userId: input.userId,
      route: evidence.routes[0]!
    });
    if (candidate?.status === "pending" && candidate.episodeId === input.episodeId) candidates.push(candidate);
  }
  return candidates;
}

/** Call inside the same transaction that saves the batch's L2 changes. Throws before accepting stale sources. */
export function markL2CandidatesProcessed(
  repos: Repositories,
  candidates: readonly L2Candidate[],
  operations: unknown,
  at: string
): void {
  repos.transaction(() => {
    const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
    for (const candidate of unique) {
      const current = repos.runtime.getUnifiedL2Candidate(candidate.id, candidate.userId);
      const evidence = candidateEvidence(current?.evidence);
      const source = readSource(repos, candidate.sourceMemoryId, candidate.userId);
      if (!current || current.status !== "pending" || !evidence || !source ||
          current.sourceMemoryId !== candidate.sourceMemoryId ||
          evidence.sourceVersion !== candidate.sourceVersion ||
          source.episodeId !== candidate.episodeId ||
          sourceVersionFor(source.memory, source.episodeId, evidence.signals) !== candidate.sourceVersion) {
        throw new Error(`L2 candidate changed during extraction: ${candidate.id}`);
      }
    }
    for (const candidate of unique) {
      if (!repos.runtime.markUnifiedL2CandidateProcessed({
        id: candidate.id,
        userId: candidate.userId,
        sourceVersion: candidate.sourceVersion,
        operations,
        at
      })) throw new Error(`L2 candidate changed during extraction: ${candidate.id}`);
    }
  });
}

function readSource(repos: Repositories, id: string, userId: string): {
  memory: MemoryRow;
  episodeId: string | null;
} | null {
  const memory = repos.memories.get(id);
  if (!memory || memory.userId !== userId || memory.memoryLayer !== "L1" ||
      memory.deletedAt || memory.status === "deleted" || memory.status === "archived") return null;
  if (memory.properties.internal_info.evidence_status === "provisional" ||
      memory.properties.internal_info.evidence_status === "disputed") return null;
  const trace = traceMetaFromMemory(memory);
  if (!trace) return null;
  const raw = trace.rawTurnId ? repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
  if (raw && (raw.deletedAt || raw.redactedAt || raw.userId !== userId)) return null;
  return { memory, episodeId: trace.episodeId ?? raw?.episodeId ?? null };
}

function sourceVersionFor(memory: MemoryRow, episodeId: string | null, signals: L2CandidateSignal[]): string {
  const trace = traceMetaFromMemory(memory)!;
  return hash({
    sourceMemoryId: memory.id,
    episodeId,
    memoryValue: memory.memoryValue,
    summary: trace.summary,
    userText: trace.userText,
    agentText: trace.agentText,
    toolCalls: trace.toolCalls,
    reflection: trace.reflection,
    signals
  });
}

function candidateEvidence(value: unknown): L2CandidateEvidence | null {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.sourceVersion !== "string" ||
      (value.episodeId !== null && typeof value.episodeId !== "string") ||
      !Array.isArray(value.routes) || value.routes.length === 0 ||
      !value.routes.every((route) => ROUTES.has(route as L2CandidateRoute)) ||
      !Array.isArray(value.signals) || !value.signals.every((signal) =>
        isRecord(signal) && typeof signal.eventId === "string" && typeof signal.text === "string" &&
        ROUTES.has(signal.route as L2CandidateRoute))) return null;
  return value as unknown as L2CandidateEvidence;
}

function toCandidate(row: CandidatePoolRecord, memory: MemoryRow): L2Candidate | null {
  const evidence = candidateEvidence(row.evidence);
  if (!evidence) return null;
  return {
    id: row.id,
    userId: row.userId,
    sourceMemoryId: row.sourceMemoryId,
    sourceVersion: evidence.sourceVersion,
    episodeId: evidence.episodeId,
    routes: evidence.routes,
    signals: evidence.signals,
    memory,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function signalKey(signal: L2CandidateSignal): string {
  return `${signal.route}:${signal.eventId}`;
}

function normalizeSignal(signal: L2CandidateSignal): L2CandidateSignal {
  return {
    eventId: signal.eventId,
    route: signal.route,
    text: signal.text,
    ...(signal.feedbackId !== undefined ? { feedbackId: signal.feedbackId } : {}),
    ...(signal.repairId !== undefined ? { repairId: signal.repairId } : {}),
    ...(signal.polarity !== undefined ? { polarity: signal.polarity } : {}),
    ...(signal.sourceBasis !== undefined ? { sourceBasis: signal.sourceBasis } : {}),
    ...(signal.confidenceCap !== undefined ? { confidenceCap: signal.confidenceCap } : {}),
    ...(signal.evidenceStrength !== undefined ? { evidenceStrength: signal.evidenceStrength } : {}),
    ...(signal.repairValidated !== undefined ? { repairValidated: signal.repairValidated } : {}),
    ...(signal.fallback !== undefined ? { fallback: signal.fallback } : {})
  };
}

function hash(value: unknown): string {
  // Do not use bounded diagnostic serialization: edits beyond a long transcript's prefix matter too.
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
