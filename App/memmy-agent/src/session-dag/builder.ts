import { jsonrepair } from "jsonrepair";
import type { Session, SessionManager } from "../core/session/manager.js";
import type { LLMResponse } from "../providers/base.js";
import { truncateText } from "../utils/helpers.js";
import { SessionDagDebugLogger, type SessionDagBuildAuditRecord } from "./debug-log.js";
import { fallbackImportance } from "./importance.js";
import { normalizeDagTaskTransition, validateDagPatch } from "./patch-schema.js";
import { SessionDagStore } from "./store.js";
import type { DagBuilderContext, DagPatch, DagTurn, DagTurnInput } from "./types.js";
import type { SessionDagUsageReporter } from "./usage.js";

export type SessionDagBuilderOptions = {
  sessionKey: string;
  sessions: SessionManager;
  store: SessionDagStore;
  provider: any;
  model: string;
  maxBuilderContextNodes: number;
  usageReporter?: SessionDagUsageReporter | null;
  debugLog?: boolean;
};

type NormalizedTurnMessage = {
  message_index: number;
  role: string;
  content?: string;
  content_summary?: string;
  tool_calls?: Array<{ tool_call_id: string | null; tool_name: string; arguments_summary: string }>;
  tool_call_id?: string | null;
  tool_name?: string;
};

type DagPatchRequest = {
  systemPrompt: string;
  userPayload: Record<string, unknown>;
  chatArgs: Record<string, unknown>;
};

const DAG_PATCH_REASONING_EFFORT = "none";

export class SessionDagBuilder {
  private readonly sessionKey: string;
  private readonly sessions: SessionManager;
  private readonly store: SessionDagStore;
  private readonly provider: any;
  private readonly model: string;
  private readonly maxBuilderContextNodes: number;
  private readonly usageReporter: SessionDagUsageReporter | null;
  private readonly debugLogger: SessionDagDebugLogger;

  constructor(options: SessionDagBuilderOptions) {
    this.sessionKey = options.sessionKey;
    this.sessions = options.sessions;
    this.store = options.store;
    this.provider = options.provider;
    this.model = options.model;
    this.maxBuilderContextNodes = options.maxBuilderContextNodes;
    this.usageReporter = options.usageReporter ?? null;
    this.debugLogger = new SessionDagDebugLogger(options.debugLog ?? false);
  }

  async buildAndApply(turn: DagTurn): Promise<void> {
    const session = this.sessions.loadSession(this.sessionKey);
    if (!session) throw new Error(`session ${this.sessionKey} not found`);
    const turnMessages = this.readTurnMessages(session, turn);
    const dagContext = this.store.readBuilderContext(this.maxBuilderContextNodes);
    const request = this.buildPatchRequest(turn, turnMessages, dagContext);
    const auditRecord: SessionDagBuildAuditRecord = {
      version: 1,
      sessionKey: this.sessionKey,
      turnId: turn.turn_id,
      attempt: Math.max(1, turn.attempt_count + 1),
      messageRange: { start: turn.message_start, end: turn.message_end },
      provider: stringOrNull(this.provider?.spec?.name),
      model: stringOrNull(this.model) ?? stringOrNull(this.provider?.getDefaultModel?.()),
      startedAt: new Date().toISOString(),
      request: {
        systemPrompt: request.systemPrompt,
        userPayload: request.userPayload,
        dagContextNodeCount: dagContext.nodes.length,
        dagContextEdgeCount: dagContext.edges.length,
        turnMessageCount: turnMessages.length,
      },
      error: null,
    };

    try {
      const response = await this.requestPatch(request);
      auditRecord.response = {
        content: response.content,
        finishReason: response.finishReason,
        usage: response.usage,
        reasoning: extractResponseReasoning(response),
      };
      await this.recordUsage(session, turn, response, dagContext);

      let parsed: unknown;
      try {
        parsed = parsePatchJson(response.content);
        auditRecord.parse = {
          ok: true,
          opsCount: countPatchOps(parsed),
          parsedPatch: parsed,
        };
      } catch (error) {
        auditRecord.parse = { ok: false, error: errorMessage(error) };
        auditRecord.validation = { ok: false, error: null };
        auditRecord.apply = { ok: false, error: null };
        auditRecord.error = { stage: "parse", message: errorMessage(error) };
        throw error;
      }

      const contextNodeKinds = Object.fromEntries(dagContext.nodes.map((node) => [node.id, node.kind]));
      let patch: DagPatch;
      try {
        const validatedPatch = validateDagPatch(parsed, { contextNodeKinds });
        patch = normalizeDagTaskTransition(validatedPatch, dagContext);
        auditRecord.validation = { ok: true, parsedPatch: parsed, validatedPatch, normalizedPatch: patch };
      } catch (error) {
        auditRecord.validation = { ok: false, error: errorMessage(error) };
        auditRecord.apply = { ok: false, error: null };
        auditRecord.error = { stage: "validation", message: errorMessage(error) };
        throw error;
      }

      try {
        const result = this.store.applyPatch({
          turn: turnToInput(turn),
          patch,
          buildMode: "llm_patch",
          writeSource: "llm_patch",
        });
        auditRecord.apply = { ok: true, nodeIds: result.nodeIds, edgeIds: result.edgeIds };
      } catch (error) {
        auditRecord.apply = { ok: false, error: errorMessage(error) };
        auditRecord.error = { stage: "apply", message: errorMessage(error) };
        throw error;
      }
    } catch (error) {
      if (!auditRecord.error) {
        auditRecord.error = { stage: "request", message: errorMessage(error) };
      }
      throw error;
    } finally {
      auditRecord.finishedAt = new Date().toISOString();
      try {
        await this.debugLogger.writeAttempt(auditRecord);
      } catch (error) {
        console.warn("[session-dag] failed to write builder debug log", error);
      }
    }
  }

