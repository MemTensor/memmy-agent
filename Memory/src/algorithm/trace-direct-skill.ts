import { SKILL_CRYSTALLIZE_PROMPT } from "./plugin-algorithms.js";
import { isRecord } from "../utils/json.js";

export type SkillEpisodeOutcome = "success" | "failure" | "unknown";
export type DirectSkillRebuildScope = "retrieval" | "constraints" | "workflow";
export type DirectSkillEvolveAction =
  | "crystallize"
  | "rebuild"
  | "skip_no_success_anchor"
  | "skip_unknown_only";

export const DIRECT_SKILL_SOURCE = "worker.skill_batch_evolve.v1";
export const DIRECT_SKILL_PLUGIN = "skill.batch_evolve.v1";

export const ARTIFACT_EXTENSIONS = [
  "xlsx", "xls", "xlsm", "csv", "tsv",
  "pptx", "ppt",
  "pdf",
  "docx", "doc",
  "json", "parquet",
  "txt", "md", "html", "xml", "yaml", "yml"
] as const;

export const DEFAULT_DIRECT_SKILL_CLUSTERING = {
  /** Fine-cluster cosine floor inside a tool/artifact family. */
  joinThreshold: 0.5,
  /** Cosine floor when both sides have no tools and no artifacts. */
  joinThresholdEmpty: 0.7,
  toolJaccardFloor: 0.4,
  artifactJaccardFloor: 0.3,
  batchSuccessLimit: 3,
  batchFailureLimit: 3,
  toolOutputClip: 3000,
  maxBatchSize: 6
} as const;

export const SEED_META_SKILL_MD = `You extract a callable SOP from RawTurn evidence.

Useful skill: an executor following steps can reproduce the key actions and checks from successful traces — not restate the user request.
steps.body must land on commands, artifacts, acceptance checks, or recovery moves seen in successful RawTurns.
Ban fluff: "carefully check / verify the result / handle as needed" is not a useful step.
One-off filenames go in parameters, never in name.
Failures only enter anti_pattern / preconditions, never steps.
Stop abstraction at a re-executable program, not "use the relevant tools to process the task".`;

export const DIRECT_SKILL_CRYSTALLIZE_EXTRA = `This chain has no L2 POLICY. POLICY is empty — do not invent one.
EVIDENCE is RawTurn traces (user, assistant, full tool calls). Mine real commands, artifacts, and checks from success turns.
Failure turns inform preconditions and decision_guidance.anti_pattern only. Never copy a failure command sequence into steps.
At most 12 preconditions and 5 anti_pattern. Write cluster-level constraints, not instance ids, paths, or one-off names.
tools MUST be a subset of EVIDENCE_TOOLS. Empty tools is legal when evidence has no tools.
No fluff steps. Prefer 3-8 concrete steps that an agent can re-run.
Write a cluster-level SOP for the next similar task, not a recap of one episode. Use this batch as concrete checks, not as the only task type.
Do not hard-code a benchmark's scoring rule. If a verifier, grader, or test runner appears in EVIDENCE, keep the check it actually performs. Domain mechanics belong in the traces, not in this prompt.`;

export const MAX_DIRECT_SKILL_PRECONDITIONS = 12;
export const MAX_DIRECT_SKILL_ANTI_PATTERN = 5;

export const DIRECT_SKILL_REBUILD_EXTRA = `You update an existing SOP from NEW RawTurn episodes only.
REBUILD_SCOPE:
- retrieval: only improve retrieval_blurb / trigger_context / summary.
- constraints: rewrite preconditions and anti_pattern as the complete new lists. Do not rewrite working steps. The merger keeps your lists as-is and does not union them with the old Skill. At most 12 preconditions and 5 anti_pattern. Drop stale or instance-specific footnotes.
- workflow: you may rewrite steps / tools / parameters when new successful traces change the procedure. Return the constraint lists you want kept, newest failures first. Do not drop a still-valid anti_pattern without a concrete reason.
Keep name locked unless REPAIR_RENAME_ALLOWED is true.
Preconditions must be cluster-level invariants (how to inspect, what the checker actually reads, what not to destroy). Never put instance ids, paths, cell refs, commit hashes, or ticket numbers in preconditions — those go in parameters or examples.
Return the crystallize JSON plus changed_sections.`;

export const DIRECT_SKILL_META_PROMPT = `You update optimizer-only meta-skill for a future skill extractor.
Speak to the next extractor, not to an execution agent. Do not output a task SOP.
Rewrite meta_skill_content as a short, actionable set of principles. Delete principles this batch falsified.
Return JSON only:
{
  "reasoning": "which writing was useful or harmful this round",
  "meta_skill_content": "short principles for the next extractor"
}`;

