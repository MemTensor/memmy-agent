import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { LLMProvider, LLMResponse, ToolCallRequest } from "./base.js";
import { parseToolArguments } from "./tool-json.js";

const IMAGE_DATA_URL = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/;
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
const TEMPERATURE_UNSUPPORTED_MODEL_TOKENS = ["claude-opus-4-7"];
const ADAPTIVE_THINKING_ONLY_MODEL_TOKENS = ["claude-opus-4-7"];
const NOOP_TOOL_NAME = "memmy_noop";

type BedrockInit = {
  apiKey?: string | null;
  apiBase?: string | null;
  defaultModel?: string | null;
  region?: string | null;
  profile?: string | null;
  extraBody?: Record<string, any> | null;
  client?: any;
};

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key]) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function headerGet(headers: any, name: string): any {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
}

function nextOrNull<T>(iterator: Iterator<T>): T | null {
  const next = iterator.next();
  return next.done ? null : next.value;
}

export class BedrockProvider extends LLMProvider {
  model: string | null = null;
  defaultModel: string;
  region: string | null = null;
  profile: string | null = null;
  extraBody: Record<string, any> | null = null;
  private extraBodyFields: Record<string, any>;
  client: any = null;
  private sdk: any = { ConverseCommand, ConverseStreamCommand };

  constructor(init: string | BedrockInit | null = null) {
    if (init && typeof init === "object") {
      super(init.apiKey ?? null, init.apiBase ?? null);
      this.model = init.defaultModel ?? null;
      this.region = init.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null;
      this.profile = init.profile ?? null;
      this.extraBody = init.extraBody ?? null;
      this.extraBodyFields = this.extraBody ?? {};
      this.client = init.client ?? null;
    } else {
      super(init, null);
      this.region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null;
      this.extraBody = null;
      this.extraBodyFields = {};
    }
    this.defaultModel = this.model ?? "bedrock/global.anthropic.claude-opus-4-7";
  }

  async makeClient(): Promise<any> {
    if (this.apiKey) process.env.AWS_BEARER_TOKEN_BEDROCK = this.apiKey;
    const clientConfig: Record<string, any> = {};
    if (this.region) clientConfig.region = this.region;
    if (this.apiBase) clientConfig.endpoint = this.apiBase;
    if (this.profile) clientConfig.credentials = fromIni({ profile: this.profile });
    return new BedrockRuntimeClient(clientConfig);
  }

  private async ensureClient(): Promise<any> {
    if (!this.client) this.client = await this.makeClient();
    return this.client;
  }

  static stripPrefix(model: string): string {
    return model.startsWith("bedrock/") ? model.slice("bedrock/".length) : model;
  }

  static matchesModelToken(model: string, tokens: readonly string[]): boolean {
    const lower = model.toLowerCase();
    return tokens.some((token) => lower.includes(token));
  }

  static supportsTemperature(model: string): boolean {
    return !this.matchesModelToken(model, TEMPERATURE_UNSUPPORTED_MODEL_TOKENS);
  }

  static usesAdaptiveThinkingOnly(model: string): boolean {
    return this.matchesModelToken(model, ADAPTIVE_THINKING_ONLY_MODEL_TOKENS);
  }

  static imageUrlBlock(block: Record<string, any>): Record<string, any> | null {
    const url = block.image_url?.url ?? block.imageUrl?.url ?? "";
    if (typeof url !== "string" || !url) return null;
    const match = url.match(IMAGE_DATA_URL);
    if (!match) return { text: `(image URL: ${url})` };
    const format = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
    try {
      return { image: { format, source: { bytes: Buffer.from(match[2], "base64") } } };
    } catch {
      return { text: "(invalid image data)" };
    }
  }

