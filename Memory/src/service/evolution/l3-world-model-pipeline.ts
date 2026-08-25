import {
  assertJsonValue,
  canonicalJson,
  sha256Hex,
  type JsonValue
} from "@memmy/local-api-contracts";
import type { LlmClient } from "../../model/types.js";
import type {
  EvolutionJobRecord,
  FeedbackRecord,
  L3WorldModelTargetField,
  RawTurnRecord,
  Repositories
} from "../../storage/repositories.js";
import { logEvolutionDecision } from "./evolution-logging.js";
import { completeStrictJson } from "../l3-world-model/strict-json-completion.js";

type FieldUpdateOperation = "noop" | "create" | "update";

interface FieldUpdateOutput {
  op: FieldUpdateOperation;
  value: string;
}

interface TraceEvidence {
  rawTurns: JsonValue[];
  eligibleL1MemoryIds: string[];
}

export class L3WorldModelTerminalEvidenceError extends Error {
  readonly terminal = true;
}

export function isTerminalL3WorldModelError(error: unknown): boolean {
  return error instanceof L3WorldModelTerminalEvidenceError;
}

export class L3WorldModelTraceFieldPipeline {
  constructor(private readonly deps: { repos: Repositories; skillLlm: LlmClient }) {}

  async updateField(job: EvolutionJobRecord): Promise<void> {
    const payload = strictJobPayload(job);
    const batch = this.deps.repos.l3WorldModels.getBatch(payload.batchId);
    if (!batch) throw new L3WorldModelTerminalEvidenceError(`missing batch: ${payload.batchId}`);
    const target = this.deps.repos.l3WorldModels.getTarget(payload.batchId, payload.targetField);
    if (!target) {
      throw new L3WorldModelTerminalEvidenceError(
        `missing target: ${payload.batchId}:${payload.targetField}`
      );
    }
    if (target.status === "applied") return;
    if (target.status === "dead_letter") {
      throw new L3WorldModelTerminalEvidenceError(
        `target is already dead letter: ${payload.batchId}:${payload.targetField}`
      );
    }
    if (
      job.jobType !== "l3_world_model_update" ||
      job.userId !== batch.userId ||
      job.sessionId !== batch.sessionId ||
      job.scopeKey !== target.fieldScopeKey ||
      job.scopeSeq !== target.scopeSeq ||
      target.scopeSeq !== batch.scopeSeq
    ) {
      throw new L3WorldModelTerminalEvidenceError("L3 World Model job ownership mismatch");
    }
    if (sha256Hex(canonicalJson(batchPayloadForHash(batch))) !== batch.payloadHash) {
      throw new L3WorldModelTerminalEvidenceError("L3 World Model batch payload hash mismatch");
    }

    const fields = this.deps.repos.l3WorldModels.fields(batch.userId, batch.projectId);
    const currentField = fieldValue(fields, payload.targetField) ?? "";
    const profile = fields.projectEnvironmentProfile ?? "";
    const expectedFieldHash = sha256Hex(currentField);
    const expectedProfileHash = payload.targetField === "general_rules_and_safety_constraints"
      ? undefined
      : sha256Hex(profile);
    const evidence = this.loadEvidence(payload.batchId);
    if (evidence.rawTurns.length === 0) {
      logEvolutionDecision(job, "l3_world_model_update", "no_usable_raw_turns", {
        targetField: payload.targetField,
        batchId: payload.batchId
      });
      this.deps.repos.l3WorldModels.applyTraceTarget({
        batchId: payload.batchId,
        targetField: payload.targetField,
        operation: "noop",
        value: "",
        expectedFieldHash,
        expectedProfileHash,
        eligibleL1MemoryIds: evidence.eligibleL1MemoryIds
      });
      return;
    }

    const prompt = promptForField(payload.targetField);
    const dynamicInput = dynamicInputForField(
      payload.targetField,
      currentField,
      profile,
      evidence.rawTurns
    );
    const output = await completeStrictJson({
      llm: this.deps.skillLlm,
      operation: `l3_world_model.${payload.targetField}`,
      systemPrompt: prompt,
      dynamicInput,
      expectedSchema: expectedSchemaForField(payload.targetField),
      validate: (value) => validateFieldOutput(value, payload.targetField, currentField)
    });
    this.deps.repos.l3WorldModels.applyTraceTarget({
      batchId: payload.batchId,
      targetField: payload.targetField,
      operation: output.op,
      value: output.value,
      expectedFieldHash,
      expectedProfileHash,
      eligibleL1MemoryIds: evidence.eligibleL1MemoryIds
    });
  }

