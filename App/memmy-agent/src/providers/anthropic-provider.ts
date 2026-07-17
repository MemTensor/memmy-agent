import Anthropic from "@anthropic-ai/sdk";
import { createProviderAbortError, isProviderAbortError, LLMProvider, LLMResponse, providerAbortOptions, ToolCallRequest } from "./base.js";
import { parseToolArguments } from "./tool-json.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function genToolId(): string {
  let suffix = "";
  for (let i = 0; i < 22; i += 1) suffix += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return `toolu_${suffix}`;
}

function headerGet(headers: any, name: string): any {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
}

async function maybeCall<T extends unknown[]>(callback: ((...args: T) => Promise<void> | void) | undefined, ...args: T): Promise<void> {
  if (callback) await callback(...args);
}

export class AnthropicProvider extends LLMProvider {
  model: string | null = null;
  defaultModel: string;
  spec: any = null;
  extraHeaders: Record<string, string> | null = null;
  extraBody: Record<string, any> | null = null;
  client: any = null;

  constructor(
    init:
      | string
      | {
          apiKey?: string | null;
          apiBase?: string | null;
          defaultModel?: string | null;
          spec?: any;
          extraHeaders?: Record<string, string> | null;
          extraBody?: Record<string, any> | null;
        }
      | null = null,
    apiBase: string | null = null,
    defaultModel: string | null = null,
  ) {
    if (init && typeof init === "object") {
      super(init.apiKey ?? null, init.apiBase ?? null);
      this.model = init.defaultModel ?? null;
      this.spec = init.spec ?? null;
      this.extraHeaders = init.extraHeaders ?? null;
      this.extraBody = init.extraBody ?? null;
    } else {
      super(init, apiBase);
      this.model = defaultModel;
    }
    this.defaultModel = this.model ?? "claude-sonnet-4-20250514";
    this.client = this.buildClient();
  }

  buildClient(): any {
    const clientOptions: Record<string, any> = {
      apiKey: this.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
      maxRetries: 0,
    };
    if (this.apiBase) clientOptions.baseURL = this.apiBase;
    if (this.extraHeaders) clientOptions.defaultHeaders = this.extraHeaders;
    return new Anthropic(clientOptions);
  }

  static handleError(error: any): LLMResponse {
    const response = error.response;
    const body = error.body ?? error.doc ?? response?.text ?? error.message ?? "";
    const [errorType, errorCode] = this.extractErrorTypeCode(body);
    const headers = response?.headers ?? {};
    const shouldRetryHeader = headerGet(headers, "x-should-retry");
    const shouldRetry =
      shouldRetryHeader == null
        ? null
        : String(shouldRetryHeader).trim().toLowerCase() === "true"
          ? true
          : String(shouldRetryHeader).trim().toLowerCase() === "false"
            ? false
            : null;
    const status = error.statusCode ?? error.statusCode ?? response?.statusCode ?? response?.status;
    const kind = /timeout|timed out/i.test(String(error.message ?? error.constructor?.name ?? ""))
      ? "timeout"
      : /connection/i.test(String(error.message ?? error.constructor?.name ?? ""))
        ? "connection"
        : null;
    const retryAfter = this.extractRetryAfterFromHeaders(headers) ?? this.extractRetryAfter(typeof body === "string" ? body : JSON.stringify(body));
    return new LLMResponse({
      content:
        typeof body === "string" && body.trim()
          ? `Error: ${body.trim().slice(0, 500)}`
          : `Error calling LLM: ${error.message ?? String(error)}`,
      finishReason: "error",
      retryAfter,
      errorStatusCode: status ?? null,
      errorKind: kind,
      errorType,
      errorCode,
      errorRetryAfterS: retryAfter,
      errorShouldRetry: shouldRetry,
    });
  }

  static stripPrefix(model: string): string {
    return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  }

  static toolResultBlock(msg: Record<string, any>): Record<string, any> {
    const content = msg.content;
    const block: Record<string, any> = {
      type: "tool_result",
      tool_use_id: msg.tool_call_id ?? "",
    };
    if (Array.isArray(content)) block.content = this.convertUserContent(content);
    else if (typeof content === "string") block.content = content;
    else block.content = content == null ? "" : String(content);
    return block;
  }

