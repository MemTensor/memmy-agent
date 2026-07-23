import type {
  RetrievalQueryExtract,
  RetrievalResult
} from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import {
  compileRetrievalQuery,
  displayReflectionText,
  focusResearchRetrievalQuery,
  isRepositoryRepairPrompt,
  isResearchDomain,
  isStandaloneMathFinalAnswerTask,
  policyMetaFromMemory,
  renderMathFinalAnswerProtocol,
  renderRepositoryRepairProtocol,
  RETRIEVAL_FILTER_PROMPT,
  RETRIEVAL_QUERY_EXTRACT_PROMPT,
  retrievalForIntent,
  retrievalLayersForMode,
  retrievalLayersForProfile,
  retrievePluginMemories,
  skillMetaFromMemory,
  STANDALONE_MATH_FINAL_ANSWER_TASK_KIND,
  traceMetaFromMemory,
  worldModelMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import {
  MEMORY_SUMMARY_MAX_TOKENS,
  type MemmyConfig
} from "../../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import type { Embedder, LlmClient } from "../../model/types.js";
import {
  kindFromMemory,
  Repositories,
  type EpisodeRecord
} from "../../storage/repositories.js";
import type {
  InjectedContext,
  MemoryKind,
  MemoryLayer,
  MemoryRow,
  MemorySearchRequest,
  RecallHit,
  RequestEnvelope,
  RetrievalMode,
  RuntimeNamespace
} from "../../types.js";
import { newId, stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { recordApiLog } from "../model-audit/model-call-audit.js";
import {
  sourceMemoryIdsFromMemory
} from "../read-model/memory.js";
import { mergeRetrievalResults, normalizeQueryRewriteQueries } from "../retrieval/query-rewrite.js";
import {
  normalizeRetrievalExtractKeywords
} from "../turn/turn-normalization.js";
import { IndexedCandidatePool } from "./indexed-candidate-pool.js";

type InternalMemorySearchRequest = MemorySearchRequest & {
  episodeId?: string;
  turnId?: string;
  tags?: string[];
  limit?: number;
  contextBudget?: number;
  includeInjectedContext?: boolean;
  retrievalMode?: RetrievalMode;
  targetSkillId?: string;
  contextHints?: Record<string, unknown>;
  injectedContextQuery?: string;
};

type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;
type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

const RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS = 60_000;

const RETRIEVAL_FILTER_TIMEOUT_MS = 30_000;

const QUERY_REWRITE_TIMEOUT_MS = 30_000;

const QUERY_REWRITE_MAX_RETRIES = 1;

const QUERY_VECTOR_TIMEOUT_MS = 3_000;

const QUERY_REWRITE_COUNT = 3;

const QUERY_REWRITE_RRF_CONSTANT = 8;

const QUERY_REWRITE_PER_QUERY_MIN_KEEP = 3;

const pipelineLogger = createMemoryLogger("pipeline");

const QUERY_REWRITE_SYSTEM_PROMPT = `You rewrite a user's memory search request into exactly 3 complementary retrieval queries.

Goal:
- Maximize recall from a personal memory store while staying faithful to the user's request.
- Preserve concrete entities, people, dates, places, relationship words, numbers, and domain keywords.
- Keep useful aliases or likely paraphrases when they help retrieval.
- Retrieve distinct evidence needed for multi-fact, temporal, comparison, counting, and inference questions.

Rules:
1. Produce 3 short standalone retrieval queries.
2. Do not answer the question.
3. Do not add facts that are not grounded in the original request.
4. Keep the original language when it carries names or exact wording; use bilingual paraphrases only when the request itself mixes languages.
5. Query 1 must preserve the original request and its concrete anchors.
6. Query 2 must target the main entity, event, relationship, or time expression with useful aliases.
7. Query 3 must target one complementary evidence facet needed to resolve the request. For indirect questions, retrieve stated preferences, plans, goals, prior events, or constraints instead of guessing the conclusion. For references such as "that book" or "it", target the earlier source fact alone and intentionally omit downstream entities that may not occur in the source memory.
8. Keep each query to one evidence facet and roughly 2-12 content words. Do not join stages with "and", "follow-up", parentheses, or lists of synonyms.
9. Do not produce three near-duplicate paraphrases.

Return JSON only:
{
  "queries": ["query 1", "query 2", "query 3"]
}`;

type ReadableMemoryIdKind = "trace" | "policy" | "world" | "skill" | "episode" | "raw" | "unknown";

export function memoryLayersForIntent(kind: Parameters<typeof retrievalForIntent>[0]): MemoryLayer[] {
  const plan = retrievalForIntent(kind);
  const layers: MemoryLayer[] = [];
  if (plan.tier1) layers.push("Skill");
  if (plan.tier2) layers.push("L2", "L1");
  if (plan.tier3) layers.push("L3");
  return layers;
}

export function readableMemoryIdKind(id: string): ReadableMemoryIdKind {
  if (id.startsWith("trace_")) return "trace";
  if (id.startsWith("policy_")) return "policy";
  if (id.startsWith("world_")) return "world";
  if (id.startsWith("skill_")) return "skill";
  if (id.startsWith("episode_")) return "episode";
  if (id.startsWith("raw_")) return "raw";
  return "unknown";
}

function describeRetrievalFilterCandidate(hit: RecallHit, bodyChars: number): string {
  const body = clip(hit.snippet, bodyChars);
  const title = clip(hit.title ?? hit.id, 120);
  switch (hit.memoryLayer) {
    case "Skill":
      return `[SKILL] ${title}${body ? `\n   ${body}` : ""}`;
    case "L1":
      return `[TRACE] ${body || title}`;
    case "L2":
      return `[EXPERIENCE] ${title}${body ? `\n   ${body}` : ""}`;
    case "L3":
      return `[WORLD-MODEL] ${title}${body ? `\n   ${body}` : ""}`;
  }
}

function uniqMemories(memories: readonly MemoryRow[]): MemoryRow[] {
  const out: MemoryRow[] = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push(memory);
  }
  return out;
}

function searchCandidateFromHit(hit: RecallHit, memory?: MemoryRow): Record<string, unknown> {
  const formatted = renderInjectedSnippet(hit, memory, {
    skillInjectionMode: "summary",
    skillSummaryChars: MEMORY_PACKET_SKILL_SUMMARY_CHARS
  });
  return {
    refKind: hit.kind,
    refId: hit.id,
    score: hit.score,
    content: formatted?.body ?? "",
    snippet: hit.snippet,
    summary: hit.title,
    origin: hit.source,
    tier: hit.memoryLayer
  };
}

export function memoryMatchesTags(memory: MemoryRow, tags: string[] | undefined): boolean {
  const requested = (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return true;
  const memoryTags = new Set(memory.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  return requested.every((tag) => memoryTags.has(tag));
}

function emptyRetrievalResult(): RetrievalResult {
  return {
    hits: [],
    debug: {
      tierSizes: { tier1: 0, tier2: 0, tier3: 0 },
      kept: { tier1: 0, tier2: 0, tier3: 0 },
      topRelevance: 0,
      droppedByThreshold: 0
    }
  };
}

export function retrievedMemorySourceIds(memory: MemoryRow): string[] {
  const policy = policyMetaFromMemory(memory);
  const skill = skillMetaFromMemory(memory);
  const worldModel = worldModelMetaFromMemory(memory);
  return [
    memory.id,
    ...sourceMemoryIdsFromMemory(memory),
    ...(policy?.sourceTraceIds ?? []),
    ...(skill?.sourcePolicyIds ?? []),
    ...(skill?.evidenceAnchorIds ?? []),
    ...(worldModel?.policyIds ?? [])
  ];
}

function llmFilterFallbackCap(hits: RecallHit[], maxKeep: number): RecallHit[] {
  const capped = Math.max(0, maxKeep);
  return capped === 0 ? [] : hits.slice(0, capped);
}


function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function uniq<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

type InjectedSnippetRefKind = "skill" | "episode" | "trace" | "experience" | "world-model";

interface RenderedInjectedSection {
  refKind: InjectedSnippetRefKind;
  hitId: string;
  section: InjectedContext["sections"][number];
}

const MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS = 640;

const MEMORY_PACKET_SKILL_SUMMARY_CHARS = 200;

interface InjectedRenderOptions {
  contextHints?: Record<string, unknown>;
  query?: string;
  skillInjectionMode?: "summary" | "full";
  skillSummaryChars?: number;
  domain?: "" | "research";
}

export function buildInjectedContext(
  hits: RecallHit[],
  budget: number,
  contextMemories: MemoryRow[] = [],
  retrievalMode: RetrievalMode = "search",
  contextHints?: Record<string, unknown>,
  query?: string,
  tuning?: {
    skillInjectionMode?: "summary" | "full";
    skillSummaryChars?: number;
    domain?: "" | "research";
  }
): {
  injectedContext: InjectedContext;
  sourceMemoryIds: string[];
  droppedDueToBudget: Array<{
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    reason: "token_budget";
    tokenEstimate?: number;
  }>;
} {
  const options: InjectedRenderOptions = {
    contextHints,
    query,
    skillInjectionMode: tuning?.skillInjectionMode ?? "summary",
    skillSummaryChars: tuning?.skillSummaryChars ?? MEMORY_PACKET_SKILL_SUMMARY_CHARS,
    domain: tuning?.domain
  };
  const memoryById = new Map(contextMemories.map((memory) => [memory.id, memory]));
  const rendered = hits.flatMap((hit) => {
    const section = renderInjectedSection(hit, memoryById.get(hit.id), options);
    return section ? [section] : [];
  });
  const memories = isStandaloneMathInjected(options)
    ? suppressLowSpecificityStandaloneMathSections(
        suppressIsolatedMathSkillSections(rendered),
        options.query
      )
    : rendered;

  void budget;
  const sections: InjectedContext["sections"] = memories.map((section) => section.section);
  const renderedSections: RenderedInjectedSection[] = [...memories];
  const sourceMemoryIds: string[] = memories.map((section) => section.hitId);
  const droppedDueToBudget: Array<{
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    reason: "token_budget";
    tokenEstimate?: number;
  }> = [];
  let used = sections.reduce((sum, section) => sum + (section.tokenEstimate ?? 0), 0);
  const guidance = decisionGuidanceSection(
    contextMemoriesForInjectedSources(contextMemories, sourceMemoryIds)
  );
  if (guidance) {
    const estimate = guidance.tokenEstimate ?? 0;
    sections.push(guidance);
    sourceMemoryIds.push(...guidance.memoryIds);
    used += estimate;
  }

  const markdown = renderInjectedMarkdown(renderedSections, guidance, retrievalMode, options);

  return {
    injectedContext: {
      markdown,
      sections,
      tokenEstimate: used
    },
    sourceMemoryIds: uniq(sourceMemoryIds),
    droppedDueToBudget
  };
}

function renderInjectedSection(
  hit: RecallHit,
  memory: MemoryRow | undefined,
  options: InjectedRenderOptions
): RenderedInjectedSection | null {
  const rendered = renderInjectedSnippet(hit, memory, options);
  if (!rendered) return null;
  const content = rendered.body;
  return {
    refKind: rendered.refKind,
    hitId: hit.id,
    section: {
      id: `memory-${hit.id}`,
      title: rendered.title,
      kind: hit.kind,
      memoryLayer: hit.memoryLayer,
      memoryIds: [hit.id],
      content,
      tokenEstimate: estimateTokens(`${rendered.title}\n${content}`)
    }
  };
}

function renderInjectedSnippet(
  hit: RecallHit,
  memory: MemoryRow | undefined,
  options: InjectedRenderOptions
): { refKind: InjectedSnippetRefKind; title: string; body: string } | null {
  if (hit.kind === "skill" || hit.memoryLayer === "Skill") {
    const skill = memory ? skillMetaFromMemory(memory) : null;
    const name = skill?.name || hit.title || "Skill";
    const guide = skill?.invocationGuide || hit.snippet;
    const summaryChars = options.skillSummaryChars ?? MEMORY_PACKET_SKILL_SUMMARY_CHARS;
    if (options.skillInjectionMode === "full") {
      return {
        refKind: "skill",
        title: "Skill",
        body: truncateInjectedSnippet([
          `id: ${hit.id}`,
          "",
          ...labeledInjectedBlock("Name", name),
          "",
          ...labeledInjectedBlock("Guide", guide.trim() || "(not provided)")
        ].join("\n"))
      };
    }
    const lines = [
      `id: ${hit.id}`,
      "",
      ...labeledInjectedBlock("Name", name),
      "",
      ...labeledInjectedBlock("Description", firstLineSummary(guide, summaryChars) || "(not provided)")
    ];
    return {
      refKind: "skill",
      title: "Skill",
      body: lines.join("\n")
    };
  }

  if (hit.source === "episode") {
    return {
      refKind: "episode",
      title: "Episode",
      body: truncateInjectedSnippet(renderInjectedEpisodeBody(hit))
    };
  }

  if (hit.kind === "trace" || hit.memoryLayer === "L1") {
    const trace = memory ? traceMetaFromMemory(memory) : null;
    if (!trace) return null;
    return {
      refKind: "trace",
      title: "Trace",
      body: truncateInjectedSnippet(renderInjectedTraceBody(hit, trace))
    };
  }

  if (hit.kind === "world_model" || hit.memoryLayer === "L3") {
    const world = memory ? worldModelMetaFromMemory(memory) : null;
    const title = world?.title || hit.title || "World model";
    const body = world?.body || hit.snippet;
    return {
      refKind: "world-model",
      title: "Environment Knowledge",
      body: truncateInjectedSnippet([
        `id: ${hit.id}`,
        "",
        ...labeledInjectedBlock("Title", title),
        "",
        ...labeledInjectedBlock("Content", body)
      ].join("\n"))
    };
  }

  const policy = memory ? policyMetaFromMemory(memory) : null;
  const parts = policy ? [
    `id: ${hit.id}`,
    "",
    ...labeledInjectedBlock("Use", renderInjectedExperienceUseHint(policy)),
    "",
    ...labeledInjectedBlock("Trigger", policy.trigger || "(not provided)"),
    "",
    ...labeledInjectedBlock("Guidance", policy.procedure || hit.snippet),
    ...(policy.decisionGuidance.antiPattern.length > 0
      ? ["", ...labeledInjectedBlock("Avoid", policy.decisionGuidance.antiPattern.join("; "))]
      : []),
    ...(policy.boundary ? ["", ...labeledInjectedBlock("Scope", policy.boundary)] : []),
    ...(policy.verification ? ["", ...labeledInjectedBlock("Check", policy.verification)] : [])
  ] : [
    `id: ${hit.id}`,
    "",
    ...labeledInjectedBlock("Guidance", hit.snippet)
  ];
  return {
    refKind: "experience",
    title: "Experience",
    body: truncateInjectedSnippet(parts.join("\n") || hit.snippet)
  };
}

function renderInjectedExperienceUseHint(policy: NonNullable<ReturnType<typeof policyMetaFromMemory>>): string {
  if (policy.experienceType === "failure_avoidance" || policy.evidencePolarity === "negative") {
    return "Use as a guardrail before planning.";
  }
  if (policy.experienceType === "repair_instruction") {
    return "Use as repair guidance before choosing the next action.";
  }
  if (policy.experienceType === "verifier_feedback") {
    return "Use as a verification checklist before finalizing.";
  }
  if (policy.experienceType === "preference") {
    return "Use as a user preference when applicable.";
  }
  return "Use as prior successful guidance when the current task matches.";
}

function renderInjectedTraceBody(hit: RecallHit, trace: TraceMeta): string {
  return [
    `id: ${hit.id}`,
    `timestamp: ${formatInjectedTimestamp(trace.ts, hit.updatedAt)}`,
    "",
    ...labeledInjectedBlock("Historical user statement", trace.userText || "(empty)"),
    "",
    ...labeledInjectedBlock("Historical assistant response", trace.agentText || "(empty)")
  ].join("\n");
}

function renderInjectedEpisodeBody(hit: RecallHit): string {
  return [
    `id: ${hit.id}`,
    `timestamp: ${formatInjectedTimestamp(undefined, hit.updatedAt)}`,
    "",
    stripInternalReflectionLines(stripEpisodePromptMetrics(hit.snippet))
  ].filter(Boolean).join("\n");
}

function labeledInjectedBlock(label: string, value: string): string[] {
  const body = value.trim();
  return [`${label}:`, body || "(empty)"];
}

function renderInjectedMarkdown(
  sections: RenderedInjectedSection[],
  guidance: InjectedContext["sections"][number] | undefined,
  retrievalMode: RetrievalMode,
  options: InjectedRenderOptions
): string {
  const standaloneMathFinalAnswer = isStandaloneMathInjected(options);
  const taskProtocol = injectedTaskProtocol(options.query);
  if (sections.length === 0 && !guidance && !standaloneMathFinalAnswer && !taskProtocol) return "";
  const parts: string[] = [];
  const header = injectedHeaderForMode(retrievalMode, standaloneMathFinalAnswer, Boolean(taskProtocol));
  if (header) parts.push(header);
  if (taskProtocol) {
    parts.push(taskProtocol);
  } else if (standaloneMathFinalAnswer) {
    parts.push(renderMathFinalAnswerProtocol(options.query));
  }
  const skills = sections.filter((section) => section.refKind === "skill");
  const episodes = sections.filter((section) => section.refKind === "episode");
  const traces = sections.filter((section) => section.refKind === "trace");
  const experiences = sections.filter((section) => section.refKind === "experience");
  const worlds = sections.filter((section) => section.refKind === "world-model");

  parts.push(...renderInjectedMemoriesSection(traces, episodes));

  if (experiences.length > 0) {
    parts.push("## L2 Experience Memories\n");
    experiences.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (worlds.length > 0) {
    parts.push("## L3 Environment Knowledge\n");
    worlds.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (skills.length > 0) {
    if (standaloneMathFinalAnswer) {
      parts.push("## Candidate method memories\n");
    } else {
      parts.push("## Skill Memories\n");
    }
    skills.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (guidance) parts.push(standaloneMathFinalAnswer ? mathDecisionGuidance(guidance) : guidance.content);
  const footer = injectedFooterFor(sections, options.skillInjectionMode ?? "summary", standaloneMathFinalAnswer);
  if (footer) parts.push(footer);
  return prependResearchPlaybook(parts.join("\n\n"), options.domain);
}

const RESEARCH_RETRIEVAL_PLAYBOOK = `## Research retrieval playbook

Use this mode for research questions with multiple clues, indirect references, hidden candidates, or partial-match risk. Search or inspect sources to surface candidate answers, verify them against each constraint, and return the requested answer slot.

### 1. Hypothesize first, then verify by name
- Before your first search call, write a short numbered list of plausible candidate entities when you can name any.
- Probe candidates by name plus one distinguishing term.
- Treat source snippets as stronger evidence than prior guesses.

### 2. Decompose constraints
- Split the question into concrete nouns, dates, places, awards, numbers, roles, or titles.
- Keep searches short and search major clues separately.
- Intersect results across clues instead of relying on a single long query.

### 3. Pivot deliberately
- If two queries are irrelevant, switch to a different clue or candidate-name probe.
- Lead with rare terms and exact names when available.

### 4. Verify before answering
- Cross-check the final candidate against every important constraint.
- If full verification is impossible, commit to the best-supported specific answer and make the evidence limits clear.`;

function prependResearchPlaybook(markdown: string, domain?: string): string {
  if (!isResearchDomain(domain)) return markdown;
  const body = markdown.trim();
  return body ? `${RESEARCH_RETRIEVAL_PLAYBOOK}\n\n${body}` : RESEARCH_RETRIEVAL_PLAYBOOK;
}

function renderInjectedMemoriesSection(
  traces: RenderedInjectedSection[],
  episodes: RenderedInjectedSection[]
): string[] {
  if (episodes.length === 0 && traces.length === 0) return [];
  const parts: string[] = [];
  if (traces.length > 0) {
    parts.push("## L1 Trace Memories");
    traces.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }
  if (episodes.length > 0) {
    parts.push("## Similar Past Episodes");
    episodes.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }
  return parts;
}

function renderNumberedInjectedSection(section: RenderedInjectedSection, index: number): string {
  const title = section.section.title || section.hitId;
  const body = stripRedundantInjectedTitle(title, section.section.content, section.refKind);
  return indentInjectedBlock([`${index}. ${title}`, body].filter(Boolean).join("\n"));
}

function injectedHeaderForMode(mode: RetrievalMode, standaloneMathFinalAnswer = false, taskProtocol = false): string {
  if (taskProtocol) {
    return "# Current task protocol and recalled memories\n\n" +
      "IMPORTANT: The task protocol below is derived from the current user prompt, not from previous conversations.\n" +
      "Treat it as current execution guidance. Any recalled memories that follow are advisory; verify them against the current prompt and repository before using them.";
  }
  if (standaloneMathFinalAnswer) {
    if (mode === "turn_start") {
      return "# Retrieved prior problem-solving memories\n\n" +
        "These are candidate methods and guidance learned from previous tasks, not facts about the current problem.\n" +
        "Use them only when their assumptions match the original problem statement; ignore mismatched memories.";
    }
    return "# Memory search results\n\n" +
      "The memory tool returned candidate methods and prior examples. Verify fit before using them.";
  }
  if (mode === "turn_start") return "";
  if (mode === "skill_invoke") {
    return "# Invoked skill\n\n" +
      "Follow the procedure below; the verification step tells you when you're done.";
  }
  if (mode === "sub_agent") {
    return "# Parent-agent context\n\n" +
      "Relevant memory surfaced for this sub-agent's mission.";
  }
  if (mode === "decision_repair") {
    return "# Decision repair — please read before your next action\n\n" +
      "You have failed this tool multiple times in a row. Below are preferred / avoided actions\n" +
      "distilled from similar past situations. Please adapt your plan accordingly.";
  }
  return "";
}

function isStandaloneMathInjected(options: InjectedRenderOptions): boolean {
  return options.contextHints?.taskKind === STANDALONE_MATH_FINAL_ANSWER_TASK_KIND ||
    isStandaloneMathFinalAnswerTask(options.query);
}

function injectedTaskProtocol(query: string | undefined): string | null {
  if (!isRepositoryRepairPrompt(query)) return null;
  return renderRepositoryRepairProtocol(query);
}

function suppressIsolatedMathSkillSections(sections: RenderedInjectedSection[]): RenderedInjectedSection[] {
  const skills = sections.filter((section) => section.refKind === "skill");
  if (skills.length !== 1) return sections;
  const onlySkill = skills[0];
  if (onlySkill && shouldKeepIsolatedMathSkillSection(onlySkill)) return sections;
  const hasGrounding = sections.some((section) =>
    section.refKind === "trace" || section.refKind === "episode" || section.refKind === "experience"
  );
  if (hasGrounding) return sections;
  return sections.filter((section) => section.refKind !== "skill");
}

function shouldKeepIsolatedMathSkillSection(section: RenderedInjectedSection): boolean {
  const text = `${section.section.title}\n${firstLineSummary(section.section.content, 700)}`.toLowerCase();
  const isGeometryScaffold =
    /\b(geometry|triangle|circle|angle|circumcenter|incenter|barycentric)\b/.test(text) &&
    /\b(set\s*up|setup|coordinate|coordinates|place|placing|align|axis|origin|model)\b/.test(text);
  if (!isGeometryScaffold) return false;
  return !/\b(count|compute|sum|probability|expected|recurrence|polynomial|permutation|sequence)\b/.test(text);
}

function suppressLowSpecificityStandaloneMathSections(
  sections: RenderedInjectedSection[],
  taskText: string | undefined
): RenderedInjectedSection[] {
  const taskTerms = extractSpecificMathTerms(taskText ?? "");
  return sections.filter((section) => {
    if (section.refKind === "trace" || section.refKind === "episode" || section.refKind === "experience") {
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 2);
    }
    if (section.refKind === "world-model") {
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 3);
    }
    if (section.refKind === "skill") {
      if (shouldKeepIsolatedMathSkillSection(section)) return true;
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 2);
    }
    return true;
  });
}

function hasEnoughStandaloneMathOverlap(
  candidateText: string,
  taskTerms: ReadonlySet<string>,
  minOverlap: number
): boolean {
  if (taskTerms.size === 0) {
    return !isGenericStandaloneMathMemory(candidateText);
  }
  const candidateTerms = extractSpecificMathTerms(candidateText);
  let overlap = 0;
  for (const term of candidateTerms) {
    if (!taskTerms.has(term)) continue;
    overlap += 1;
    if (overlap >= minOverlap) return true;
  }
  return false;
}

function sectionTextForSpecificity(section: RenderedInjectedSection): string {
  return `${section.section.title}\n${section.section.content}\n${section.section.memoryLayer}\n${section.section.kind}`;
}

function isGenericStandaloneMathMemory(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    /\b(?:math(?:ematical)?|olympiad|contest|competition)(?:[-\s]+(?:style|level|type))?[-\s]+(?:problem|task)s?\b/,
    /\bsolution\s+to\s+(?:a\s+|the\s+)?(?:math(?:ematical)?|olympiad|contest|competition)(?:[-\s]+(?:problem|task))?\b/,
    /\banaly[sz]e the problem step-by-step\b/,
    /\bprovide the final answer\b/,
    /\bensuring logical consistency\b/,
    /\bmathematical problem-solving environment\b/,
    /\bcompetition tasks\b/
  ].some((pattern) => pattern.test(normalized));
}

function extractSpecificMathTerms(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return new Set(words.filter((word) =>
    !MATH_SPECIFICITY_STOPWORDS.has(word) &&
    !/^\d+$/.test(word)
  ));
}

const MATH_SPECIFICITY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "problem",
  "solution",
  "answer",
  "math",
  "mathematical",
  "prove",
  "compute",
  "find",
  "show",
  "given",
  "using",
  "步骤",
  "答案",
  "问题",
  "数学",
  "求解",
  "证明"
]);

