import type {
  FeedbackRequest,
  TurnCompleteRequest
} from "../types.js";

export interface OpenMemCloudClientOptions {
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: OpenMemFetch;
}

export type OpenMemFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenMemToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenMemMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<Record<string, unknown>>;
  chat_time?: string;
  tool_call_id?: string;
  tool_calls?: OpenMemToolCall[];
}

export interface OpenMemAddMessageRequest {
  user_id: string;
  conversation_id: string;
  messages: OpenMemMessage[];
  agent_id?: string;
  app_id?: string;
  tags?: string[];
  info?: Record<string, unknown>;
  allow_public?: boolean;
  allow_knowledgebase_ids?: string[];
  async_mode?: boolean;
  [key: string]: unknown;
}

export interface OpenMemAddFeedbackRequest {
  user_id: string;
  conversation_id?: string;
  feedback_content: string;
  agent_id?: string;
  app_id?: string;
  feedback_time?: string;
  allow_public?: boolean;
  allow_knowledgebase_ids?: string[];
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

export class OpenMemCloudClient {
  private readonly endpoint: string;
  private readonly fetchImpl: OpenMemFetch;
  private readonly headers: Record<string, string>;

  constructor(private readonly options: OpenMemCloudClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  addMessage(request: OpenMemAddMessageRequest): Promise<unknown> {
    return this.post("/add/message", request);
  }

  addFeedback(request: OpenMemAddFeedbackRequest): Promise<unknown> {
    return this.post("/add/feedback", request);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: "POST",
      headers: {
        ...this.headers,
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Token ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      throw new OpenMemCloudClientError(response.status, payload, text);
    }
    return payload;
  }
}

export class OpenMemCloudClientError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    readonly rawBody: string
  ) {
    super(`OpenMem cloud HTTP ${status}: ${rawBody}`);
  }
}

export function openMemAddMessageFromTurnComplete(input: {
  userId: string;
  conversationId: string;
  turnId: string;
  request: TurnCompleteRequest & Record<string, unknown>;
  agentId?: string;
  appId?: string;
  tags?: string[];
  info?: Record<string, unknown>;
  allowKnowledgebaseIds?: string[];
  allowPublic?: boolean;
  asyncMode?: boolean;
}): OpenMemAddMessageRequest {
  const messages: OpenMemMessage[] = [];
  const toolCalls = normalizeOpenMemToolCalls(input.request.toolCalls);
  if (input.request.query.trim()) {
    messages.push({
      role: "user",
      content: input.request.query
    });
  }
  if (input.request.answer.trim() || toolCalls.length) {
    messages.push({
      role: "assistant",
      content: input.request.answer.trim(),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
  }
  messages.push(...normalizeOpenMemToolResults(input.request.toolResults, toolCalls));

  return {
    user_id: input.userId,
    conversation_id: input.conversationId,
    messages,
    agent_id: input.agentId,
    app_id: input.appId,
    tags: distinct([...(input.tags ?? []), ...(input.request.tags ?? [])]),
    allow_knowledgebase_ids: input.allowKnowledgebaseIds,
    allow_public: input.allowPublic,
    async_mode: input.asyncMode,
    info: compactRecord({
      ...(input.info ?? {}),
      memory_layer: "L1",
      turn_id: input.turnId,
      episode_id: input.request.episodeId,
      source_memory_ids: normalizeStringArray(input.request.sourceMemoryIds),
      status: input.request.status
    })
  };
}

export function openMemFeedbackFromFeedback(input: {
  userId: string;
  request: FeedbackRequest;
  conversationId?: string;
  agentId?: string;
  appId?: string;
  feedbackTime?: string;
  allowKnowledgebaseIds?: string[];
  allowPublic?: boolean;
  info?: Record<string, unknown>;
}): OpenMemAddFeedbackRequest {
  const magnitude = input.request.magnitude === undefined
    ? ""
    : ` magnitude=${input.request.magnitude}`;
  const feedbackContent = input.request.rationale?.trim() ||
    `${input.request.channel} ${input.request.polarity}${magnitude}`;
  return {
    user_id: input.userId,
    conversation_id: input.conversationId ?? input.request.sessionId,
    feedback_content: feedbackContent,
    agent_id: input.agentId,
    app_id: input.appId,
    feedback_time: input.feedbackTime,
    allow_knowledgebase_ids: input.allowKnowledgebaseIds,
    allow_public: input.allowPublic,
    info: compactRecord({
      ...(input.info ?? {}),
      memory_layer: "feedback",
      episode_id: input.request.episodeId,
      l1_memory_id: input.request.l1MemoryId,
      raw_turn_id: input.request.rawTurnId,
      recall_event_id: input.request.recallEventId,
      channel: input.request.channel,
      polarity: input.request.polarity,
      magnitude: input.request.magnitude,
      raw_payload: input.request.rawPayload
    })
  };
}

function stringifyJsonArgument(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? {});
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.content === "string") return value.content;
  return JSON.stringify(value ?? {});
}

function toolCallIdFromResult(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringField(value, "tool_call_id") ??
    stringField(value, "toolCallId") ??
    stringField(value, "callId") ??
    stringField(value, "id");
}

function normalizeOpenMemToolCalls(values: unknown): OpenMemToolCall[] {
  return (Array.isArray(values) ? values : [])
    .map((value, index) => normalizeOpenMemToolCall(value, index))
    .filter((value): value is OpenMemToolCall => Boolean(value));
}

function normalizeOpenMemToolCall(value: unknown, index: number): OpenMemToolCall | null {
  if (!isRecord(value)) return null;

  const fn = isRecord(value.function) ? value.function : {};
  const name = stringField(value, "name") ?? stringField(fn, "name");
  if (!name) return null;

  const rawArguments = firstDefined(value.input, value.args, value.arguments, fn.arguments, {});
  return {
    id: stringField(value, "id") ?? stringField(value, "tool_call_id") ?? stringField(value, "call_id") ?? `tool-call-${index + 1}`,
    type: "function",
    function: {
      name,
      arguments: stringifyJsonArgument(rawArguments)
    }
  };
}

function normalizeOpenMemToolResults(values: unknown, toolCalls: OpenMemToolCall[]): OpenMemMessage[] {
  return (Array.isArray(values) ? values : []).map((value, index) => ({
    role: "tool",
    tool_call_id: toolCallIdFromResult(value) ?? toolCalls[index]?.id ?? `tool-call-${index + 1}`,
    content: stringifyToolResult(value)
  }));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return values.length ? values : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
      value !== undefined &&
      (!Array.isArray(value) || value.length > 0)
    )
  );
}

function distinct(values: string[]): string[] | undefined {
  const out = [...new Set(values.filter(Boolean))];
  return out.length ? out : undefined;
}