export interface DirectSkillClusteringConfig {
  joinThreshold: number;
  joinThresholdEmpty: number;
  toolJaccardFloor: number;
  artifactJaccardFloor: number;
  batchSuccessLimit: number;
  batchFailureLimit: number;
  toolOutputClip: number;
  maxBatchSize: number;
}

export interface OutcomeThresholds {
  success: number;
  failure: number;
}

export interface EpisodeSkillFeatures {
  episodeId: string;
  userId: string;
  projectId?: string;
  tools: string[];
  artifacts: string[];
  toolBigrams: string[];
  queryText: string;
  queryVec: number[] | null;
  outcome: SkillEpisodeOutcome;
  rTask?: number;
}

export interface SkillClusterFeatures {
  id: string;
  userId: string;
  projectId?: string;
  tools: string[];
  artifacts: string[];
  toolBigrams: string[];
  centroid: number[] | null;
}

export interface PackedToolCall {
  name: string;
  input: unknown;
  output: unknown;
  success: boolean;
}

export interface PackedRawTurn {
  user: string;
  assistant: string;
  reasoning: string;
  tools: PackedToolCall[];
}

export interface PackedEpisodeEvidence {
  episode_id: string;
  r_task: number | null;
  outcome: SkillEpisodeOutcome;
  turns: PackedRawTurn[];
}

export interface Top6Member {
  episodeId: string;
  outcome: SkillEpisodeOutcome;
  rTask?: number;
  updatedAt: string;
}

export interface DirectSkillProcedureJson {
  retrievalBlurb: string;
  triggerContext: string;
  summary: string;
  parameters: Array<Record<string, unknown>>;
  preconditions: string[];
  steps: Array<{ title: string; body: string }>;
  examples: Array<{ input: string; expected: string }>;
  decisionGuidance: { preference: string[]; antiPattern: string[] };
  tags: string[];
  tools: string[];
}

export interface DirectSkillHardGateResult {
  ok: boolean;
  reasons: string[];
}

export interface AssignDecision {
  action: "join" | "create" | "sticky";
  clusterId?: string;
  score?: number;
  reason: string;
  stage?: "coarse" | "fine";
}

export interface EvolveBranch {
  action: DirectSkillEvolveAction;
  rebuildScope?: DirectSkillRebuildScope;
  reason: string;
}

export interface RawTurnLike {
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

const ARTIFACT_RE = new RegExp(
  String.raw`(?:^|[^\w])(?:[\w./\\-]+)?\.(${ARTIFACT_EXTENSIONS.join("|")})\b`,
  "gi"
);

const FLUFF_STEP_RE = /^(请)?(仔细)?(检查|验证|确认|处理|按需处理)(一下|结果|输出|数据)?[。.\s]*$/u;
const FLUFF_STEP_EN_RE = /^(please\s+)?(carefully\s+)?(check|verify|validate|handle|process)(\s+(the\s+)?(result|output|data|as needed))?\.?$/i;
const SNAKE_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;
const TOKEN_RE = /[\p{Script=Han}]{2,}|[a-z0-9_.-]{3,}/gu;

export function classifySkillOutcome(
  rTask: number | undefined,
  thresholds: OutcomeThresholds
): SkillEpisodeOutcome {
  if (typeof rTask !== "number" || Number.isNaN(rTask)) return "unknown";
  if (rTask >= thresholds.success) return "success";
  if (rTask <= thresholds.failure) return "failure";
  return "unknown";
}

export function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left.map(normalizeFeature));
  const b = new Set(right.map(normalizeFeature));
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export function cosineSimilarity(left: number[] | null | undefined, right: number[] | null | undefined): number | null {
  if (!left?.length || !right?.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function mergeCentroid(
  current: number[] | null,
  incoming: number[] | null,
  memberCount: number
): number[] | null {
  if (!incoming?.length) return current;
  if (!current?.length || memberCount <= 0) return [...incoming];
  if (current.length !== incoming.length) return [...incoming];
  const n = memberCount;
  return current.map((value, index) => (value * n + (incoming[index] ?? 0)) / (n + 1));
}

export function extractArtifactTypes(...texts: Array<string | undefined | null>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    ARTIFACT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARTIFACT_RE.exec(text))) {
      const ext = match[1]?.toLowerCase();
      if (ext) found.add(ext);
    }
  }
  return [...found].sort();
}

export function extractToolNames(calls: unknown[] | undefined): string[] {
  const names = new Set<string>();
  for (const call of calls ?? []) {
    const name = toolCallName(call);
    if (name) names.add(name);
  }
  return [...names].sort();
}

