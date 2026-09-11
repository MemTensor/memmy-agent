import type { ApiLogDTO } from "../../../agent-contract/dto.js";
import { t } from "../stores/i18n.js";

const ADD_STATUS_SUMMARIES = new Set([
  "摘要排队中",
  "摘要整理中",
  "建立索引中",
  "索引已建立",
]);

export interface SearchInput {
  query?: string;
  agent?: string;
  sessionId?: string;
  episodeId?: string | null;
  type?: string;
}

export interface SearchOutput {
  candidates?: SearchCandidate[];
  hubCandidates?: SearchCandidate[];
  filtered?: SearchCandidate[];
  droppedByLlm?: SearchCandidate[];
  stats?: {
    ranked?: number;
    finalReturned?: number;
    llmFilter?: { kept?: number };
  };
  error?: string;
}

export interface SearchCandidate {
  tier?: string | number;
  memoryLayer?: string;
  refKind?: string;
  refId?: string;
  score?: number;
  snippet?: string;
  role?: string;
  summary?: string;
  content?: string;
  origin?: string;
  owner?: string;
}

export interface AddInput {
  sessionId?: string;
  episodeId?: string;
  turnCount?: number;
  layer?: string;
  source?: string;
  sourceAgent?: string;
  query?: string;
}

export interface AddOutput {
  stats?: string;
  stored?: number;
  warnings?: Array<{ stage?: string; message?: string }>;
  details?: AddDetail[];
}

export interface AddDetail {
  role?: string;
  action?: string;
  summary?: string | null;
  spanGoal?: string | null;
  span_goal?: string | null;
  content?: string;
  traceId?: string;
  episodeId?: string;
  sourceAgent?: string;
  query?: string;
  agent?: string;
  reason?: string;
}

interface LogSummary {
  text: string;
  tail?: string;
}

export function buildMemoryLogSummary(
  log: ApiLogDTO,
  input: unknown,
  output: unknown,
): LogSummary | undefined {
  if (log.toolName === "memory_search") {
    const searchInput = (input ?? {}) as SearchInput;
    const searchOutput = (output ?? {}) as SearchOutput;
    const query = searchInput.query?.trim();
    const counts = memorySearchSummaryCounts(searchOutput);
    const result = t("logs.search.summary", {
      beforeLlm: counts.beforeLlm,
      afterLlm: counts.afterLlm,
    });
    return query ? { text: query, tail: `· ${result}` } : { text: result };
  }
  if (log.toolName !== "memory_add") return undefined;

  const addInput = (input ?? {}) as AddInput;
  const addOutput = (output ?? {}) as AddOutput;
  const detail = addOutput.details?.[0];
  const summary = usableAddSummary(detail?.summary);
  if (detail?.role === "trace" || detail?.role === "span") {
    const displayText = detail.role === "span"
      ? usableAddSummary(detail.spanGoal ?? detail.span_goal)
      : usableTraceSummary(summary);
    return {
      text: firstLogText(
        detail.role === "trace" && displayText
          ? truncateTraceLogSummary(displayText)
          : displayText,
        detail.query,
        addInput.query,
      ) ?? "memory item",
    };
  }
  return {
    text: firstLogText(
      summary,
      detail?.query,
      addInput.query,
      detail?.content,
      detail?.traceId,
    ) ?? "memory item",
  };
}

export function memorySearchCandidates(output: SearchOutput): SearchCandidate[] {
  const candidates = new Map<string, SearchCandidate>();
  for (const candidate of [
    ...(output.candidates ?? []),
    ...(output.hubCandidates ?? []),
    ...(output.filtered ?? []),
    ...(output.droppedByLlm ?? []),
  ]) {
    const key = memorySearchCandidateKey(candidate);
    if (!candidates.has(key)) candidates.set(key, candidate);
  }
  return [...candidates.values()];
}

export function memorySearchCandidateKey(candidate: SearchCandidate): string {
  if (candidate.refId) return `${candidate.refKind ?? "memory"}:${candidate.refId}`;
  return [
    candidate.refKind ?? "",
    candidate.tier ?? "",
    candidate.memoryLayer ?? "",
    candidate.content ?? candidate.snippet ?? candidate.summary ?? "",
  ].join("|");
}

export function memorySearchCandidateLayerLabel(candidate: SearchCandidate): string {
  switch (candidate.tier ?? candidate.memoryLayer ?? candidate.refKind) {
    case "L1":
    case "trace":
    case "episode":
      return "L1";
    case "L2":
    case "policy":
    case "experience":
      return "L2";
    case "L3":
    case "world_model":
    case "world-model":
      return "L3";
    case "Skill":
    case "skill":
      return "Skill";
    case "UserMemory":
    case "user_memory":
      return "User";
    default:
      return "Memory";
  }
}

export function memoryAddSourceAgent(output: AddOutput): string | undefined {
  return firstLogText(...(output.details ?? []).map((detail) => detail.sourceAgent));
}

export function firstLogText(...values: Array<string | null | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function usableTraceSummary(value: string | undefined): string | undefined {
  return value && !/^RawTurn:\s*/i.test(value) ? value : undefined;
}

function truncateTraceLogSummary(value: string): string {
  const characters = Array.from(value);
  const chineseCharacterCount = characters.filter((character) =>
    /[\u3400-\u9fff]/u.test(character)
  ).length;
  if (chineseCharacterCount > 0) {
    if (chineseCharacterCount <= 20) return value;
    let count = 0;
    const end = characters.findIndex((character) => {
      if (/[\u3400-\u9fff]/u.test(character)) count += 1;
      return count === 20;
    });
    return `${characters.slice(0, end + 1).join("")}...`;
  }
  const words = value.match(/\S+/g) ?? [];
  return words.length > 20 ? `${words.slice(0, 20).join(" ")}...` : value;
}

function usableAddSummary(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && !ADD_STATUS_SUMMARIES.has(text) ? text : undefined;
}

function memorySearchSummaryCounts(output: SearchOutput): {
  beforeLlm: number;
  afterLlm: number;
} {
  const afterLlm = firstNonNegativeInt(
    output.stats?.llmFilter?.kept,
    output.stats?.finalReturned,
  ) ?? output.filtered?.length ?? 0;
  return {
    beforeLlm: Math.max(
      firstNonNegativeInt(output.stats?.ranked) ?? 0,
      memorySearchCandidates(output).length,
      afterLlm,
    ),
    afterLlm,
  };
}

function firstNonNegativeInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}