function mathDecisionGuidance(guidance: InjectedContext["sections"][number]): string {
  return guidance.content
    .replace("## Decision guidance (distilled from past similar situations)", "## Method guidance (distilled from past similar math tasks)")
    .replace(
      "Apply these BEFORE choosing your next action. Each line was learned\nfrom one or more past episodes where the user told us what to prefer\nor avoid in this kind of context.",
      "Treat these as advisory heuristics, not facts about the current problem.\nApply a line only after it matches the original problem constraints."
    );
}

function injectedFooterFor(
  sections: RenderedInjectedSection[],
  skillMode: "summary" | "full",
  standaloneMathFinalAnswer = false
): string {
  if (standaloneMathFinalAnswer) {
    return [
      "MemOS memory tools remain available when a concrete prior method is needed.",
      "Do not call them merely to browse when the original problem can be solved directly."
    ].join("\n");
  }
  if (sections.length > 0 && sections.every((section) => section.refKind === "trace")) {
    return "";
  }
  void skillMode;
  return [
    "## Follow-up memory tools",
    "",
    "If details are needed, use `memmy_memory_get(id)` with one of the ids above.",
    "Use `memmy_memory_search(query)` only when the recalled memory is insufficient or ambiguous."
  ].join("\n");
}

function firstLineSummary(guide: string, maxChars: number): string {
  const trimmed = guide.trim();
  if (!trimmed) return "";
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  const cleaned = paragraph
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}