export function toolBigrams(toolsInOrder: string[]): string[] {
  const pairs = new Set<string>();
  for (let i = 0; i < toolsInOrder.length - 1; i += 1) {
    const left = toolsInOrder[i];
    const right = toolsInOrder[i + 1];
    if (!left || !right || left === right) continue;
    pairs.add(`${left}>${right}`);
  }
  return [...pairs].sort();
}

export function firstUserQuery(turns: RawTurnLike[]): string {
  for (const turn of turns) {
    const text = (turn.userText ?? "").trim();
    if (text) return text;
  }
  return "";
}

export function extractEpisodeSkillFeatures(input: {
  episodeId: string;
  userId: string;
  projectId?: string;
  rTask?: number;
  turns: RawTurnLike[];
  queryVec?: number[] | null;
  thresholds: OutcomeThresholds;
}): EpisodeSkillFeatures {
  const toolsInOrder: string[] = [];
  const artifacts = new Set<string>();
  for (const turn of input.turns) {
    for (const name of extractToolNames(turn.toolCalls)) toolsInOrder.push(name);
    for (const artifact of extractArtifactTypes(
      turn.userText,
      turn.assistantText,
      stringifyUnknown(turn.toolCalls),
      stringifyUnknown(turn.toolResults)
    )) {
      artifacts.add(artifact);
    }
  }
  const tools = uniqSorted(toolsInOrder);
  return {
    episodeId: input.episodeId,
    userId: input.userId,
    projectId: input.projectId,
    tools,
    artifacts: [...artifacts].sort(),
    toolBigrams: toolBigrams(toolsInOrder),
    queryText: firstUserQuery(input.turns),
    queryVec: input.queryVec ?? null,
    outcome: classifySkillOutcome(input.rTask, input.thresholds),
    rTask: input.rTask
  };
}

export function canJoinCluster(
  episode: Pick<EpisodeSkillFeatures, "tools" | "artifacts" | "queryVec">,
  cluster: Pick<SkillClusterFeatures, "tools" | "artifacts" | "centroid">,
  config: DirectSkillClusteringConfig = DEFAULT_DIRECT_SKILL_CLUSTERING
): { ok: boolean; reason: string; bothEmpty: boolean } {
  const episodeHasTools = episode.tools.length > 0;
  const clusterHasTools = cluster.tools.length > 0;
  const episodeHasArtifacts = episode.artifacts.length > 0;
  const clusterHasArtifacts = cluster.artifacts.length > 0;

  if (episodeHasTools !== clusterHasTools) {
    return {
      ok: false,
      reason: episodeHasTools ? "episode_has_tools_cluster_empty" : "episode_empty_cluster_has_tools",
      bothEmpty: false
    };
  }

  if (episodeHasTools && clusterHasTools) {
    const toolScore = jaccard(episode.tools, cluster.tools);
    if (toolScore < config.toolJaccardFloor) {
      return { ok: false, reason: `tool_jaccard_${toolScore.toFixed(3)}`, bothEmpty: false };
    }
  }

  if (!episodeHasTools && !clusterHasTools) {
    if (episodeHasArtifacts && clusterHasArtifacts) {
      const artifactScore = jaccard(episode.artifacts, cluster.artifacts);
      if (artifactScore < config.artifactJaccardFloor) {
        return { ok: false, reason: `artifact_jaccard_${artifactScore.toFixed(3)}`, bothEmpty: true };
      }
      return { ok: true, reason: "artifact_overlap", bothEmpty: false };
    }
    if (episodeHasArtifacts !== clusterHasArtifacts) {
      return { ok: false, reason: "artifact_presence_mismatch", bothEmpty: false };
    }
    return { ok: true, reason: "both_empty", bothEmpty: true };
  }

  if (episodeHasArtifacts && clusterHasArtifacts) {
    const artifactScore = jaccard(episode.artifacts, cluster.artifacts);
    if (artifactScore < config.artifactJaccardFloor) {
      return { ok: false, reason: `artifact_jaccard_${artifactScore.toFixed(3)}`, bothEmpty: false };
    }
  }

  return { ok: true, reason: "hard_gates_passed", bothEmpty: false };
}