  applyDeterministicFallback(turn: DagTurn): void {
    const graph = this.store.readGraphForHistoryDag();
    const existingTask = graph.nodes
      .filter((node) => node.kind === "task" && node.status !== "frozen")
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    const activeSubtask = graph.nodes
      .filter((node) => node.kind === "subtask" && (node.status === "active" || node.status === "blocked"))
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    const status = fallbackStatus(turn);
    const subtaskTempId = "fallback_subtask";
    const ops: DagPatch["ops"] = [];
    const taskRef = existingTask?.id ?? "fallback_task";
    if (!existingTask) {
      ops.push({
        op: "add_node",
        temp_id: "fallback_task",
        kind: "task",
        status: status === "blocked" ? "blocked" : "active",
        title: fallbackTitle(turn.user_text || turn.assistant_text || "当前任务"),
        summary: fallbackSummary(turn.user_text || turn.assistant_text || "兜底创建的会话任务"),
        importance: fallbackImportance("task", "active"),
        detail_json: {},
        source_refs: [],
      });
    }
    ops.push({
      op: "add_node",
      temp_id: subtaskTempId,
      kind: "subtask",
      status,
      title: fallbackTitle(turn.user_text || turn.assistant_text || "本轮交互"),
      summary: fallbackSummary(turn.user_text || turn.assistant_text || "本轮由 deterministic fallback 生成最小子任务节点"),
      importance: fallbackImportance("subtask", status),
      detail_json: { result: truncateText(turn.assistant_text || turn.user_text || "", 500) },
      source_refs: [],
    });
    if (activeSubtask) {
      ops.push({ op: "add_edge", source_id: activeSubtask.id, target_id: subtaskTempId, type: "continues" });
    } else {
      ops.push({ op: "add_edge", source_id: taskRef, target_id: subtaskTempId, type: "decomposes" });
    }
    this.store.applyPatch({
      turn: turnToInput(turn),
      patch: { ops },
      buildMode: "deterministic_fallback",
      writeSource: "deterministic_fallback",
    });
  }

  private readTurnMessages(session: Session, turn: DagTurn): NormalizedTurnMessage[] {
    const start = Math.max(0, turn.message_start);
    const end = Math.min(session.messages.length, turn.message_end);
    if (end <= start) throw new Error("DAG turn range is outside session messages");
    return session.messages.slice(start, end).map((message, offset) => normalizeTurnMessage(message, start + offset));
  }