function truncateInjectedSnippet(value: string): string {
  if (value.length <= MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS) return value;
  const head = value.slice(0, MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS - 16);
  return `${head}\n...[truncated]`;
}

function stripEpisodePromptMetrics(summary: string): string {
  return summary
    .replace(
      /^episode\s+\d+\s+steps\s*·\s*best\s+V=[+-]?\d+(?:\.\d+)?\s*·\s*goal-sim=[+-]?\d+(?:\.\d+)?\s*\n?/i,
      ""
    )
    .replace(/^Past similar episode\s*\n?/i, "")
    .replace(/\bstep\s+(\d+)\s+\(V=[+-]?\d+(?:\.\d+)?\)/gi, "step $1")
    .trim();
}

function stripInternalReflectionLines(value: string): string {
  return value
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\s*reflection:\s*(.+?)\s*$/i);
      return !match || Boolean(displayReflectionText(match[1]));
    })
    .join("\n")
    .trim();
}

function formatInjectedTimestamp(traceTs?: number, updatedAt?: string): string {
  if (Number.isFinite(traceTs)) return new Date(traceTs!).toISOString();
  const parsed = updatedAt ? Date.parse(updatedAt) : NaN;
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function stripRedundantInjectedTitle(
  title: string,
  body: string,
  refKind: InjectedSnippetRefKind
): string {
  const normalizedTitle = normalizeInjectedLabel(title);
  return body
    .split("\n")
    .filter((line) => {
      const nameMatch = line.match(/^Name:\s*(.+)\s*$/i);
      if (nameMatch && normalizeInjectedLabel(nameMatch[1]!) === normalizedTitle) return false;
      if (refKind === "experience") {
        const triggerMatch = line.match(/^Trigger:\s*(.+)\s*$/i);
        if (triggerMatch && normalizeInjectedLabel(triggerMatch[1]!) === normalizedTitle) return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

function normalizeInjectedLabel(value: string): string {
  return value.trim().toLowerCase();
}

function indentInjectedBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `   ${line}` : line))
    .join("\n")
    .replace(/^ {3}/, "");
}

function contextMemoriesForInjectedSources(memories: MemoryRow[], sourceMemoryIds: string[]): MemoryRow[] {
  const visibleIds = new Set(sourceMemoryIds);
  const visibleEpisodeIds = new Set<string>();
  const legacySkillSourcePolicyIds = new Set<string>();
  for (const id of sourceMemoryIds) {
    if (readableMemoryIdKind(id) === "episode") visibleEpisodeIds.add(id);
  }
  for (const memory of memories) {
    if (!visibleIds.has(memory.id)) continue;
    if (memory.memoryLayer === "L1") {
      const trace = traceMetaFromMemory(memory);
      if (trace?.episodeId) visibleEpisodeIds.add(trace.episodeId);
    }
    for (const policyId of sourcePolicyIdsForLegacySkillGuidance(memory)) {
      legacySkillSourcePolicyIds.add(policyId);
    }
  }
  return memories.filter((memory) => {
    if (visibleIds.has(memory.id)) return true;
    if (memory.memoryLayer !== "L2") return false;
    const policy = policyMetaFromMemory(memory);
    if (!policy || !policyHasDecisionGuidance(policy)) return false;
    if (legacySkillSourcePolicyIds.has(memory.id)) return true;
    return policy.sourceTraceIds.some((id) => visibleIds.has(id)) ||
      policy.sourceEpisodeIds.some((id) => visibleEpisodeIds.has(id));
  });
}

function contextMemoriesForRecallHits(hits: RecallHit[], memories: MemoryRow[]): MemoryRow[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const selected = new Map<string, MemoryRow>();
  const hitTraceIds = new Set<string>();
  const hitEpisodeIds = new Set<string>();
  const legacySkillSourcePolicyIds = new Set<string>();
  for (const hit of hits) {
    if (readableMemoryIdKind(hit.id) === "episode") hitEpisodeIds.add(hit.id);
    const memory = byId.get(hit.id);
    if (!memory) continue;
    selected.set(memory.id, memory);
    if (memory.memoryLayer === "L1") {
      hitTraceIds.add(memory.id);
      const trace = traceMetaFromMemory(memory);
      if (trace?.episodeId) hitEpisodeIds.add(trace.episodeId);
    }
    for (const policyId of sourcePolicyIdsForLegacySkillGuidance(memory)) {
      legacySkillSourcePolicyIds.add(policyId);
    }
  }
  for (const memory of memories) {
    if (memory.memoryLayer !== "L2") continue;
    const policy = policyMetaFromMemory(memory);
    if (!policy || !policyHasDecisionGuidance(policy)) continue;
    const traceOverlap = policy.sourceTraceIds.some((id) => hitTraceIds.has(id));
    const episodeOverlap = policy.sourceEpisodeIds.some((id) => hitEpisodeIds.has(id));
    const legacySkillFallback = legacySkillSourcePolicyIds.has(memory.id);
    if (traceOverlap || episodeOverlap || legacySkillFallback || hits.some((hit) => hit.id === memory.id)) {
      selected.set(memory.id, memory);
    }
  }
  return [...selected.values()];
}

function decisionGuidanceSection(memories: MemoryRow[]): InjectedContext["sections"][number] | undefined {
  const preference = new Map<string, { text: string; sourceIds: Set<string> }>();
  const antiPattern = new Map<string, { text: string; sourceIds: Set<string> }>();
  for (const memory of memories) {
    const guidance = decisionGuidanceFromMemory(memory);
    for (const item of guidance.preference) {
      addDecisionGuidanceLine(preference, item, memory.id);
    }
    for (const item of guidance.antiPattern) {
      addDecisionGuidanceLine(antiPattern, item, memory.id);
    }
  }
  const preferEntries = rankedDecisionGuidanceLines(preference).slice(0, 3);
  const avoidEntries = rankedDecisionGuidanceLines(antiPattern).slice(0, 3);
  const preferLines = preferEntries.map((entry) => entry.text);
  const avoidLines = avoidEntries.map((entry) => entry.text);
  if (preferLines.length === 0 && avoidLines.length === 0) return undefined;
  const memoryIds = new Set<string>();
  for (const entry of [...preferEntries, ...avoidEntries]) {
    for (const id of entry.sourceIds) {
      memoryIds.add(id);
    }
  }
  const contentLines = [
    "## Decision guidance (distilled from past similar situations)",
    "",
    "Apply these BEFORE choosing your next action. Each line was learned",
    "from one or more past episodes where the user told us what to prefer",
    "or avoid in this kind of context."
  ];
  if (preferLines.length > 0) {
    contentLines.push("", "**Prefer**");
    preferLines.forEach((item, index) => {
      contentLines.push(`  ${index + 1}. ${item}`);
    });
  }
  if (avoidLines.length > 0) {
    contentLines.push("", "**Avoid**");
    avoidLines.forEach((item, index) => {
      contentLines.push(`  ${index + 1}. ${item}`);
    });
  }
  const content = contentLines.join("\n");
  return {
    id: "decision-guidance",
    title: "Decision guidance",
    kind: "policy",
    memoryLayer: "L2",
    memoryIds: [...memoryIds],
    content,
    tokenEstimate: estimateTokens(content)
  };
}

function addDecisionGuidanceLine(
  into: Map<string, { text: string; sourceIds: Set<string> }>,
  raw: string,
  sourceId: string
): void {
  const text = clip(singleLine(raw), 220);
  const key = decisionGuidanceKey(text);
  if (!key) return;
  const existing = into.get(key);
  if (existing) {
    existing.sourceIds.add(sourceId);
    return;
  }
  into.set(key, {
    text,
    sourceIds: new Set([sourceId])
  });
}

function rankedDecisionGuidanceLines(
  lines: Map<string, { text: string; sourceIds: Set<string> }>
): Array<{ text: string; sourceIds: Set<string> }> {
  return [...lines.values()].sort((a, b) =>
    b.sourceIds.size - a.sourceIds.size ||
    a.text.localeCompare(b.text)
  );
}

function decisionGuidanceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!！?？,，;；:：]+$/g, "")
    .trim();
}