export function coarseFamilyScore(
  episode: Pick<EpisodeSkillFeatures, "tools" | "artifacts">,
  cluster: Pick<SkillClusterFeatures, "tools" | "artifacts">
): number {
  const parts: number[] = [];
  if (episode.tools.length > 0 && cluster.tools.length > 0) {
    parts.push(jaccard(episode.tools, cluster.tools));
  }
  if (episode.artifacts.length > 0 && cluster.artifacts.length > 0) {
    parts.push(jaccard(episode.artifacts, cluster.artifacts));
  }
  if (parts.length === 0) return 1;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

export function scoreClusterJoin(
  episode: EpisodeSkillFeatures,
  cluster: SkillClusterFeatures,
  config: DirectSkillClusteringConfig = DEFAULT_DIRECT_SKILL_CLUSTERING
): { score: number | null; reason: string; bothEmpty: boolean; stage: "coarse" | "fine" } {
  const hard = canJoinCluster(episode, cluster, config);
  if (!hard.ok) return { score: null, reason: hard.reason, bothEmpty: hard.bothEmpty, stage: "coarse" };

  const vec = cosineSimilarity(episode.queryVec, cluster.centroid);
  if (hard.bothEmpty) {
    if (vec === null) {
      return { score: null, reason: "both_empty_without_query_vec", bothEmpty: true, stage: "fine" };
    }
    return { score: vec, reason: "fine_vec", bothEmpty: true, stage: "fine" };
  }

  if (vec !== null) {
    return { score: vec, reason: "fine_vec", bothEmpty: false, stage: "fine" };
  }

  return {
    score: coarseFamilyScore(episode, cluster),
    reason: "coarse_family_only",
    bothEmpty: false,
    stage: "coarse"
  };
}

export function decideClusterAssignment(
  episode: EpisodeSkillFeatures,
  clusters: SkillClusterFeatures[],
  config: DirectSkillClusteringConfig = DEFAULT_DIRECT_SKILL_CLUSTERING
): AssignDecision {
  let best: {
    cluster: SkillClusterFeatures;
    score: number;
    bothEmpty: boolean;
    stage: "coarse" | "fine";
  } | undefined;
  for (const cluster of clusters) {
    if (cluster.userId !== episode.userId) continue;
    if (episode.projectId && cluster.projectId && episode.projectId !== cluster.projectId) continue;
    const scored = scoreClusterJoin(episode, cluster, config);
    if (scored.score === null) continue;
    const tau = scored.bothEmpty
      ? config.joinThresholdEmpty
      : scored.stage === "fine"
        ? config.joinThreshold
        : 0;
    if (scored.score < tau) continue;
    if (!best || scored.score > best.score) {
      best = {
        cluster,
        score: scored.score,
        bothEmpty: scored.bothEmpty,
        stage: scored.stage
      };
    }
  }
  if (!best) {
    return { action: "create", reason: "no_cluster_above_fine_threshold" };
  }
  return {
    action: "join",
    clusterId: best.cluster.id,
    score: best.score,
    stage: best.stage,
    reason: best.bothEmpty
      ? "joined_empty_cluster"
      : best.stage === "fine"
        ? "joined_by_fine_vec"
        : "joined_by_coarse_family"
  };
}

export function selectTop6Members(
  members: Top6Member[],
  config: DirectSkillClusteringConfig = DEFAULT_DIRECT_SKILL_CLUSTERING
): Top6Member[] {
  const byTime = (left: Top6Member, right: Top6Member) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.episodeId.localeCompare(right.episodeId);
  const successes = members.filter((item) => item.outcome === "success").sort(byTime);
  const failures = members.filter((item) => item.outcome === "failure").sort(byTime);
  const unknowns = members.filter((item) => item.outcome === "unknown").sort(byTime);
  const selected: Top6Member[] = [];
  const seen = new Set<string>();
  const push = (item: Top6Member | undefined) => {
    if (!item || seen.has(item.episodeId) || selected.length >= config.maxBatchSize) return;
    seen.add(item.episodeId);
    selected.push(item);
  };
  successes.slice(0, config.batchSuccessLimit).forEach(push);
  failures.slice(0, config.batchFailureLimit).forEach(push);
  for (const item of [...successes, ...failures, ...unknowns]) push(item);
  return selected;
}

export function packRawTurnEvidence(
  turns: RawTurnLike[],
  clipChars: number = DEFAULT_DIRECT_SKILL_CLUSTERING.toolOutputClip
): PackedRawTurn[] {
  return turns.map((turn) => ({
    user: (turn.userText ?? "").trim(),
    assistant: (turn.assistantText ?? "").trim(),
    reasoning: (turn.reasoningSummary ?? "").trim(),
    tools: (turn.toolCalls ?? []).flatMap((call) => {
      const name = toolCallName(call);
      if (!name || !isRecord(call)) return [];
      return [{
        name,
        input: clipUnknown(call.input ?? call.arguments ?? call.params, clipChars),
        output: clipUnknown(call.output ?? call.result ?? call.response, clipChars),
        success: call.success !== false && call.error == null
      }];
    })
  }));
}

export function evidenceToolNames(batch: PackedEpisodeEvidence[]): string[] {
  const names = new Set<string>();
  for (const episode of batch) {
    for (const turn of episode.turns) {
      for (const tool of turn.tools) names.add(tool.name);
    }
  }
  return [...names].sort();
}

export function successEvidenceText(batch: PackedEpisodeEvidence[]): string {
  return batch
    .filter((item) => item.outcome === "success")
    .flatMap((item) => item.turns.flatMap(turnText))
    .join("\n");
}

export function failureEvidenceText(batch: PackedEpisodeEvidence[]): string {
  return batch
    .filter((item) => item.outcome === "failure")
    .flatMap((item) => item.turns.flatMap(turnText))
    .join("\n");
}

export function clusterHasUsableSkill(input: {
  skillMemoryId?: string | null;
  layer?: string;
  status?: string;
  archived?: boolean;
}): boolean {
  if (!input.skillMemoryId) return false;
  if (input.archived) return false;
  if (input.layer && input.layer !== "Skill") return false;
  if (input.status === "archived" || input.status === "deleted") return false;
  return true;
}

export function evidenceEpisodeId(item: { episodeId?: string; episode_id?: string }): string | undefined {
  const id = item.episodeId ?? item.episode_id;
  return id ? id : undefined;
}

export function decideEvolveBranch(input: {
  hasSkill: boolean;
  batch: Array<{ outcome: SkillEpisodeOutcome; episodeId?: string; episode_id?: string }>;
  newEpisodeIds: string[];
  existingTools?: string[];
  newSuccessTools?: string[];
}): EvolveBranch {
  const batchSuccess = input.batch.filter((item) => item.outcome === "success");
  const batchFailure = input.batch.filter((item) => item.outcome === "failure");
  if (!input.hasSkill) {
    if (batchSuccess.length === 0) {
      return {
        action: batchFailure.length > 0 ? "skip_no_success_anchor" : "skip_unknown_only",
        reason: batchFailure.length > 0 ? "failure_only_no_skill" : "unknown_only_no_skill"
      };
    }
    return { action: "crystallize", reason: "no_cluster_skill_with_success_anchor" };
  }

  const newSet = new Set(input.newEpisodeIds);
  const newItems = input.batch.filter((item) => {
    const id = evidenceEpisodeId(item);
    return Boolean(id && newSet.has(id));
  });
  const newSuccess = newItems.filter((item) => item.outcome === "success");
  const newFailure = newItems.filter((item) => item.outcome === "failure");
  if (newSuccess.length === 0 && newFailure.length === 0) {
    return { action: "rebuild", rebuildScope: "retrieval", reason: "no_new_success_or_failure" };
  }
  if (newSuccess.length === 0 && newFailure.length > 0) {
    return { action: "rebuild", rebuildScope: "constraints", reason: "new_failures_only" };
  }
  const workflowChanged = isWorkflowChanged(input.existingTools ?? [], input.newSuccessTools ?? []);
  return {
    action: "rebuild",
    rebuildScope: "workflow",
    reason: workflowChanged ? "new_success_changed_workflow" : "new_success"
  };
}

export function isWorkflowChanged(existingTools: string[], newSuccessTools: string[]): boolean {
  if (newSuccessTools.length === 0) return false;
  if (existingTools.length === 0) return newSuccessTools.length > 0;
  const overlap = jaccard(existingTools, newSuccessTools);
  const novel = newSuccessTools.some((tool) => !existingTools.map(normalizeFeature).includes(normalizeFeature(tool)));
  return overlap < 0.75 || novel;
}

export function mergeProcedureByScope(
  existing: DirectSkillProcedureJson,
  draft: DirectSkillProcedureJson,
  scope: DirectSkillRebuildScope
): DirectSkillProcedureJson {
  if (scope === "retrieval") {
    return {
      ...existing,
      retrievalBlurb: draft.retrievalBlurb || existing.retrievalBlurb,
      triggerContext: draft.triggerContext || existing.triggerContext,
      summary: draft.summary || existing.summary
    };
  }
  if (scope === "constraints") {
    return {
      ...existing,
      preconditions: replaceConstraintList(
        existing.preconditions,
        draft.preconditions,
        MAX_DIRECT_SKILL_PRECONDITIONS
      ),
      decisionGuidance: {
        preference: existing.decisionGuidance.preference,
        antiPattern: replaceConstraintList(
          existing.decisionGuidance.antiPattern,
          draft.decisionGuidance.antiPattern,
          MAX_DIRECT_SKILL_ANTI_PATTERN
        )
      }
    };
  }
  return {
    retrievalBlurb: draft.retrievalBlurb || existing.retrievalBlurb,
    triggerContext: draft.triggerContext || existing.triggerContext,
    summary: draft.summary || existing.summary,
    parameters: draft.parameters.length > 0 ? draft.parameters : existing.parameters,
    preconditions: mergeDraftFirst(
      existing.preconditions,
      draft.preconditions,
      MAX_DIRECT_SKILL_PRECONDITIONS
    ),
    steps: draft.steps.length > 0 ? draft.steps : existing.steps,
    examples: draft.examples.length > 0 ? draft.examples : existing.examples,
    decisionGuidance: {
      preference: draft.decisionGuidance.preference.length > 0
        ? draft.decisionGuidance.preference
        : existing.decisionGuidance.preference,
      antiPattern: mergeDraftFirst(
        existing.decisionGuidance.antiPattern,
        draft.decisionGuidance.antiPattern,
        MAX_DIRECT_SKILL_ANTI_PATTERN
      )
    },
    tags: draft.tags.length > 0 ? draft.tags : existing.tags,
    tools: draft.tools.length > 0 ? draft.tools : existing.tools
  };
}

export function coerceDirectSkillProcedure(result: Record<string, unknown>): DirectSkillProcedureJson {
  const guidanceRaw = isRecord(result.decisionGuidance)
    ? result.decisionGuidance
    : isRecord(result.decision_guidance)
      ? result.decision_guidance
      : {};
  return {
    retrievalBlurb: skillText(result.retrieval_blurb ?? result.retrievalBlurb),
    triggerContext: skillText(result.trigger_context ?? result.triggerContext),
    summary: skillText(result.summary),
    parameters: coerceParameters(result.parameters),
    preconditions: stringList(result.preconditions).slice(0, MAX_DIRECT_SKILL_PRECONDITIONS),
    steps: coerceSteps(result.steps),
    examples: coerceExamples(result.examples),
    decisionGuidance: {
      preference: stringList(guidanceRaw.preference).slice(0, 5),
      antiPattern: stringList(guidanceRaw.antiPattern ?? guidanceRaw.anti_pattern).slice(0, MAX_DIRECT_SKILL_ANTI_PATTERN)
    },
    tags: uniqSorted(stringList(result.tags)),
    tools: uniqSorted(stringList(result.tools))
  };
}

export function coerceDirectSkillName(value: unknown, fallback = "skill"): string {
  const normalized = skillText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return SNAKE_NAME_RE.test(normalized) ? normalized : fallback;
}

export function verifyDirectSkillDraft(input: {
  name: string;
  procedure: DirectSkillProcedureJson;
  batch: PackedEpisodeEvidence[];
}): DirectSkillHardGateResult {
  const reasons: string[] = [];
  if (!SNAKE_NAME_RE.test(input.name)) {
    reasons.push("name_not_snake_case");
  }
  const allowedTools = new Set(evidenceToolNames(input.batch).map(normalizeFeature));
  const extraTools = input.procedure.tools.filter((tool) => !allowedTools.has(normalizeFeature(tool)));
  if (extraTools.length > 0) {
    reasons.push(`tools_outside_evidence:${extraTools.join(",")}`);
  }
  const hasSuccess = input.batch.some((item) => item.outcome === "success");
  if (hasSuccess && input.procedure.steps.length === 0) {
    reasons.push("empty_steps_with_success");
  }
  if (hasSuccess && input.procedure.steps.some((step) => isFluffStep(step))) {
    reasons.push("fluff_step");
  }
  if (hasSuccess && !stepsPointAtSuccess(input.procedure.steps, input.batch)) {
    reasons.push("steps_not_grounded_in_success");
  }
  if (failureProcessInSteps(input.procedure.steps, input.batch)) {
    reasons.push("failure_process_in_steps");
  }
  if (!hasSuccess && input.procedure.steps.length > 0) {
    reasons.push("steps_without_success_anchor");
  }
  return { ok: reasons.length === 0, reasons };
}

export const MEMORY_PACKET_SKILL_FULL_MAX_CHARS = 16_384;
const SKILL_GUIDE_TRUNCATION_MARK = "\n...[truncated]";
const SKILL_GUIDE_PREFERRED_SECTIONS = [
  "when to use",
  "procedure",
  "parameters",
  "examples",
  "tools used",
  "decision guidance"
] as const;
const SKILL_GUIDE_DEFERRED_SECTIONS = new Set(["preconditions"]);

export function clipSkillGuide(guide: string, maxChars = MEMORY_PACKET_SKILL_FULL_MAX_CHARS): string {
  const text = guide.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const packed = packSkillGuideSections(text);
  if (packed.length <= maxChars) return packed;
  const budget = Math.max(0, maxChars - SKILL_GUIDE_TRUNCATION_MARK.length);
  return `${packed.slice(0, budget).replace(/\s+$/u, "")}${SKILL_GUIDE_TRUNCATION_MARK}`;
}

function packSkillGuideSections(guide: string): string {
  const chunks = guide.split(/(?=^\*\*[^*]+\*\*)/m);
  const preamble: string[] = [];
  const sections: Array<{ key: string; chunk: string }> = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^\*\*([^*]+)\*\*/);
    if (!match) {
      const trimmed = chunk.trim();
      if (trimmed) preamble.push(trimmed);
      continue;
    }
    sections.push({
      key: (match[1] ?? "").trim().toLowerCase(),
      chunk: chunk.trim()
    });
  }
  const used = new Set<string>();
  const ordered: string[] = [];
  if (preamble.length > 0) ordered.push(preamble.join("\n\n"));
  for (const key of SKILL_GUIDE_PREFERRED_SECTIONS) {
    const found = sections.find((item) => item.key === key);
    if (!found) continue;
    used.add(key);
    ordered.push(found.chunk);
  }
  for (const item of sections) {
    if (used.has(item.key) || SKILL_GUIDE_DEFERRED_SECTIONS.has(item.key)) {
      continue;
    }
    used.add(item.key);
    ordered.push(item.chunk);
  }
  for (const key of SKILL_GUIDE_DEFERRED_SECTIONS) {
    const found = sections.find((item) => item.key === key);
    if (found) ordered.push(found.chunk);
  }
  return ordered.join("\n\n").trim();
}