  private loadEvidence(batchId: string): TraceEvidence {
    const batch = this.deps.repos.l3WorldModels.getBatch(batchId);
    if (!batch) throw new L3WorldModelTerminalEvidenceError(`missing batch: ${batchId}`);
    const session = this.deps.repos.runtime.getSession(batch.sessionId);
    if (!session || session.userId !== batch.userId || (session.projectId ?? null) !== (batch.projectId ?? null)) {
      throw new L3WorldModelTerminalEvidenceError("L3 World Model batch session scope mismatch");
    }
    const traces = this.deps.repos.l3WorldModels.listBatchTraces(batchId);
    if (
      canonicalJson(traces.map((trace) => trace.l1MemoryId)) !== canonicalJson(batch.l1MemoryIds) ||
      canonicalJson([...new Set(traces.map((trace) => trace.rawTurnId))]) !== canonicalJson(batch.rawTurnIds)
    ) {
      throw new L3WorldModelTerminalEvidenceError("L3 World Model batch trace lineage mismatch");
    }

    const traceByRawTurn = new Map(traces.map((trace) => [trace.rawTurnId, trace]));
    const traceByL1 = new Map(traces.map((trace) => [trace.l1MemoryId, trace]));
    const feedbackByRawTurn = new Map<string, FeedbackRecord[]>();
    for (const feedbackId of batch.feedbackIds) {
      const feedback = this.deps.repos.runtime.getFeedback(feedbackId);
      if (!feedback) continue;
      const trace = feedback.rawTurnId
        ? traceByRawTurn.get(feedback.rawTurnId)
        : feedback.l1MemoryId
          ? traceByL1.get(feedback.l1MemoryId)
          : undefined;
      if (
        !trace ||
        feedback.userId !== batch.userId ||
        feedback.sessionId !== batch.sessionId ||
        (feedback.projectId ?? null) !== (batch.projectId ?? null)
      ) {
        throw new L3WorldModelTerminalEvidenceError(`feedback scope mismatch: ${feedback.id}`);
      }
      const values = feedbackByRawTurn.get(trace.rawTurnId) ?? [];
      values.push(feedback);
      feedbackByRawTurn.set(trace.rawTurnId, values);
    }

    const rawTurns: JsonValue[] = [];
    const usableRawTurnIds = new Set<string>();
    for (const rawTurnId of batch.rawTurnIds) {
      const rawTurn = this.deps.repos.runtime.getRawTurn(rawTurnId);
      if (!rawTurn) continue;
      assertRawTurnScope(rawTurn, batch.userId, batch.sessionId);
      if (rawTurn.deletedAt || rawTurn.redactedAt) continue;
      usableRawTurnIds.add(rawTurn.id);
      rawTurns.push(rawTurnEvidence(rawTurn, feedbackByRawTurn.get(rawTurn.id) ?? []));
    }

    const eligibleL1MemoryIds: string[] = [];
    for (const trace of traces) {
      const memory = this.deps.repos.memories.get(trace.l1MemoryId);
      if (!memory) continue;
      if (memory.userId !== batch.userId || memory.sessionId !== batch.sessionId) {
        throw new L3WorldModelTerminalEvidenceError(`L1 scope mismatch: ${memory.id}`);
      }
      if (!memory.deletedAt && memory.status !== "deleted" && usableRawTurnIds.has(trace.rawTurnId)) {
        eligibleL1MemoryIds.push(memory.id);
      }
    }
    return { rawTurns, eligibleL1MemoryIds };
  }
}