function decisionGuidanceFromMemory(memory: MemoryRow): { preference: string[]; antiPattern: string[] } {
  if (memory.memoryLayer === "L2") {
    const policy = policyMetaFromMemory(memory);
    return {
      preference: policy?.decisionGuidance.preference ?? [],
      antiPattern: policy?.decisionGuidance.antiPattern ?? []
    };
  }
  if (memory.memoryLayer === "Skill") {
    const skill = isRecord(memory.properties.internal_info.skill)
      ? memory.properties.internal_info.skill
      : {};
    const procedure = isRecord(skill.procedure_json)
      ? skill.procedure_json
      : isRecord(memory.properties.internal_info.procedure_json)
      ? memory.properties.internal_info.procedure_json
      : {};
    const guidance = isRecord(procedure.decisionGuidance)
      ? procedure.decisionGuidance
      : isRecord(procedure.decision_guidance)
      ? procedure.decision_guidance
      : {};
    return {
      preference: stringArray(guidance.preference),
      antiPattern: stringArray(guidance.antiPattern ?? guidance.anti_pattern)
    };
  }
  return { preference: [], antiPattern: [] };
}

function policyHasDecisionGuidance(policy: PolicyMeta): boolean {
  return policy.decisionGuidance.preference.length > 0 || policy.decisionGuidance.antiPattern.length > 0;
}