export function renderDirectSkillGuide(name: string, procedure: DirectSkillProcedureJson): string {
  const lines: string[] = [`# ${name}`, ""];
  if (procedure.retrievalBlurb) lines.push(procedure.retrievalBlurb, "");
  if (procedure.summary) lines.push(procedure.summary, "");
  lines.push("**When to use**", procedure.triggerContext || "(from successful RawTurns)", "");
  if (procedure.steps.length > 0) {
    lines.push("**Procedure**");
    procedure.steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}** - ${step.body}`);
    });
    lines.push("");
  }
  if (procedure.parameters.length > 0) {
    lines.push("**Parameters**");
    for (const item of procedure.parameters) {
      const paramName = skillText(item.name);
      if (!paramName) continue;
      const type = skillText(item.type) || "string";
      const required = item.required === true ? " (required)" : "";
      const description = skillText(item.description);
      lines.push(`- \`${paramName}\`: ${type}${required}${description ? ` - ${description}` : ""}`);
    }
    lines.push("");
  }
  if (procedure.examples.length > 0) {
    lines.push("**Examples**");
    for (const item of procedure.examples) {
      if (!item.input && !item.expected) continue;
      lines.push(`- Input: \`${item.input}\``);
      if (item.expected) lines.push(`  Expected: ${item.expected}`);
    }
    lines.push("");
  }
  if (procedure.tools.length > 0) {
    lines.push("**Tools used**");
    for (const tool of procedure.tools) lines.push(`- \`${tool}\``);
    lines.push("");
  }
  if (procedure.decisionGuidance.preference.length > 0 || procedure.decisionGuidance.antiPattern.length > 0) {
    lines.push("**Decision guidance**");
    if (procedure.decisionGuidance.preference.length > 0) {
      lines.push("Prefer:");
      for (const item of procedure.decisionGuidance.preference) lines.push(`- ${item}`);
    }
    if (procedure.decisionGuidance.antiPattern.length > 0) {
      lines.push("Avoid:");
      for (const item of procedure.decisionGuidance.antiPattern) lines.push(`- ${item}`);
    }
    lines.push("");
  }
  if (procedure.preconditions.length > 0) {
    lines.push("**Preconditions**");
    for (const item of procedure.preconditions) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderDirectSkillCrystallizeSystem(metaSkillMd: string): string {
  return [
    "META-SKILL (optimizer discipline, do not copy into the SOP):",
    metaSkillMd.trim() || SEED_META_SKILL_MD,
    "",
    DIRECT_SKILL_CRYSTALLIZE_EXTRA,
    "",
    SKILL_CRYSTALLIZE_PROMPT.system
  ].join("\n");
}

export function renderDirectSkillRebuildSystem(metaSkillMd: string): string {
  return [
    "META-SKILL (optimizer discipline, do not copy into the SOP):",
    metaSkillMd.trim() || SEED_META_SKILL_MD,
    "",
    DIRECT_SKILL_REBUILD_EXTRA,
    "",
    SKILL_CRYSTALLIZE_PROMPT.system
  ].join("\n");
}

export function procedureJsonFromUnknown(value: unknown): DirectSkillProcedureJson {
  return coerceDirectSkillProcedure(isRecord(value) ? value : {});
}

export function tokenizeSkillText(text: string): Set<string> {
  return new Set((text.toLowerCase().match(TOKEN_RE) ?? []).filter((token) => token.length >= 3));
}

export function isEvalSplitTest(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  const split = skillText(meta.skillEvalSplit ?? meta.evalSplit ?? meta.split).toLowerCase();
  return split === "test" || meta.excludeFromSkillEvolve === true || meta.isTest === true;
}

function isFluffStep(step: { title: string; body: string }): boolean {
  const text = `${step.title} ${step.body}`.replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (FLUFF_STEP_RE.test(text) || FLUFF_STEP_EN_RE.test(text)) return true;
  const stripped = text
    .replace(/仔细|检查|验证|确认|处理|按需|结果|输出|please|carefully|check|verify|validate|handle|process|result|output|needed/gi, "")
    .replace(/[\s./,:;，。、]+/g, "");
  return stripped.length < 6;
}

function stepsPointAtSuccess(
  steps: Array<{ title: string; body: string }>,
  batch: PackedEpisodeEvidence[]
): boolean {
  const successTokens = tokenizeSkillText(successEvidenceText(batch));
  if (successTokens.size === 0) return false;
  return steps.some((step) => {
    const stepTokens = tokenizeSkillText(`${step.title}\n${step.body}`);
    let overlap = 0;
    for (const token of stepTokens) if (successTokens.has(token)) overlap += 1;
    return overlap >= 1;
  });
}

function failureProcessInSteps(
  steps: Array<{ title: string; body: string }>,
  batch: PackedEpisodeEvidence[]
): boolean {
  const successTokens = tokenizeSkillText(successEvidenceText(batch));
  const failureTokens = tokenizeSkillText(failureEvidenceText(batch));
  if (failureTokens.size === 0) return false;
  const failureOnly = new Set<string>();
  for (const token of failureTokens) {
    if (!successTokens.has(token) && token.length >= 5) failureOnly.add(token);
  }
  if (failureOnly.size === 0) return false;
  return steps.some((step) => {
    const stepTokens = tokenizeSkillText(`${step.title}\n${step.body}`);
    let failureHits = 0;
    let successHits = 0;
    for (const token of stepTokens) {
      if (failureOnly.has(token)) failureHits += 1;
      if (successTokens.has(token)) successHits += 1;
    }
    return failureHits >= 2 && failureHits > successHits;
  });
}

function turnText(turn: PackedRawTurn): string[] {
  return [
    turn.user,
    turn.assistant,
    turn.reasoning,
    ...turn.tools.map((tool) => `${tool.name} ${stringifyUnknown(tool.input)} ${stringifyUnknown(tool.output)}`)
  ];
}

function toolCallName(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  const name = call.name ?? call.tool ?? call.toolName ?? call.tool_name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function coerceSteps(value: unknown): Array<{ title: string; body: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const title = skillText(item.title);
    const body = skillText(item.body);
    if (!title && !body) return [];
    return [{ title: title || body.slice(0, 32), body }];
  });
}