function strictJobPayload(job: EvolutionJobRecord): {
  batchId: string;
  targetField: L3WorldModelTargetField;
} {
  const keys = Object.keys(job.payload).sort();
  if (keys.join(",") !== "batchId,targetField") {
    throw new L3WorldModelTerminalEvidenceError("invalid L3 World Model job payload keys");
  }
  const batchId = job.payload.batchId;
  const targetField = job.payload.targetField;
  if (typeof batchId !== "string" || !isTargetField(targetField)) {
    throw new L3WorldModelTerminalEvidenceError("invalid L3 World Model job payload");
  }
  return { batchId, targetField };
}

function batchPayloadForHash(batch: NonNullable<ReturnType<Repositories["l3WorldModels"]["getBatch"]>>): JsonValue {
  return {
    scopeKey: batch.scopeKey,
    scopeSeq: batch.scopeSeq,
    userId: batch.userId,
    projectId: batch.projectId ?? null,
    sessionId: batch.sessionId,
    trigger: batch.trigger,
    startTraceSeq: batch.startTraceSeq,
    endTraceSeq: batch.endTraceSeq,
    l1MemoryIds: batch.l1MemoryIds,
    rawTurnIds: batch.rawTurnIds,
    feedbackIds: batch.feedbackIds
  };
}

function rawTurnEvidence(rawTurn: RawTurnRecord, feedback: FeedbackRecord[]): JsonValue {
  return {
    raw_turn_id: rawTurn.id,
    status: rawTurn.status,
    user_text: rawTurn.userText ?? null,
    assistant_text: rawTurn.assistantText ?? null,
    tool_calls: assertJsonArray(rawTurn.toolCalls, `RawTurn ${rawTurn.id} tool_calls`)
      .map(stripToolCallThinking),
    tool_results: assertJsonArray(rawTurn.toolResults, `RawTurn ${rawTurn.id} tool_results`),
    feedback: feedback.map((item) => ({
      channel: item.channel,
      polarity: item.polarity,
      magnitude: item.magnitude,
      rationale: item.rationale ?? null
    }))
  };
}

function stripToolCallThinking(toolCall: JsonValue): JsonValue {
  if (toolCall === null || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return toolCall;
  }
  return Object.fromEntries(
    Object.entries(toolCall).filter(([key]) => key !== "thinkingBefore" && key !== "thinking_before")
  );
}