  static contentBlocks(content: any, { forToolResult = false }: { forToolResult?: boolean } = {}): Record<string, any>[] {
    if (typeof content === "string" || content == null) return [{ text: content || "(empty)" }];
    if (!Array.isArray(content)) {
      if (forToolResult && content && typeof content === "object") return [{ json: content }];
      return [{ text: String(content) }];
    }

    const blocks: Record<string, any>[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") {
        blocks.push({ text: String(item) });
        continue;
      }
      const itemType = item.type;
      if (TEXT_BLOCK_TYPES.has(itemType) || "text" in item) {
        if (item.text) blocks.push({ text: String(item.text) });
        continue;
      }
      if (itemType === "image_url") {
        const converted = this.imageUrlBlock(item);
        if (converted) blocks.push(converted);
        continue;
      }
      const shapedKey = ["text", "image", "document", "video", "json", "searchResult"].find((key) => key in item);
      if (shapedKey) blocks.push({ [shapedKey]: item[shapedKey] });
      else blocks.push(forToolResult ? { json: item } : { text: JSON.stringify(item) });
    }
    return blocks.length ? blocks : [{ text: "(empty)" }];
  }

  static systemBlocks(content: any): Record<string, any>[] {
    return this.contentBlocks(content).filter((block) => "text" in block || "cachePoint" in block || "guardContent" in block);
  }

  static toolResultBlock(msg: Record<string, any>): Record<string, any> {
    return {
      toolResult: {
        toolUseId: String(msg.tool_call_id ?? ""),
        content: this.contentBlocks(msg.content, { forToolResult: true }),
        status: "success",
      },
    };
  }

  static toolUseBlock(toolCall: Record<string, any>): Record<string, any> | null {
    const fn = toolCall.function;
    if (!fn || typeof fn !== "object") return null;
    return {
      toolUse: {
        toolUseId: String(toolCall.id ?? ""),
        name: String(fn.name ?? ""),
        input: parseToolArguments(fn.arguments),
      },
    };
  }

  static reasoningBlock(block: Record<string, any>): Record<string, any> | null {
    if (!["thinking", "reasoning", "redacted_thinking"].includes(block.type)) return null;
    const text = block.thinking ?? block.text;
    if (text && block.signature) {
      return { reasoningContent: { reasoningText: { text: String(text), signature: String(block.signature) } } };
    }
    let redacted = block.redactedContent;
    if (redacted == null && typeof block.redactedContentBase64 === "string") {
      redacted = Buffer.from(block.redactedContentBase64, "base64");
    }
    if (redacted != null) return { reasoningContent: { redactedContent: redacted } };
    return null;
  }

  static assistantBlocks(msg: Record<string, any>): Record<string, any>[] {
    const blocks: Record<string, any>[] = [];
    for (const thinking of msg.thinking_blocks ?? msg.thinkingBlocks ?? []) {
      if (thinking && typeof thinking === "object") {
        const reasoning = this.reasoningBlock(thinking);
        if (reasoning) blocks.push(reasoning);
      }
    }
    const content = msg.content;
    if (typeof content === "string" && content) blocks.push({ text: content });
    else if (Array.isArray(content)) blocks.push(...this.contentBlocks(content).filter((block) => "text" in block));

    for (const toolCall of msg.tool_calls ?? msg.toolCalls ?? []) {
      if (toolCall && typeof toolCall === "object") {
        const block = this.toolUseBlock(toolCall);
        if (block) blocks.push(block);
      }
    }
    return blocks.length ? blocks : [{ text: "" }];
  }

  static hasToolUse(msg: Record<string, any>): boolean {
    return Array.isArray(msg.content) && msg.content.some((block: any) => block && typeof block === "object" && "toolUse" in block);
  }

  static mergeConsecutive(messages: Record<string, any>[]): Record<string, any>[] {
    const merged: Record<string, any>[] = [];
    for (const msg of messages) {
      const previous = merged.at(-1);
      if (previous && previous.role === msg.role) {
        let prev = previous.content;
        const cur = msg.content ?? [];
        if (!Array.isArray(prev)) {
          prev = [{ text: String(prev) }];
          previous.content = prev;
        }
        if (Array.isArray(cur)) prev.push(...cur);
        else prev.push({ text: String(cur) });
      } else {
        merged.push({ ...msg });
      }
    }

    let lastPopped: Record<string, any> | null = null;
    while (merged.length && merged.at(-1)?.role === "assistant") lastPopped = merged.pop() ?? null;
    if (!merged.length && lastPopped && !this.hasToolUse(lastPopped)) {
      merged.push({ role: "user", content: lastPopped.content ?? [{ text: "(empty)" }] });
    }
    if (merged.length && merged[0].role === "assistant" && !this.hasToolUse(merged[0])) {
      merged.unshift({ role: "user", content: [{ text: "(conversation continued)" }] });
    }
    return merged;
  }

  convertMessages(messages: Record<string, any>[]): [Record<string, any>[], Record<string, any>[]] {
    const system: Record<string, any>[] = [];
    const converted: Record<string, any>[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        system.push(...BedrockProvider.systemBlocks(msg.content));
        continue;
      }
      if (msg.role === "tool") {
        const block = BedrockProvider.toolResultBlock(msg);
        if (converted.length && converted.at(-1)?.role === "user") converted.at(-1)!.content.push(block);
        else converted.push({ role: "user", content: [block] });
        continue;
      }
      if (msg.role === "assistant") {
        converted.push({ role: "assistant", content: BedrockProvider.assistantBlocks(msg) });
        continue;
      }
      if (msg.role === "user") converted.push({ role: "user", content: BedrockProvider.contentBlocks(msg.content) });
    }
    return [system, BedrockProvider.mergeConsecutive(converted)];
  }

  static convertTools(tools: Record<string, any>[] | null | undefined): Record<string, any>[] | null {
    if (!tools?.length) return null;
    const result: Record<string, any>[] = [];
    for (const tool of tools) {
      const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
      const name = fn.name ? String(fn.name) : "";
      if (!name) continue;
      const spec: Record<string, any> = {
        name,
        inputSchema: { json: fn.parameters ?? { type: "object", properties: {} } },
      };
      if (fn.description) spec.description = String(fn.description);
      const strict = fn.strict ?? tool.strict;
      if (typeof strict === "boolean") spec.strict = strict;
      result.push({ toolSpec: spec });
    }
    return result.length ? result : null;
  }

  static containsToolBlocks(messages: Record<string, any>[]): boolean {
    return messages.some((msg) => Array.isArray(msg.content) && msg.content.some((block: any) => block && ("toolUse" in block || "toolResult" in block)));
  }

  static noopTool(): Record<string, any> {
    return {
      toolSpec: {
        name: NOOP_TOOL_NAME,
        description: "Internal placeholder for Bedrock tool history validation.",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    };
  }

  static convertToolChoice(toolChoice: string | Record<string, any> | null | undefined): Record<string, any> | null {
    if (toolChoice == null || toolChoice === "auto") return { auto: {} };
    if (toolChoice === "required") return { any: {} };
    if (toolChoice === "none") return null;
    if (typeof toolChoice === "object") {
      const name = toolChoice.function?.name;
      if (name) return { tool: { name: String(name) } };
    }
    return { auto: {} };
  }

  static adaptiveThinking(reasoningEffort?: string | null): Record<string, any> | null {
    if (!reasoningEffort) return null;
    const effort = reasoningEffort.toLowerCase();
    if (effort === "none") return null;
    const thinking: Record<string, any> = { type: "adaptive" };
    if (effort !== "adaptive") thinking.effort = effort;
    return thinking;
  }

  buildKwargs(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
  }): Record<string, any> {
    const modelId = BedrockProvider.stripPrefix(args.model ?? this.defaultModel);
    let [system, messages] = this.convertMessages(LLMProvider.sanitizeEmptyContent(args.messages));
    if (!messages.length) messages = [{ role: "user", content: [{ text: "(empty)" }] }];

    const kwargs: Record<string, any> = {
      modelId,
      messages,
      inferenceConfig: { maxTokens: Math.max(1, args.maxTokens ?? this.generation.maxTokens) },
    };
    if (system.length) kwargs.system = system;
    if (BedrockProvider.supportsTemperature(modelId)) kwargs.inferenceConfig.temperature = args.temperature ?? this.generation.temperature;

    let additional: Record<string, any> = {};
    const reasoningEffort = args.reasoningEffort ?? this.generation.reasoningEffort;
    if (BedrockProvider.usesAdaptiveThinkingOnly(modelId)) {
      const thinking = BedrockProvider.adaptiveThinking(reasoningEffort);
      if (thinking) additional.thinking = thinking;
    }
    if (this.extraBodyFields) additional = deepMerge(additional, this.extraBodyFields);
    if (Object.keys(additional).length) kwargs.additionalModelRequestFields = additional;

    const bedrockTools = BedrockProvider.convertTools(args.tools);
    let toolConfig: Record<string, any> | null = null;
    if (bedrockTools) {
      toolConfig = { tools: bedrockTools };
      const choice = BedrockProvider.convertToolChoice(args.toolChoice);
      if (choice) toolConfig.toolChoice = choice;
    } else if (BedrockProvider.containsToolBlocks(messages)) {
      toolConfig = { tools: [BedrockProvider.noopTool()] };
    }
    if (toolConfig) kwargs.toolConfig = toolConfig;
    return kwargs;
  }

  static finishReason(stopReason?: string | null): string {
    return { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length" }[stopReason ?? ""] ?? stopReason ?? "stop";
  }

  static usage(usage?: Record<string, any> | null): Record<string, number> {
    if (!usage) return {};
    const prompt = Number(usage.inputTokens ?? 0);
    const completion = Number(usage.outputTokens ?? 0);
    const total = Number(usage.totalTokens ?? prompt + completion);
    const result: Record<string, number> = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    };
    const cacheRead = Number(usage.cacheReadInputTokens ?? 0);
    const cacheWrite = Number(usage.cacheWriteInputTokens ?? 0);
    if (cacheRead) {
      result.cached_tokens = cacheRead;
      result.cache_read_input_tokens = cacheRead;
    }
    if (cacheWrite) result.cache_creation_input_tokens = cacheWrite;
    return result;
  }

  static parseReasoning(block: Record<string, any>): [string | null, Record<string, any> | null] {
    const reasoning = block.reasoningContent;
    if (!reasoning || typeof reasoning !== "object") return [null, null];
    const textObj = reasoning.reasoningText;
    if (textObj && typeof textObj === "object" && typeof textObj.text === "string") {
      return [textObj.text, { type: "thinking", thinking: textObj.text, signature: textObj.signature ?? "" }];
    }
    const redacted = reasoning.redactedContent;
    if (redacted != null) {
      if (Buffer.isBuffer(redacted) || redacted instanceof Uint8Array) {
        return [null, { type: "redacted_thinking", redactedContentBase64: Buffer.from(redacted).toString("base64") }];
      }
      return [null, { type: "redacted_thinking", redactedContent: redacted }];
    }
    return [null, null];
  }

  static parseResponse(response: Record<string, any>): LLMResponse {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    const thinkingBlocks: Record<string, any>[] = [];
    const message = response.output?.message ?? {};
    for (const block of message.content ?? []) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") contentParts.push(block.text);
      if (block.toolUse && typeof block.toolUse === "object") {
        toolCalls.push(
          new ToolCallRequest({
            id: String(block.toolUse.toolUseId ?? ""),
            name: String(block.toolUse.name ?? ""),
            arguments: block.toolUse.input && typeof block.toolUse.input === "object" ? block.toolUse.input : {},
          }),
        );
      }
      const [reasoningText, thinking] = this.parseReasoning(block);
      if (reasoningText) reasoningParts.push(reasoningText);
      if (thinking) thinkingBlocks.push(thinking);
    }
    return new LLMResponse({
      content: contentParts.join("") || null,
      toolCalls,
      finishReason: this.finishReason(response.stopReason),
      usage: this.usage(response.usage),
      reasoningContent: reasoningParts.join("") || null,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : null,
    });
  }

  parseResponse(response: Record<string, any>): LLMResponse {
    return BedrockProvider.parseResponse(response);
  }

  static parseStreamEvent(
    event: Record<string, any>,
    options: {
      contentParts: string[];
      reasoningParts: string[];
      thinkingBlocks: Record<string, any>[];
      toolBuffers: Record<number, Record<string, any>>;
      state: Record<string, any>;
    },
  ): string | null {
    const contentParts = options.contentParts;
    const reasoningParts = options.reasoningParts;
    const thinkingBlocks = options.thinkingBlocks;
    const toolBuffers = options.toolBuffers;
    const state = options.state;

    if (event.contentBlockStart) {
      const idx = Number(event.contentBlockStart.contentBlockIndex ?? 0);
      const toolUse = event.contentBlockStart.start?.toolUse;
      if (toolUse && typeof toolUse === "object") {
        toolBuffers[idx] = { id: String(toolUse.toolUseId ?? ""), name: String(toolUse.name ?? ""), input: "" };
      }
      return null;
    }
    if (event.contentBlockDelta) {
      const idx = Number(event.contentBlockDelta.contentBlockIndex ?? 0);
      const delta = event.contentBlockDelta.delta ?? {};
      if (typeof delta.text === "string") {
        contentParts.push(delta.text);
        return delta.text;
      }
      if (delta.toolUse && typeof delta.toolUse === "object") {
        const buffer = (toolBuffers[idx] ??= { id: "", name: "", input: "" });
        if (typeof delta.toolUse.input === "string") buffer.input += delta.toolUse.input;
      }
      if (delta.reasoningContent && typeof delta.reasoningContent === "object") {
        const buffers = (state.reasoningBuffers ??= {});
        const buffer = (buffers[idx] ??= { text: "", signature: "", redactedContent: null });
        if (typeof delta.reasoningContent.text === "string") {
          buffer.text += delta.reasoningContent.text;
          reasoningParts.push(delta.reasoningContent.text);
        }
        if (typeof delta.reasoningContent.signature === "string") buffer.signature = delta.reasoningContent.signature;
        if (delta.reasoningContent.redactedContent != null) buffer.redactedContent = delta.reasoningContent.redactedContent;
      }
      return null;
    }
    if (event.contentBlockStop) {
      const idx = Number(event.contentBlockStop.contentBlockIndex ?? 0);
      const buffer = state.reasoningBuffers?.[idx];
      if (buffer) {
        if (buffer.text) thinkingBlocks.push({ type: "thinking", thinking: buffer.text, signature: buffer.signature ?? "" });
        else if (buffer.redactedContent != null) {
          const redacted = buffer.redactedContent;
          thinkingBlocks.push(
            Buffer.isBuffer(redacted) || redacted instanceof Uint8Array
              ? { type: "redacted_thinking", redactedContentBase64: Buffer.from(redacted).toString("base64") }
              : { type: "redacted_thinking", redactedContent: redacted },
          );
        }
        delete state.reasoningBuffers[idx];
      }
      return null;
    }
    if (event.messageStop) state.stopReason = event.messageStop.stopReason;
    if (event.metadata?.usage) state.usage = event.metadata.usage;
    return null;
  }

  static streamResult(args: {
    contentParts: string[];
    reasoningParts: string[];
    thinkingBlocks: Record<string, any>[];
    toolBuffers: Record<number, Record<string, any>>;
    state: Record<string, any>;
  }): LLMResponse {
    const contentParts = args.contentParts;
    const reasoningParts = args.reasoningParts;
    const thinkingBlocks = args.thinkingBlocks;
    const toolBuffers = args.toolBuffers;
    const toolCalls = Object.values(toolBuffers).map(
      (buffer) =>
        new ToolCallRequest({
          id: buffer.id ?? "",
          name: buffer.name ?? "",
              arguments: parseToolArguments(buffer.input),
        }),
    );
    return new LLMResponse({
      content: contentParts.join("") || null,
      toolCalls,
      finishReason: this.finishReason(args.state.stopReason),
      usage: this.usage(args.state.usage),
      reasoningContent: reasoningParts.join("") || null,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : null,
    });
  }

  static handleError(error: any): LLMResponse {
    const response = error.response;
    const metadata = response?.ResponseMetadata ?? {};
    const headers = metadata.HTTPHeaders ?? response?.headers ?? {};
    const errorObj = response?.Error ?? {};
    const body = errorObj.Message ?? error.message ?? String(error);
    const retryAfter = this.extractRetryAfterFromHeaders(headers) ?? this.extractRetryAfter(body);
    const statusCode = metadata.HTTPStatusCode ?? error.statusCode ?? response?.status;
    const errorName = String(error.constructor?.name ?? error.name ?? "").toLowerCase();
    const errorKind = errorName.includes("timeout") ? "timeout" : errorName.includes("connection") || errorName.includes("endpoint") ? "connection" : null;
    const codeText = String(errorObj.Code ?? error.code ?? "").toLowerCase();
    let shouldRetry: boolean | null = null;
    if (statusCode != null) shouldRetry = Number(statusCode) === 429 || Number(statusCode) >= 500;
    if (/(throttl|timeout|unavailable|modelnotready)/i.test(codeText)) shouldRetry = true;
    return new LLMResponse({
      content: `Error: ${String(body).trim().slice(0, 500)}`,
      finishReason: "error",
      retryAfter,
      errorStatusCode: statusCode == null ? null : Number(statusCode),
      errorKind,
      errorType: codeText || null,
      errorCode: codeText || null,
      errorRetryAfterS: retryAfter,
      errorShouldRetry: shouldRetry,
    });
  }

  async invokeConverse(kwargs: Record<string, any>): Promise<Record<string, any>> {
    const client = await this.ensureClient();
    if (typeof client.converse === "function") return client.converse(kwargs);
    if (typeof client.send === "function") {
      if (!this.sdk) {
        this.sdk = { ConverseCommand, ConverseStreamCommand };
      }
      return client.send(new this.sdk.ConverseCommand(kwargs));
    }
    throw new Error("Bedrock client does not implement converse or send");
  }

  async invokeConverseStream(kwargs: Record<string, any>): Promise<Record<string, any>> {
    const client = await this.ensureClient();
    if (typeof client.converseStream === "function") return client.converseStream(kwargs);
    if (typeof client.send === "function") {
      if (!this.sdk) {
        this.sdk = { ConverseCommand, ConverseStreamCommand };
      }
      return client.send(new this.sdk.ConverseStreamCommand(kwargs));
    }
    throw new Error("Bedrock client does not implement converseStream or send");
  }

  async chat(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
  }): Promise<LLMResponse> {
    try {
      const kwargs = this.buildKwargs(args);
      const response = await this.invokeConverse(kwargs);
      return this.parseResponse(response);
    } catch (error) {
      return BedrockProvider.handleError(error);
    }
  }

  override async chatStream(args: Parameters<LLMProvider["chat"]>[0] & {
    onContentDelta?: (delta: string) => Promise<void> | void;
  }): Promise<LLMResponse> {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const thinkingBlocks: Record<string, any>[] = [];
    const toolBuffers: Record<number, Record<string, any>> = {};
    const state: Record<string, any> = {};
    const onContentDelta = args.onContentDelta;

    try {
      const response = await this.invokeConverseStream(this.buildKwargs(args));
      const stream = response.stream ?? [];
      const iterator = (Symbol.asyncIterator in Object(stream) ? stream[Symbol.asyncIterator]() : stream[Symbol.iterator]()) as AsyncIterator<any> | Iterator<any>;
      while (true) {
        const next = Symbol.asyncIterator in Object(stream) ? await (iterator as AsyncIterator<any>).next() : { value: nextOrNull(iterator as Iterator<any>), done: false };
        if (next.done || next.value == null) break;
        const delta = BedrockProvider.parseStreamEvent(next.value, {
          contentParts,
          reasoningParts,
          thinkingBlocks,
          toolBuffers,
          state,
        });
        if (delta && onContentDelta) await onContentDelta(delta);
      }
      return BedrockProvider.streamResult({ contentParts, reasoningParts, thinkingBlocks, toolBuffers, state });
    } catch (error) {
      return BedrockProvider.handleError(error);
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }
}