function coerceParameters(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = skillText(item.name);
    if (!name) return [];
    const rawType = skillText(item.type).toLowerCase();
    const type = ["string", "number", "boolean", "enum"].includes(rawType) ? rawType : "string";
    const out: Record<string, unknown> = {
      name,
      type,
      required: Boolean(item.required),
      description: skillText(item.description)
    };
    if (type === "enum") out.enumValues = stringList(item.enum);
    return [out];
  });
}

function coerceExamples(value: unknown): Array<{ input: string; expected: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const input = skillText(item.input);
    const expected = skillText(item.expected);
    if (!input && !expected) return [];
    return [{ input, expected }];
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqPreserve(value.map((item) => skillText(item)).filter(Boolean));
}

function capUniqueStrings(values: string[], limit: number): string[] {
  return uniqPreserve(values).slice(0, Math.max(0, limit));
}

function replaceConstraintList(existing: string[], draft: string[], limit: number): string[] {
  return capUniqueStrings(draft.length > 0 ? draft : existing, limit);
}

function mergeDraftFirst(existing: string[], draft: string[], limit: number): string[] {
  return capUniqueStrings([...draft, ...existing], limit);
}

function uniqPreserve(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeFeature(value: string): string {
  return value.trim().toLowerCase();
}

function skillText(value: unknown): string {
  return value == null ? "" : String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

function stringifyUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clipUnknown(value: unknown, clipChars: number): unknown {
  if (typeof value === "string") return value.length > clipChars ? `${value.slice(0, clipChars)}…` : value;
  const text = stringifyUnknown(value);
  if (text.length <= clipChars) return value;
  return `${text.slice(0, clipChars)}…`;
}