  private buildPatchRequest(turn: DagTurn, messages: NormalizedTurnMessage[], dagContext: DagBuilderContext): DagPatchRequest {
    const payload: Record<string, unknown> = {
      turn_messages: {
        turn_id: turn.turn_id,
        message_start: turn.message_start,
        message_end: turn.message_end,
        messages,
      },
      dag_context: dagContext,
    };
    if (turn.last_error) {
      payload.previous_patch_error = {
        attempt_count: turn.attempt_count,
        message: truncateText(turn.last_error, 1000),
        instruction:
          "Fix the next patch against the CURRENT schema. First read previous_patch_error.message as the exact validation error from the last attempt. Then rewrite the full patch so every new node uses temp_id n0, n1, n2 in add_node order, all add_edge source_id/target_id references match those temp ids, and update_node.node_id uses only ids copied from dag_context.nodes. Preserve or add required add_edge ops. Do not fix a malformed patch by dropping edges for newly added subtask or decision nodes. For a task transition error, keep at most one new task and fix both the old root terminal status and its direct continues/supersedes edge to the new task; do not evade the error by dropping the new task or transition.",
        current_temp_id_rule:
          "For this attempt, new add_node temp_id values must be exactly n0, n1, n2 in add_node order. Rewrite all temp ids and matching add_edge source_id/target_id references to this format.",
      };
    }
    return {
      systemPrompt: DAG_BUILDER_SYSTEM_PROMPT,
      userPayload: payload,
      chatArgs: {
        model: this.model,
        messages: [
          { role: "system", content: DAG_BUILDER_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(payload, null, 2),
          },
        ],
        tools: null,
        tool_choice: null,
        toolChoice: null,
        reasoningEffort: DAG_PATCH_REASONING_EFFORT,
      },
    };
  }

  private async requestPatch(request: DagPatchRequest): Promise<LLMResponse> {
    const chat = this.provider?.chatWithRetry;
    if (typeof chat !== "function") throw new Error("provider does not implement chatWithRetry");
    return chat.call(this.provider, request.chatArgs);
  }

  private async recordUsage(session: Session, turn: DagTurn, response: LLMResponse, dagContext: DagBuilderContext): Promise<void> {
    if (!this.usageReporter) return;
    try {
      await this.usageReporter.recordBuilderUsage({
        usage: response.usage,
        session,
        sessionKey: this.sessionKey,
        turnId: turn.turn_id,
        attempt: Math.max(1, turn.attempt_count + 1),
        messageStart: turn.message_start,
        messageEnd: turn.message_end,
        contextNodeCount: dagContext.nodes.length,
        contextEdgeCount: dagContext.edges.length,
        provider: stringOrNull(this.provider?.spec?.name),
        modelId: stringOrNull(this.model) ?? stringOrNull(this.provider?.getDefaultModel?.()),
      });
    } catch (error) {
      console.warn("Session DAG usage recording failed:", error);
    }
  }
}

function parsePatchJson(content: unknown): unknown {
  if (typeof content !== "string") throw new Error("DAG builder returned non-string content");
  const trimmed = stripMarkdownFence(content.trim());
  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(jsonrepair(trimmed));
  }
}

function countPatchOps(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const ops = (value as { ops?: unknown }).ops;
  return Array.isArray(ops) ? ops.length : 0;
}

function extractResponseReasoning(
  response: LLMResponse,
): { reasoningContent?: string | null; thinkingBlocks?: Record<string, any>[] | null } | null {
  if (response.reasoningContent == null && response.thinkingBlocks == null) return null;
  const reasoning: { reasoningContent?: string | null; thinkingBlocks?: Record<string, any>[] | null } = {};
  if (response.reasoningContent != null) reasoning.reasoningContent = response.reasoningContent;
  if (response.thinkingBlocks != null) reasoning.thinkingBlocks = response.thinkingBlocks;
  return reasoning;
}

function stripMarkdownFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function normalizeTurnMessage(message: Record<string, any>, index: number): NormalizedTurnMessage {
  const role = String(message.role ?? "unknown");
  if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return {
      message_index: index,
      role,
      content: textContent(message.content),
      tool_calls: message.tool_calls.map((call: any) => ({
        tool_call_id: stringOrNull(call?.id),
        tool_name: String(call?.function?.name ?? call?.name ?? "tool"),
        arguments_summary: truncateText(String(call?.function?.arguments ?? call?.arguments ?? ""), 800),
      })),
    };
  }
  if (role === "tool") {
    return {
      message_index: index,
      role,
      tool_call_id: stringOrNull(message.tool_call_id),
      tool_name: String(message.name ?? "tool"),
      content_summary: truncateText(textContent(message.content), 1000),
    };
  }
  return {
    message_index: index,
    role,
    content: truncateText(textContent(message.content), role === "user" || role === "assistant" ? 2000 : 1000),
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as any).type === "text") return String((block as any).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function turnToInput(turn: DagTurn): DagTurnInput {
  return {
    turn_id: turn.turn_id,
    message_start: turn.message_start,
    message_end: turn.message_end,
    user_text: turn.user_text,
    assistant_text: turn.assistant_text,
  };
}

function fallbackStatus(turn: DagTurn): "active" | "done" | "failed" | "blocked" {
  const text = `${turn.user_text}\n${turn.assistant_text}`.toLowerCase();
  if (/阻塞|blocked|需要用户输入/.test(text)) return "blocked";
  if (/失败|报错|\berror\b|\bfailed\b/.test(text)) return "failed";
  if (/已完成|完成了|\bdone\b|\bfixed\b/.test(text)) return "done";
  return "active";
}

function fallbackTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "本轮交互";
  return truncateText(normalized, 40);
}

function fallbackSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return truncateText(normalized || "deterministic fallback 创建的最小 DAG 节点", 500);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DAG_BUILDER_SYSTEM_PROMPT = `You produce a patch for a session-local task-state DAG from one completed agent turn.

Return strict JSON only. No markdown. No comments.
The top-level object must be exactly:
{"ops":[...]}

If this turn has no durable task state, return {"ops":[]}.
Usually this means all are true: no tool call, unrelated to the current DAG task, and only meaningless small talk.
If the turn answers a factual question, changes the task direction, records a decision, reports a result, or uses tools, it normally has durable task state.
If this turn has durable task state and dag_context.root_task_id is null, the first meaningful op must add a task node.

Allowed output operations and fields:

1. add_node
add_node required fields:
- op: "add_node"
- temp_id: temporary id for a new node. Use exactly "n0", "n1", "n2" in add_node order inside this patch.
- kind: "task" | "subtask" | "decision"
- status: "active" | "done" | "failed" | "blocked" | "frozen"
  For add_node with kind="task", status must be "active" or "blocked".
  Do not mark a newly added task done/failed/frozen in the same patch.
- title: non-empty short string
- summary: non-empty one-sentence string
- importance: integer 0..100
add_node optional fields:
- detail_json

2. update_node
update_node required fields:
- op: "update_node"
- node_id: existing node id copied from dag_context.nodes only. n0/n1/n2 are invalid here.
update_node optional fields:
- title
- summary
- status
- importance
- detail_json
- source_refs
summary must preserve the useful answer or conclusion when the turn contains one.
For question-answer turns, include the answer in summary, not only "answered the question".
update_node is a partial update. Omitted fields keep their current values.
Do not output kind, id, session_key, created_turn_id, updated_turn_id, first_message_index, last_message_index, created_by, updated_by, created_at, or updated_at.

3. add_edge
add_edge required fields:
- op: "add_edge"
- source_id: existing node id from dag_context.nodes, or n0/n1/n2 created earlier by add_node in this patch
- target_id: existing node id from dag_context.nodes, or n0/n1/n2 created earlier by add_node in this patch
- type: "decomposes" | "continues" | "blocks" | "supersedes"

Node kind meanings:
- task: a higher-level user task or task phase in this session. A session can have multiple tasks over time.
- subtask: a concrete execution step, investigation route, or tool phase under a task.
- decision: a confirmed judgment, conclusion, tradeoff, or answer that affects later work.
Create or update nodes only for durable task state.

Edge type meanings:
- decomposes: task -> subtask, when a higher-level task is broken into a concrete execution step.
- continues: done/failed task -> next task, or subtask/decision -> subtask/decision when the main line continues in time or logic.
- blocks: subtask/decision -> subtask, when a failure, blocker, or decision prevents a downstream subtask.
- supersedes: frozen task -> replacement task, or frozen subtask/decision -> replacement subtask/decision when a new node replaces an old route or conclusion.

Task operation rules:
- In one patch, the same task may be either added or updated, never both.
- If dag_context.root_task_id is null and this turn has durable task state, add exactly one task as the first meaningful op. Its status must be active or blocked. Do not update that new task in the same patch.
- If dag_context.root_task_id is not null, first decide whether the existing task is still the current task phase.
- Adding a task while dag_context.root_task_id exists is a task switch. Emit at most one new task in a patch.
- Keep the existing task when the turn stays within the same topic.
- If the existing task is still current, do not add or update any task. Add or update only subtask/decision nodes under it.
- If this turn clearly completes, closes, or replaces the existing task, update that existing task to done or frozen, then add a new task for the new task phase. The old root must connect directly to the new task with continues or supersedes in the same patch.
- For one-turn question-answer turns, keep the task active and store the completed answer/result in a done subtask or decision under that task.
- Do not add final, closure, or finish nodes.

Semantic rules:
- dag_context.active_path and dag_context.active_path_edges are one server-derived ordered path for the current task. Preserve that task boundary when updating or extending the graph.
- active_path_edges contains the exact persisted edges between adjacent active_path nodes; use it to understand whether the current path decomposes, continues, blocks, or supersedes.
- When no active/blocked child exists, active_path may end at the latest completed subtask/decision. That endpoint is historical progress, not an instruction to treat a done node as active.
- Nodes are coarse durable task-state units, not individual messages; do not create one node for every message.
- Temporary ids are patch-local: use n0/n1/n2 only for add_node.temp_id and add_edge source_id/target_id in the same patch. The program replaces them with persisted node ids after validation.
- Do not create orphan subtask or decision nodes.
- Every new subtask or decision must be connected by add_edge so it is reachable from a task root.
- Continue the same topic by updating the active/blocked subtask, or by adding the next subtask with a continues edge.
- If a new node replaces an old node, update the old node to status="frozen" and add a supersedes edge with source_id set to the old node id and target_id set to the new node id.

Subtask granularity rules:
- A subtask represents one concrete execution/tool phase under the current task, not one message or turn.
- Consecutive work using the same main tool for the same purpose should update the same active/blocked subtask, or close that subtask as done when the result is reported.
- If a subtask encounters tool-call errors or trial-and-error during execution, record them in detail_json.errors even if the subtask later succeeds.
- Work using a different main tool, using the same main tool for a clearly different goal, or moving into a different execution phase normally creates a different subtask connected with continues.
- If a subtask fails and work switches to a different method, mark the old subtask as failed, create a new subtask for the new method, and connect them with a continues edge.
- If one turn uses multiple distinct tools, create separate subtasks only for tools that contribute durable task state. Auxiliary tools that only support the same result can be summarized in the dominant subtask detail_json.
- No-tool factual answers should usually be decision nodes when the answer affects later work; otherwise use {"ops":[]}.

importance rules:
- add_node must include importance, integer 0..100.
- Higher means more worth remembering.
- 90-100: main task, critical blocker, or direction-changing decision.
- 75-89: active subtask, important decision, or subtask with key evidence.
- 55-74: useful completed subtask, or failed/frozen route worth avoiding.
- 30-54: minor supporting detail.
- 0-29: normally omit; use only for weak audit traces.
- Do not lower importance only because the chat continues later.

detail_json allowed keys:
- task: scope, acceptance, constraints, result
- subtask: tool, commands, tests, errors, result
- decision: basis, alternatives, supersedes

source_refs rules:
- Use source_refs only for external file, artifact, or url evidence.
- Do not cite transcript messages, tool calls, or tool results.
- Do not add source_refs to task nodes.
- Attach source_refs to the subtask or decision that uses the evidence.
- Omit source_refs when there is no external file, artifact, or url evidence.

source_refs allowed shapes:
- {"type":"file","title":"...","path":"...","line":1}
- {"type":"artifact","title":"...","artifact_path":"..."}
- {"type":"url","title":"...","url":"..."}`;