function assertJsonArray(value: unknown[], label: string): JsonValue[] {
  try {
    const validated = assertJsonValue(value);
    if (!Array.isArray(validated)) throw new TypeError(`${label} must be an array`);
    return validated;
  } catch (error) {
    throw new L3WorldModelTerminalEvidenceError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertRawTurnScope(rawTurn: RawTurnRecord, userId: string, sessionId: string): void {
  if (rawTurn.userId !== userId || rawTurn.sessionId !== sessionId) {
    throw new L3WorldModelTerminalEvidenceError(`RawTurn scope mismatch: ${rawTurn.id}`);
  }
}

function dynamicInputForField(
  field: L3WorldModelTargetField,
  currentField: string,
  projectEnvironmentProfile: string,
  rawTurns: JsonValue[]
): JsonValue {
  if (field === "general_rules_and_safety_constraints") {
    return { current_field: currentField, raw_turns: rawTurns };
  }
  return {
    current_field: currentField,
    project_environment_profile: projectEnvironmentProfile,
    raw_turns: rawTurns
  };
}

function expectedSchemaForField(field: L3WorldModelTargetField): JsonValue {
  if (field === "project_contract") {
    return {
      reason: "brief decision reason string",
      op: "noop | create | update",
      project_contract: "complete final content string"
    };
  }
  return {
    op: "noop | create | update",
    [field]: "complete final content string"
  };
}

function validateFieldOutput(
  value: unknown,
  field: L3WorldModelTargetField,
  currentField: string
): FieldUpdateOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("output must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = field === "project_contract"
    ? ["op", "project_contract", "reason"]
    : ["op", field];
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new TypeError(`output must contain exactly ${expectedKeys.join(", ")}`);
  }
  if (
    field === "project_contract" &&
    (typeof record.reason !== "string" || !record.reason.trim())
  ) {
    throw new TypeError("project contract reason must be a non-empty string");
  }
  if (record.op !== "noop" && record.op !== "create" && record.op !== "update") {
    throw new TypeError("op must be noop, create, or update");
  }
  const content = record[field];
  if (typeof content !== "string") throw new TypeError(`${field} must be a string`);
  if (record.op === "noop" && content !== "") {
    throw new TypeError("noop must return an empty content field");
  }
  if (record.op === "create" && (currentField !== "" || !content.trim())) {
    throw new TypeError("create requires an empty current field and non-empty final content");
  }
  if (record.op === "update" && (currentField === "" || content === currentField)) {
    throw new TypeError("update requires a non-empty current field and changed final content");
  }
  return { op: record.op, value: content };
}

function fieldValue(
  fields: ReturnType<Repositories["l3WorldModels"]["fields"]>,
  field: L3WorldModelTargetField
): string | null {
  if (field === "general_rules_and_safety_constraints") return fields.generalRulesAndSafetyConstraints;
  if (field === "project_contract") return fields.projectContract;
  return fields.domainKnowledge;
}

function isTargetField(value: unknown): value is L3WorldModelTargetField {
  return value === "general_rules_and_safety_constraints" ||
    value === "project_contract" ||
    value === "domain_knowledge";
}

function promptForField(field: L3WorldModelTargetField): string {
  if (field === "general_rules_and_safety_constraints") return GENERAL_RULES_PROMPT;
  if (field === "project_contract") return PROJECT_CONTRACT_PROMPT;
  return DOMAIN_KNOWLEDGE_PROMPT;
}

const SHARED_OPERATION_RULES = `Choose exactly one operation:
- "create": the current field is empty and the evidence produces non-empty content;
- "update": the current field is non-empty and the complete final content differs from it; use an empty final content only when newer evidence explicitly removes or supersedes every existing item;
- "noop": the final content would not change.

For "noop", return an empty content field and do not repeat the current field. For "create" and "update", return the complete merged final content, not a delta. An empty content field with "update" means clear the existing field; an empty content field with "noop" means leave it unchanged.
Write the content in the language of the current field. If the current field is empty, use the dominant language of the user requests in the RawTurns. Do not translate the content merely because this instruction is written in English.`;

const GENERAL_RULES_PROMPT = `You maintain "General Rules and Safety Constraints".
The input contains the complete current field and a chronological batch of new RawTurns.

Keep only:
1. operational rules explicitly stated by the user that remain reusable across no-project tasks;
2. general safety guardrails supported by actual tool errors, risky outcomes, or user corrections.

Remove or ignore:
- project-, file-, repository-, customer-, or one-off-task-specific information;
- steps or recommendations for solving a particular task;
- unsupported Agent preferences or guesses;
- old rules explicitly superseded by newer user requirements.

Merge equivalent items and remove superseded items. Sort explicit user rules and high-risk guardrails before weaker or lower-frequency items.

${SHARED_OPERATION_RULES}
Return exactly one valid JSON object with the required keys. Do not include Markdown or explanatory text.

Return exactly one of:
{"op":"noop","general_rules_and_safety_constraints":""}
{"op":"create","general_rules_and_safety_constraints":"complete final content"}
{"op":"update","general_rules_and_safety_constraints":"complete final content"}`;

const PROJECT_CONTRACT_PROMPT = `You maintain only the "Project Contract".
The input contains the current Project Contract, a read-only current Project Environment Profile, and a chronological batch of new RawTurns.

Keep only:
- project-scoped development or work rules explicitly stated by the user that can reasonably guide future tasks in the same project;
- project-scoped collaboration and delivery conventions, including reusable requirements for how the Agent explains, summarizes, formats, reviews, documents, or presents work;
- explicit user requirements or corrections that establish or refine such a rule, whether stated before or after an implementation;
- reusable project guardrails revealed by user acceptance or rejection;
- constraints explicitly enforced by CI, Hooks, or quality gates.

An explicit rule may be retained after a single statement. Do not require repetition, a previous violation, acceptance or rejection evidence, or persistent words such as "in the future", "always", or "must". Determine durability from meaning: if the requirement governs a category of project operations or can reasonably apply to later tasks in this project, treat it as a project rule.
Every RawTurn in this input already belongs to the current project Session. Treat any reusable or durable user requirement in these RawTurns as scoped to the current project by default; do not require the user to repeat the project name. Only exclude it from the Project Contract when the user explicitly limits it to the current task. A rule may still be retained in this Project Contract when it also applies beyond this project. Phrases such as "以后", "后续", "以后也是", "from now on", or "always" are direct durability evidence and must not be classified as current-task-only merely because they appear inside a request for the current deliverable.
Treat a reusable instruction about response structure or presentation as a project rule rather than a current-task detail. For example, "when a table can explain the result clearly, use a table" belongs in the Project Contract when it applies to work in this project.
Exclude only requirements whose substance is tied exclusively to the current task deliverable and cannot reasonably apply to future project tasks. Do not exclude a reusable rule merely because it was first expressed while discussing the current task.
Do not include ordinary tool errors, environment facts, implementation steps, or temporary Agent choices.

Use the Project Environment Profile only to understand the project type and environment. Do not modify or output it. Merge equivalent items and replace old contract content only when new evidence explicitly supersedes it. Sort by constraint strength and evidence strength.

${SHARED_OPERATION_RULES}
Before choosing the operation, provide a brief, concrete "reason" explaining whether the new RawTurns create, change, remove, or leave unchanged a reusable Project Contract rule. The reason is required to improve the decision, but it is not part of the Project Contract and will not be stored. Keep it concise and use the same language as the resulting Project Contract content, or the dominant user language when the content is empty.
Return exactly one valid JSON object with the required keys. Do not include Markdown or explanatory text.

Return exactly one of:
{"reason":"brief reason why the contract is unchanged","op":"noop","project_contract":""}
{"reason":"brief reason why a reusable rule is created","op":"create","project_contract":"complete final content"}
{"reason":"brief reason why the contract is updated","op":"update","project_contract":"complete final content"}`;

const DOMAIN_KNOWLEDGE_PROMPT = `You maintain only "Domain Knowledge".
The input contains the current Domain Knowledge, a read-only current Project Environment Profile, and a chronological batch of new RawTurns.

Keep only facts learned from error experience: a failed tool/result, an unsuccessful attempt followed by a retry outcome, or an explicit user correction. Express each fact as:
"environment condition -> observable result".
For code projects, focus on coding environments. For ordinary folders, focus on office software, file formats, and work environments.

Do not create Domain Knowledge from a successful result alone. Do not include recommended actions, prohibitions, procedures, policies, ordinary source-code content, Commit/Diff content itself, or Agent guesses.

Replace an old fact when new evidence from the same environment disproves it. Do not merge facts from incompatible environment versions or configurations. Use the Project Environment Profile only to understand the environment; do not modify or output it. Sort by evidence strength.

${SHARED_OPERATION_RULES}
Return exactly one valid JSON object with the required keys. Do not include Markdown or explanatory text.

Return exactly one of:
{"op":"noop","domain_knowledge":""}
{"op":"create","domain_knowledge":"complete final content"}
{"op":"update","domain_knowledge":"complete final content"}`;