  static assistantBlocks(msg: Record<string, any>): Record<string, any>[] {
    const blocks: Record<string, any>[] = [];
    for (const tb of msg.thinking_blocks ?? msg.thinkingBlocks ?? []) {
      if (tb && typeof tb === "object" && tb.type === "thinking") {
        blocks.push({ type: "thinking", thinking: tb.thinking ?? "", signature: tb.signature ?? "" });
      }
    }

    const content = msg.content;
    if (typeof content === "string" && content) {
      blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) blocks.push(item && typeof item === "object" ? item : { type: "text", text: String(item) });
    }

    for (const tc of msg.tool_calls ?? msg.toolCalls ?? []) {
      if (!tc || typeof tc !== "object") continue;
      const fn = tc.function ?? {};
      blocks.push({
        type: "tool_use",
        id: tc.id ?? genToolId(),
        name: fn.name ?? tc.name ?? "",
        input: parseToolArguments(fn.arguments ?? tc.arguments),
      });
    }

    return blocks.length ? blocks : [{ type: "text", text: "" }];
  }

  static convertUserContent(content: any): any {
    if (typeof content === "string" || content == null) return content || "(empty)";
    if (!Array.isArray(content)) return String(content);

    const result: Record<string, any>[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") {
        result.push({ type: "text", text: String(item) });
        continue;
      }
      if (item.type === "image_url") {
        const converted = this.convertImageBlock(item);
        if (converted) result.push(converted);
        continue;
      }
      result.push(item);
    }
    return result.length ? result : "(empty)";
  }

  static convertImageBlock(block: Record<string, any>): Record<string, any> | null {
    const url = block.image_url?.url ?? block.imageUrl?.url ?? "";
    if (!url) return null;
    const match = String(url).match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    if (match) {
      return {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      };
    }
    return { type: "image", source: { type: "url", url } };
  }

  static hasToolUse(msg: Record<string, any>): boolean {
    return Array.isArray(msg.content) && msg.content.some((block: any) => block && typeof block === "object" && block.type === "tool_use");
  }

  static mergeConsecutive(msgs: Record<string, any>[]): Record<string, any>[] {
    const merged: Record<string, any>[] = [];
    for (const msg of msgs) {
      const previous = merged.at(-1);
      if (previous && previous.role === msg.role) {
        let prevContent = previous.content;
        let curContent = msg.content;
        if (typeof prevContent === "string") prevContent = [{ type: "text", text: prevContent }];
        if (typeof curContent === "string") curContent = [{ type: "text", text: curContent }];
        if (Array.isArray(curContent)) {
          previous.content = [...(Array.isArray(prevContent) ? prevContent : []), ...curContent];
        }
      } else {
        merged.push({ ...msg });
      }
    }

    let lastPopped: Record<string, any> | null = null;
    while (merged.length && merged.at(-1)?.role === "assistant") lastPopped = merged.pop() ?? null;
    if (!merged.length && lastPopped && !this.hasToolUse(lastPopped)) {
      merged.push({ role: "user", content: lastPopped.content });
    }
    if (merged.length && merged[0].role === "assistant" && !this.hasToolUse(merged[0])) {
      merged.unshift({ role: "user", content: "(conversation continued)" });
    }
    return merged;
  }

  convertMessages(messages: Record<string, any>[]): [string | Record<string, any>[], Record<string, any>[]] {
    let system: string | Record<string, any>[] = "";
    const raw: Record<string, any>[] = [];

    for (const msg of messages) {
      const role = msg.role ?? "";
      const content = msg.content;

      if (role === "system") {
        system = typeof content === "string" || Array.isArray(content) ? content : String(content ?? "");
        continue;
      }

      if (role === "tool") {
        const block = AnthropicProvider.toolResultBlock(msg);
        if (raw.length && raw.at(-1)?.role === "user") {
          const prev = raw.at(-1)!;
          prev.content = Array.isArray(prev.content)
            ? [...prev.content, block]
            : [{ type: "text", text: prev.content || "" }, block];
        } else {
          raw.push({ role: "user", content: [block] });
        }
        continue;
      }

      if (role === "assistant") {
        raw.push({ role: "assistant", content: AnthropicProvider.assistantBlocks(msg) });
        continue;
      }

      if (role === "user") raw.push({ role: "user", content: AnthropicProvider.convertUserContent(content) });
    }

    return [system, AnthropicProvider.mergeConsecutive(raw)];
  }

  static convertTools(tools: Record<string, any>[] | null | undefined): Record<string, any>[] | null {
    if (!tools?.length) return null;
    return tools.map((tool) => {
      const fn = tool.function ?? tool;
      const entry: Record<string, any> = {
        name: fn.name ?? "",
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      };
      if (fn.description) entry.description = fn.description;
      if (tool.cache_control) entry.cache_control = tool.cache_control;
      return entry;
    });
  }

  static convertToolChoice(toolChoice: string | Record<string, any> | null | undefined, thinkingEnabled = false): Record<string, any> | null {
    if (thinkingEnabled) return { type: "auto" };
    if (toolChoice == null || toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "required") return { type: "any" };
    if (toolChoice === "none") return null;
    if (typeof toolChoice === "object") {
      const name = toolChoice.function?.name;
      if (name) return { type: "tool", name };
    }
    return { type: "auto" };
  }

  static applyCacheControl(
    system: string | Record<string, any>[],
    messages: Record<string, any>[],
    tools: Record<string, any>[] | null = null,
  ): [string | Record<string, any>[], Record<string, any>[], Record<string, any>[] | null] {
    const marker = { type: "ephemeral" };
    let markedSystem = system;
    if (typeof system === "string" && system) {
      markedSystem = [{ type: "text", text: system, cache_control: marker }];
    } else if (Array.isArray(system) && system.length) {
      markedSystem = structuredClone(system);
      markedSystem[markedSystem.length - 1] = { ...markedSystem[markedSystem.length - 1], cache_control: marker };
    }

    const markedMessages = structuredClone(messages);
    if (markedMessages.length >= 3) {
      const idx = markedMessages.length - 2;
      const msg = markedMessages[idx];
      const content = msg.content;
      if (typeof content === "string") {
        markedMessages[idx] = { ...msg, content: [{ type: "text", text: content, cache_control: marker }] };
      } else if (Array.isArray(content) && content.length) {
        const newContent = structuredClone(content);
        newContent[newContent.length - 1] = { ...newContent[newContent.length - 1], cache_control: marker };
        markedMessages[idx] = { ...msg, content: newContent };
      }
    }

    const markedTools = tools ? structuredClone(tools) : null;
    if (markedTools) {
      for (const idx of this.toolCacheMarkerIndices(markedTools)) markedTools[idx].cache_control = marker;
    }
    return [markedSystem, markedMessages, markedTools];
  }

  buildKwargs(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
    supportsCaching?: boolean;
  }): Record<string, any> {
    const maxTokens = Math.max(1, args.maxTokens ?? this.generation.maxTokens);
    const temperature = args.temperature ?? this.generation.temperature;
    const reasoningEffort = args.reasoningEffort ?? this.generation.reasoningEffort;
    const toolChoice = args.toolChoice ?? null;
    const modelName = AnthropicProvider.stripPrefix(args.model ?? this.defaultModel);
    let [system, messages, tools] = [
      ...this.convertMessages(LLMProvider.sanitizeEmptyContent(args.messages)),
      AnthropicProvider.convertTools(args.tools),
    ] as [string | Record<string, any>[], Record<string, any>[], Record<string, any>[] | null];

    if (args.supportsCaching ?? true) {
      [system, messages, tools] = AnthropicProvider.applyCacheControl(system, messages, tools);
    }

    const thinkingEnabled = Boolean(reasoningEffort) && String(reasoningEffort).toLowerCase() !== "none";
    const omitTemperature = modelName.includes("opus-4-7");
    const kwargs: Record<string, any> = {
      model: modelName,
      messages,
      max_tokens: maxTokens,
    };
    if (system && (!Array.isArray(system) || system.length)) kwargs.system = system;

    if (reasoningEffort === "adaptive") {
      kwargs.thinking = { type: "adaptive" };
      if (!omitTemperature) kwargs.temperature = 1.0;
    } else if (thinkingEnabled) {
      const effort = String(reasoningEffort).toLowerCase();
      const budget = effort === "low" ? 1024 : effort === "high" ? Math.max(8192, maxTokens) : 4096;
      kwargs.thinking = { type: "enabled", budget_tokens: budget };
      kwargs.max_tokens = Math.max(maxTokens, budget + 4096);
      if (!omitTemperature) kwargs.temperature = 1.0;
    } else if (!omitTemperature) {
      kwargs.temperature = temperature;
    }

    if (tools?.length) {
      kwargs.tools = tools;
      const tc = AnthropicProvider.convertToolChoice(toolChoice, thinkingEnabled);
      if (tc) kwargs.tool_choice = tc;
    }

    if (this.extraHeaders) kwargs.extra_headers = this.extraHeaders;
    if (this.extraBody) Object.assign(kwargs, this.extraBody);
    return kwargs;
  }

  static parseResponse(response: any): LLMResponse {
    const contentParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    const thinkingBlocks: Record<string, any>[] = [];
    const reasoningParts: string[] = [];
    for (const block of response?.content ?? []) {
      if (block?.type === "text") contentParts.push(block.text ?? "");
      else if (block?.type === "tool_use") {
        toolCalls.push(new ToolCallRequest({ id: block.id, name: block.name ?? "", arguments: parseToolArguments(block.input) }));
      } else if (block?.type === "thinking") {
        thinkingBlocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
        if (block.thinking) reasoningParts.push(block.thinking);
      }
    }
    const stopMap: Record<string, string> = { tool_use: "tool_calls", end_turn: "stop", max_tokens: "length" };
    const usage: Record<string, number> = {};
    if (response?.usage) {
      const input = Number(response.usage.input_tokens ?? 0);
      const cacheCreation = Number(response.usage.cache_creation_input_tokens ?? 0);
      const cacheRead = Number(response.usage.cache_read_input_tokens ?? 0);
      const output = Number(response.usage.output_tokens ?? 0);
      const prompt = input + cacheCreation + cacheRead;
      usage.prompt_tokens = prompt;
      usage.completion_tokens = output;
      usage.total_tokens = prompt + output;
      if (cacheCreation) usage.cache_creation_input_tokens = cacheCreation;
      if (cacheRead) {
        usage.cache_read_input_tokens = cacheRead;
        usage.cached_tokens = cacheRead;
      }
    }
    return new LLMResponse({
      content: contentParts.join("") || null,
      toolCalls,
      finishReason: stopMap[response?.stop_reason ?? ""] ?? response?.stop_reason ?? "stop",
      usage,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : null,
      reasoningContent: reasoningParts.join("") || null,
    });
  }

  parseResponse(response: any): LLMResponse {
    return AnthropicProvider.parseResponse(response);
  }

  static isStreamingRequiredError(error: any): boolean {
    const name = String(error?.name ?? error?.constructor?.name ?? "");
    return name === "ValueError" && /streaming is required/i.test(String(error?.message ?? error));
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
    signal?: AbortSignal | null;
  }): Promise<LLMResponse> {
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (!apiKey) return new LLMResponse({ content: "Error calling LLM: missing Anthropic API key", finishReason: "error" });
    const kwargs = this.buildKwargs(args);
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const response = options
        ? await this.client.messages.create(kwargs as any, options as any)
        : await this.client.messages.create(kwargs as any);
      return this.parseResponse(response);
    } catch (error: any) {
      if (isProviderAbortError(error)) throw error;
      if (AnthropicProvider.isStreamingRequiredError(error)) return this.chatStream(args);
      return AnthropicProvider.handleError(error);
    }
  }

  override async chatStream(args: Parameters<LLMProvider["chat"]>[0] & {
    onContentDelta?: (delta: string) => Promise<void> | void;
    onThinkingDelta?: (delta: string) => Promise<void> | void;
    onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
  }): Promise<LLMResponse> {
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (!apiKey) return new LLMResponse({ content: "Error calling LLM: missing Anthropic API key", finishReason: "error" });
    const kwargs = { ...this.buildKwargs(args), stream: true };
    const onContentDelta = args.onContentDelta;
    const onThinkingDelta = args.onThinkingDelta;
    const onToolCallDelta = args.onToolCallDelta;
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const stream = options
        ? await this.client.messages.create(kwargs as any, options as any)
        : await this.client.messages.create(kwargs as any);
      const final = await consumeAnthropicStream(stream, onContentDelta, onThinkingDelta, onToolCallDelta, args.signal ?? null);
      return final ?? new LLMResponse({ content: null, finishReason: "stop" });
    } catch (error: any) {
      if (isProviderAbortError(error)) throw error;
      return AnthropicProvider.handleError(error);
    }
  }
}