function sourcePolicyIdsForLegacySkillGuidance(memory: MemoryRow): string[] {
  if (memory.memoryLayer !== "Skill") return [];
  const guidance = decisionGuidanceFromMemory(memory);
  if (guidance.preference.length > 0 || guidance.antiPattern.length > 0) return [];
  return skillMetaFromMemory(memory)?.sourcePolicyIds ?? [];
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function emptyInjectedContext(): InjectedContext {
  return {
    markdown: "",
    sections: [],
    tokenEstimate: 0
  };
}

interface RetrievalDependencies {
  repos: Repositories;
  readonly config: MemmyConfig;
  readonly llm: LlmClient;
  readonly skillLlm: LlmClient;
  readonly embedder: Embedder;
  assertEpisodeInScope(episode: EpisodeRecord, namespace?: RuntimeNamespace): void;
  assertMemorySearchEnabled(): void;
  memoryAddEnabled(): boolean;
  memorySearchEnabled(): boolean;
  queryRewriteEnabled(): boolean;
  requireEpisode(episodeId: string): EpisodeRecord;
  resolveContext(request: RequestEnvelope & { sessionId?: string; userId?: string }): {
    userId: string;
    conversationId?: string;
    namespace: RuntimeNamespace;
  };
  turnStartRetrievalLimit(): number;
  memoryHasImportPipeline(memory: MemoryRow): boolean;
  namespaceIdFromContext(context: RuntimeNamespace): string;
  withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T>;
}

export class RetrievalService {
  private readonly candidatePool: IndexedCandidatePool;

  constructor(private readonly deps: RetrievalDependencies) {
    this.candidatePool = new IndexedCandidatePool(deps);
  }

  isMemoryReadyForRetrieval(memory: MemoryRow): boolean {
    return this.candidatePool.isMemoryReadyForRetrieval(memory);
  }

  async search(request: InternalMemorySearchRequest): Promise<{
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    candidateMemoryIds: string[];
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    tierLatencyMs: {
      search: number;
      rerank: number;
      budget: number;
      total: number;
    };
    status: string[];
    verbose: boolean;
    serverTime: string;
  }> {
    const startedAt = Date.now();
    if (!this.deps.memorySearchEnabled()) {
      return this.searchNoRead(request, startedAt);
    }
    const context = this.deps.resolveContext(request);
    const retrievalMode = request.retrievalMode ?? "search";
    const episode = request.episodeId
      ? this.deps.requireEpisode(request.episodeId)
      : request.sessionId
        ? this.deps.repos.runtime.latestEpisodeForSession(request.sessionId)
        : undefined;
    if (episode) {
      this.deps.assertEpisodeInScope(episode, request.namespace);
    }
    const recentRawTurnIds = retrievalMode === "turn_start" && request.sessionId
      ? new Set(
          this.deps.repos.runtime
            .listRecentRawTurnsBySession(request.sessionId, 8)
            .map((turn) => turn.id)
        )
      : undefined;
    const tuning = this.retrievalTuningConfig();
    const allowedLayers = retrievalLayersForProfile(retrievalLayersForMode(retrievalMode), tuning);
    const layers = request.layers === undefined
      ? allowedLayers
      : request.layers.filter((layer) => allowedLayers.includes(layer));
    const searchAt = Date.now();
    const candidateCount = layers.length === 0
      ? 0
      : this.candidatePool.retrievalCandidateCount({ layers, tags: request.tags });
    const retrievalQuery = focusResearchRetrievalQuery(request.query, tuning.domain).text;
    const queryExtract = candidateCount > 0 ? await this.extractRetrievalQuery(retrievalQuery) : null;
    const queryVectorText = queryExtract?.queryVecText?.trim() || retrievalQuery;
    const retrievalLimit = request.limit ?? this.deps.turnStartRetrievalLimit();
    const retrievalOutput = await this.retrieveSearchMemories({
      query: retrievalQuery,
      queryVectorText,
      queryExtract,
      layers,
      tags: request.tags,
      limit: retrievalLimit,
      mode: retrievalMode,
      excludeTraceRawTurnIds: recentRawTurnIds,
      targetSkillId: request.targetSkillId
    });
    const retrieval = retrievalOutput.retrieval;
    const memories = retrievalOutput.memories;
    const rerankAt = Date.now();
    const filteredHits = await this.filterRecallHits(queryVectorText, retrieval.hits);
    const hits = filteredHits.hits;
    const contextPacket = buildInjectedContext(
      hits,
      request.contextBudget ?? 1800,
      contextMemoriesForRecallHits(hits, memories),
      retrievalMode,
      request.contextHints,
      request.injectedContextQuery ?? request.query,
      tuning
    );
    const injectedContext = contextPacket.injectedContext;
    const budgetAt = Date.now();
    const recallEventId = newId("recall");
    const candidateMemoryIds = memories.map((memory) => memory.id);
    const sourceMemoryIds = contextPacket.sourceMemoryIds;
    const hitIds = new Set(hits.map((hit) => hit.id));
    const dropped = [
      ...contextPacket.droppedDueToBudget,
      ...memories
        .filter((memory) => !hitIds.has(memory.id))
        .slice(0, 50)
        .map((memory) => ({
          id: memory.id,
          kind: kindFromMemory(memory),
          memoryLayer: memory.memoryLayer,
          reason: "rank_threshold" as const
        }))
    ];
    if (this.deps.memoryAddEnabled()) {
      this.deps.repos.runtime.insertRecallEvent({
        id: recallEventId,
        namespaceId: this.deps.namespaceIdFromContext(context.namespace),
        sessionId: request.sessionId,
        episodeId: episode?.id,
        turnId: request.turnId,
        userId: context.userId,
        query: request.query,
        queryHash: stableHash(request.query),
        layers,
        candidateMemoryIds,
        injectedMemoryIds: sourceMemoryIds,
        hitMemoryIds: hits.map((hit) => hit.id),
        dropped,
        outcome: "pending",
        request,
        createdAt: nowIso()
      });
    }

    const response = {
      searchEventId: recallEventId,
      hits,
      injectedContext: request.includeInjectedContext === false ? emptyInjectedContext() : injectedContext,
      candidateMemoryIds,
      sourceMemoryIds,
      droppedDueToBudget: contextPacket.droppedDueToBudget,
      tierLatencyMs: {
        search: searchAt - startedAt,
        rerank: rerankAt - searchAt,
        budget: budgetAt - rerankAt,
        total: Date.now() - startedAt
      },
      status: uniq([
        ...filteredHits.status,
        ...(!this.deps.memoryAddEnabled() ? ["memory_add:disabled:no_recall_log"] : [])
      ]),
      verbose: request.verbose === true,
      serverTime: nowIso()
    };
    if (this.deps.memoryAddEnabled()) {
      const keptIds = new Set(hits.map((hit) => hit.id));
      const logMemoryById = new Map(memories.map((memory) => [memory.id, memory]));
      const toSearchCandidateLog = (hit: RecallHit): Record<string, unknown> =>
        searchCandidateFromHit(hit, logMemoryById.get(hit.id));
      const sourceAgent = request.source?.trim() || context.namespace.source;
      recordApiLog(this.deps.repos.runtime, "memory_search", {
        query: request.query,
        sessionId: request.sessionId,
        episodeId: episode?.id,
        layers,
        retrievalMode
      }, {
        candidates: retrieval.hits.map(toSearchCandidateLog),
        filtered: hits.map(toSearchCandidateLog),
        droppedByLlm: retrieval.hits.filter((hit) => !keptIds.has(hit.id)).map(toSearchCandidateLog),
        stats: {
          raw: memories.length,
          ranked: retrieval.hits.length,
          droppedByThreshold: retrieval.debug.droppedByThreshold,
          topRelevance: retrieval.debug.topRelevance,
          llmFilter: {
            outcome: filteredHits.status.length > 0 ? filteredHits.status.join(",") : "kept",
            kept: hits.length,
            dropped: Math.max(0, retrieval.hits.length - hits.length)
          },
          finalReturned: hits.length
        },
        status: filteredHits.status
      }, Date.now() - startedAt, true, response.serverTime, sourceAgent);
    }
    return response;
  }

  private async retrieveSearchMemories(input: {
    query: string;
    queryVectorText: string;
    queryExtract: RetrievalQueryExtract | null;
    layers: MemoryLayer[];
    tags?: string[];
    limit: number;
    mode: RetrievalMode;
    excludeTraceRawTurnIds?: ReadonlySet<string>;
    targetSkillId?: string;
  }): Promise<{ retrieval: RetrievalResult; memories: MemoryRow[] }> {
    if (input.limit <= 0 || input.layers.length === 0) {
      return { retrieval: emptyRetrievalResult(), memories: [] };
    }
    const runQuery = async (
      query: string,
      queryVectorText: string,
      queryExtract: RetrievalQueryExtract | null
    ): Promise<{ retrieval: RetrievalResult; memories: MemoryRow[] }> => {
      const config = this.retrievalTuningConfig();
      const compiledQuery = compileRetrievalQuery(query, queryExtract, {
        domain: config.domain
      });
      const hasVectorCandidates = this.candidatePool.hasRetrievalVectorCandidates({
        layers: input.layers,
        tags: input.tags
      });
      const queryVector = hasVectorCandidates ? await this.queryVector(queryVectorText) : undefined;
      const candidatePool = await this.candidatePool.indexedRetrievalCandidatePool({
        compiledQuery,
        queryVector,
        layers: input.layers,
        tags: input.tags,
        targetSkillId: input.targetSkillId,
        config
      });
      const memories = candidatePool.memories;
      if (memories.length === 0) {
        return { retrieval: emptyRetrievalResult(), memories };
      }
      return {
        memories,
        retrieval: retrievePluginMemories({
          query,
          queryVector,
          queryExtract,
          memories,
          layers: input.layers,
          limit: input.limit,
          mode: input.mode,
          excludeTraceRawTurnIds: input.excludeTraceRawTurnIds,
          targetSkillId: input.targetSkillId,
          channelScoresByMemory: candidatePool.channelScoresByMemory,
          config
        })
      };
    };

    if (!this.deps.queryRewriteEnabled()) {
      return runQuery(input.query, input.queryVectorText, input.queryExtract);
    }

    const queries = await this.planQueryRewrite(input.query);
    if (queries.length <= 1) {
      const query = queries[0] ?? input.query;
      return runQuery(
        query,
        query === input.query ? input.queryVectorText : query,
        query === input.query ? input.queryExtract : null
      );
    }

    const outputs = await Promise.all(queries.map((query) =>
      runQuery(
        query,
        query === input.query ? input.queryVectorText : query,
        query === input.query ? input.queryExtract : null
      )
    ));
    return {
      retrieval: mergeRetrievalResults(outputs.map((output) => output.retrieval), input.limit, QUERY_REWRITE_RRF_CONSTANT, QUERY_REWRITE_PER_QUERY_MIN_KEEP),
      memories: uniqMemories(outputs.flatMap((output) => output.memories))
    };
  }

  private async filterRecallHits(query: string, hits: RecallHit[]): Promise<{
    hits: RecallHit[];
    status: string[];
  }> {
    const config = this.deps.config.algorithm.retrieval;
    const usesSummaryLlm = this.deps.llm.isConfigured();
    const filterLlm = usesSummaryLlm
      ? this.deps.llm
      : this.deps.skillLlm.isConfigured()
        ? this.deps.skillLlm
        : undefined;
    if (!config.llmFilterEnabled) {
      return {
        hits,
        status: ["llm_filter:disabled"]
      };
    }
    if (hits.length < config.llmFilterMinCandidates) {
      return { hits, status: [] };
    }
    if (!query.trim()) {
      return { hits, status: [] };
    }
    if (!filterLlm?.isConfigured()) {
      return {
        hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
        status: ["llm_filter:no_llm"]
      };
    }

    try {
      const bodyChars = Math.max(120, config.llmFilterCandidateBodyChars);
      const candidates = hits.map((hit, index) =>
        `${index + 1}. ${describeRetrievalFilterCandidate(hit, bodyChars)}`
      ).join("\n");
      const completeFilter = (llm: LlmClient, isSummaryLlm: boolean) => llm.completeJson<{
        selected?: unknown;
        ranked?: unknown;
        sufficient?: unknown;
      }>(
        [
          {
            role: "system",
            content: RETRIEVAL_FILTER_PROMPT.system
          },
          {
            role: "user",
            content: `QUERY: ${clip(query, 500)}\n\nCANDIDATES:\n${candidates}`
          }
        ],
        {
          operation: `retrieval.${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: RETRIEVAL_FILTER_TIMEOUT_MS,
          maxRetries: 0,
          maxTokens: isSummaryLlm
            ? MEMORY_SUMMARY_MAX_TOKENS
            : Math.min(2048, Math.max(160, hits.length * 8 + 80)),
          jsonMode: true
        }
      );
      let result;
      try {
        result = await completeFilter(filterLlm, usesSummaryLlm);
      } catch (primaryError) {
        const evolutionFallback = usesSummaryLlm &&
          this.deps.skillLlm.isConfigured() &&
          this.deps.skillLlm !== filterLlm
          ? this.deps.skillLlm
          : undefined;
        if (!evolutionFallback) throw primaryError;
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          pipeline: "retrieval.filter",
          fallback: "evolution_llm",
          primaryModel: filterLlm.config.model,
          fallbackModel: evolutionFallback.config.model,
          ...memoryErrorFields(primaryError)
        });
        result = await completeFilter(evolutionFallback, false);
      }
      const selectedRaw = Array.isArray(result.selected)
        ? result.selected
        : Array.isArray(result.ranked)
          ? result.ranked
          : null;
      if (!selectedRaw) {
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          pipeline: "retrieval.filter",
          fallback: "candidate_cap",
          reason: "invalid_selection_shape",
          candidateCount: hits.length
        });
        return {
          hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
          status: ["llm_filter:llm_failed_fallback_cap"]
        };
      }
      const selected = selectedRaw
        .map((value) => typeof value === "number" ? value : Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.floor(value) - 1)
        .filter((value, index, values) => value >= 0 && value < hits.length && values.indexOf(value) === index)
        .slice(0, Math.max(0, config.llmFilterMaxKeep));
      if (selected.length === 0) {
        if (selectedRaw.length === 0) {
          return {
            hits: [],
            status: ["llm_filter:llm_dropped_all"]
          };
        }
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          pipeline: "retrieval.filter",
          fallback: "candidate_cap",
          reason: "invalid_selection_indices",
          candidateCount: hits.length,
          selectedCount: selectedRaw.length
        });
        return {
          hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
          status: ["llm_filter:llm_failed_fallback_cap"]
        };
      }
      const kept = selected.map((index) => hits[index]!).filter(Boolean);
      return {
        hits: kept,
        status: kept.length === hits.length ? ["llm_filter:llm_kept_all"] : ["llm_filter:llm_filtered"]
      };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
        pipeline: "retrieval.filter",
        fallback: "candidate_cap",
        candidateCount: hits.length,
        ...memoryErrorFields(error)
      });
      return {
        hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
        status: ["llm_filter:llm_failed_fallback_cap"]
      };
    }
  }

  private async planQueryRewrite(rawQuery: string): Promise<string[]> {
    const raw = rawQuery.trim();
    if (!raw || !this.deps.skillLlm.isConfigured()) return [rawQuery];
    try {
      const result = await this.deps.skillLlm.completeJson<{
        queries?: unknown;
      }>(
        [
          {
            role: "system",
            content: QUERY_REWRITE_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: `USER MEMORY SEARCH REQUEST:\n${raw.slice(0, 4000)}`
          }
        ],
        {
          operation: "retrieval.query_rewrite.v1",
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: QUERY_REWRITE_TIMEOUT_MS,
          maxRetries: QUERY_REWRITE_MAX_RETRIES,
          maxTokens: 360,
          jsonMode: true
        }
      );
      const queries = normalizeQueryRewriteQueries(result.queries, QUERY_REWRITE_COUNT);
      if (queries.length > 0) return queries;
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_rewrite.v1",
        pipeline: "retrieval.query_rewrite",
        fallback: "original_query",
        reason: "empty_rewrite"
      });
      return [raw];
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_rewrite.v1",
        pipeline: "retrieval.query_rewrite",
        fallback: "original_query",
        ...memoryErrorFields(error)
      });
      return [raw];
    }
  }

  private async extractRetrievalQuery(rawQuery: string): Promise<RetrievalQueryExtract | null> {
    const raw = rawQuery.trim();
    if (!raw || !this.deps.skillLlm.isConfigured()) return null;
    try {
      const result = await this.deps.skillLlm.completeJson<{
        queryVecText?: unknown;
        keywords?: unknown;
      }>(
        [
          {
            role: "system",
            content: RETRIEVAL_QUERY_EXTRACT_PROMPT.system
          },
          {
            role: "user",
            content: `COMPLETE USER INPUT:\n${raw.slice(0, 4000)}`
          }
        ],
        {
          operation: `retrieval.${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS,
          maxRetries: 0,
          maxTokens: 320,
          jsonMode: true
        }
      );
      const queryVecText = typeof result.queryVecText === "string" ? result.queryVecText.trim() : "";
      const keywords = normalizeRetrievalExtractKeywords(result.keywords);
      if (!queryVecText && keywords.length === 0) {
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
          pipeline: "retrieval.query_extract",
          fallback: "raw_query",
          reason: "empty_extract"
        });
        return null;
      }
      return { queryVecText, keywords };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
        pipeline: "retrieval.query_extract",
        fallback: "raw_query",
        ...memoryErrorFields(error)
      });
      return null;
    }
  }

  retrievalTuningConfig(): {
    tier1TopK: number;
    tier2TopK: number;
    tier3TopK: number;
    candidatePoolFactor: number;
    weightCosine: number;
    weightPriority: number;
    mmrLambda: number;
    rrfConstant: number;
    relativeThresholdFloor: number;
    minSkillEta: number;
    minTraceSim: number;
    episodeGoalMinSim: number;
    minWorldModelConfidence: number;
    includeLowValue: boolean;
    tagFilter: "auto" | "on" | "off";
    keywordTopK: number;
    skillEtaBlend: number;
    smartSeed: boolean;
    smartSeedRatio: number;
    multiChannelBypass: boolean;
    skillInjectionMode: "summary" | "full";
    skillSummaryChars: number;
    decayHalfLifeDays: number;
    domain: "" | "research";
    readOnlyInjectionProfile: "all" | "experience" | "skill" | "skill_experience";
  } {
    const retrieval = this.deps.config.algorithm.retrieval;
    return {
      tier1TopK: retrieval.tier1TopK,
      tier2TopK: retrieval.tier2TopK,
      tier3TopK: retrieval.tier3TopK,
      candidatePoolFactor: retrieval.candidatePoolFactor,
      weightCosine: retrieval.weightCosine,
      weightPriority: retrieval.weightPriority,
      mmrLambda: retrieval.mmrLambda,
      rrfConstant: retrieval.rrfConstant,
      relativeThresholdFloor: retrieval.relativeThresholdFloor,
      minSkillEta: retrieval.minSkillEta,
      minTraceSim: retrieval.minTraceSim,
      episodeGoalMinSim: retrieval.episodeGoalMinSim,
      minWorldModelConfidence: this.deps.config.algorithm.l3Abstraction.minConfidenceForRetrieval,
      includeLowValue: retrieval.includeLowValue,
      tagFilter: retrieval.tagFilter,
      keywordTopK: retrieval.keywordTopK,
      skillEtaBlend: retrieval.skillEtaBlend,
      smartSeed: retrieval.smartSeed,
      smartSeedRatio: retrieval.smartSeedRatio,
      multiChannelBypass: retrieval.multiChannelBypass,
      skillInjectionMode: retrieval.skillInjectionMode,
      skillSummaryChars: retrieval.skillSummaryChars,
      decayHalfLifeDays: this.deps.config.algorithm.reward.decayHalfLifeDays,
      domain: this.deps.config.domain,
      readOnlyInjectionProfile: retrieval.readOnlyInjectionProfile
    };
  }

  async worldModelQuery(input: InternalMemorySearchRequest): Promise<{
    hits: RecallHit[];
    queried: {
      query: string;
      tags: string[];
      limit: number;
    };
    worldModels: Array<RecallHit & {
      body: string;
      sourceMemoryIds: string[];
    }>;
    injectedContext: InjectedContext;
    status: string[];
    serverTime: string;
  }> {
    this.deps.assertMemorySearchEnabled();
    const result = await this.search({
      ...input,
      layers: ["L3"],
      includeInjectedContext: true,
      retrievalMode: "world_model"
    });
    const memories = this.deps.repos.memories.getMany(result.hits.map((hit) => hit.id));
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    return {
      hits: result.hits,
      queried: {
        query: input.query,
        tags: input.tags ?? [],
        limit: input.limit ?? 8
      },
      worldModels: result.hits.map((hit) => {
        const memory = byId.get(hit.id);
        return {
          ...hit,
          body: memory?.memoryValue ?? hit.snippet,
          sourceMemoryIds: memory ? sourceMemoryIdsFromMemory(memory) : []
        };
      }),
      injectedContext: result.injectedContext,
      status: result.status,
      serverTime: nowIso()
    };
  }

  async queryVector(query: string): Promise<number[] | undefined> {
    try {
      return await this.deps.withTimeout(this.deps.embedder.embedOne(query, "query"), QUERY_VECTOR_TIMEOUT_MS);
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_embedding",
        pipeline: "retrieval.query_vector",
        fallback: "text_only_retrieval",
        ...memoryErrorFields(error)
      });
      return undefined;
    }
  }

  private searchNoRead(
    request: InternalMemorySearchRequest,
    startedAt: number
  ): ReturnType<RetrievalService["search"]> {
    const total = Date.now() - startedAt;
    const tuning = this.retrievalTuningConfig();
    const contextPacket = request.includeInjectedContext === false
      ? {
          injectedContext: emptyInjectedContext(),
          sourceMemoryIds: [],
          droppedDueToBudget: []
        }
      : buildInjectedContext(
          [],
          request.contextBudget ?? 1800,
          [],
          request.retrievalMode ?? "search",
          request.contextHints,
          request.injectedContextQuery ?? request.query,
          tuning
        );
    return Promise.resolve({
      searchEventId: `recall_${stableHash({
        disabled: "memory_search",
        query: request.query,
        sessionId: request.sessionId,
        turnId: request.turnId
      }).slice(0, 20)}`,
      hits: [],
      injectedContext: contextPacket.injectedContext,
      candidateMemoryIds: [],
      sourceMemoryIds: contextPacket.sourceMemoryIds,
      droppedDueToBudget: contextPacket.droppedDueToBudget,
      tierLatencyMs: {
        search: total,
        rerank: 0,
        budget: 0,
        total
      },
      status: ["memory_search:disabled"],
      verbose: request.verbose === true,
      serverTime: nowIso()
    });
  }
}