async function consumeAnthropicStream(
  stream: AsyncIterable<any>,
  onContentDelta?: (delta: string) => Promise<void> | void,
  onThinkingDelta?: (delta: string) => Promise<void> | void,
  onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void,
  signal?: AbortSignal | null,
): Promise<LLMResponse | null> {
  let finalMessage: any = null;
  const content: any[] = [];
  const toolBlocks = new Map<number, { call_id: string; name: string; args: string }>();

  const handleEvent = async (data: any): Promise<void> => {
    if (signal?.aborted) throw createProviderAbortError();
    if (!data || typeof data !== "object") return;
    if (data.type === "message_stop" && data.message) finalMessage = data.message;
    if (data.type === "message_delta" && data.delta?.stop_reason) {
      finalMessage = { ...(finalMessage ?? {}), stop_reason: data.delta.stop_reason, usage: data.usage };
    }
    if (data.type === "content_block_start") {
      const index = Number(data.index ?? 0);
      const block = data.content_block ?? {};
      content[index] = block;
      if (block.type === "tool_use") {
        const state = { call_id: block.id ?? "", name: block.name ?? "", args: "" };
        toolBlocks.set(index, state);
        if (!signal?.aborted) await maybeCall(onToolCallDelta, { index, call_id: state.call_id, name: state.name, arguments_delta: "" });
      }
    } else if (data.type === "content_block_delta") {
      const index = Number(data.index ?? 0);
      const delta = data.delta ?? {};
      if (delta.type === "text_delta") {
        content[index] = { ...(content[index] ?? { type: "text" }), type: "text", text: `${content[index]?.text ?? ""}${delta.text ?? ""}` };
        if (!signal?.aborted) await maybeCall(onContentDelta, delta.text ?? "");
      } else if (delta.type === "thinking_delta") {
        content[index] = {
          ...(content[index] ?? { type: "thinking" }),
          type: "thinking",
          thinking: `${content[index]?.thinking ?? ""}${delta.thinking ?? ""}`,
        };
        if (!signal?.aborted) await maybeCall(onThinkingDelta, delta.thinking ?? "");
      } else if (delta.type === "input_json_delta") {
        const state = toolBlocks.get(index) ?? { call_id: "", name: "", args: "" };
        state.args += delta.partial_json ?? "";
        toolBlocks.set(index, state);
        if (!signal?.aborted) await maybeCall(onToolCallDelta, { index, call_id: state.call_id, name: state.name, arguments_delta: delta.partial_json ?? "" });
      }
    }
  };

  for await (const event of stream) {
    if (signal?.aborted) throw createProviderAbortError();
    await handleEvent(event);
  }

  for (const [index, state] of toolBlocks.entries()) {
    const block = content[index] ?? { type: "tool_use" };
    content[index] = {
      ...block,
      type: "tool_use",
      id: block.id ?? state.call_id,
      name: block.name ?? state.name,
      input: parseToolArguments(state.args),
    };
  }
  return AnthropicProvider.parseResponse({ ...(finalMessage ?? {}), content: content.filter(Boolean) });
}
