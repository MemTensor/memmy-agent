import crypto from "node:crypto";
import OpenAI from "openai";
import { createProviderAbortError, isProviderAbortError, LLMProvider, LLMResponse, providerAbortOptions } from "./base.js";
import { consumeSdkStream, parseResponseOutput } from "./openai-responses/parsing.js";
import { convertMessages, convertTools } from "./openai-responses/converters.js";

type AzureInit =
  | string
  | {
      apiKey?: string | null;
      apiBase?: string | null;
      defaultModel?: string | null;
      extraHeaders?: Record<string, string> | null;
    }
  | null;

export class AzureOpenAIProvider extends LLMProvider {
  defaultModel: string;
  client: any;

  constructor(apiKeyOrInit: AzureInit = "", apiBase = "", defaultModel = "gpt-5.2-chat") {
    let apiKey: string | null;
    let base: string | null;
    let model: string | null;
    let extraHeaders: Record<string, string> | null = null;
    if (apiKeyOrInit && typeof apiKeyOrInit === "object") {
      apiKey = apiKeyOrInit.apiKey ?? "";
      base = apiKeyOrInit.apiBase ?? "";
      model = apiKeyOrInit.defaultModel ?? defaultModel;
      extraHeaders = apiKeyOrInit.extraHeaders ?? null;
    } else {
      apiKey = apiKeyOrInit ?? "";
      base = apiBase;
      model = defaultModel;
    }
    if (!apiKey) throw new Error("Azure OpenAI API key is required");
    if (!base) throw new Error("Azure OpenAI API base URL is required");
    if (!base.endsWith("/")) base += "/";
    super(apiKey, base);
    this.defaultModel = model || "gpt-5.2-chat";
    const baseUrl = `${base.replace(/\/+$/g, "")}/openai/v1/`;
    const defaultHeaders = {
      "x-session-affinity": crypto.randomBytes(16).toString("hex"),
      ...(extraHeaders ?? {}),
    };
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders,
      maxRetries: 0,
    });
    this.client.baseUrl = baseUrl;
    this.client.defaultHeaders = defaultHeaders;
  }

  static supportsTemperature(deploymentName: string, reasoningEffort?: string | null): boolean {
    if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") return false;
    const name = deploymentName.toLowerCase();
    return !["gpt-5", "o1", "o3", "o4"].some((token) => name.includes(token));
  }

  buildBody(
    messages: Record<string, any>[],
    tools: Record<string, any>[] | null = null,
    model: string | null = null,
    maxTokens = 4096,
    temperature = 0.7,
    reasoningEffort: string | null = null,
    toolChoice: string | Record<string, any> | null = null,
  ): Record<string, any> {
    const deployment = model || this.defaultModel;
    const [instructions, inputItems] = convertMessages(LLMProvider.sanitizeEmptyContent(messages));
    const body: Record<string, any> = {
      model: deployment,
      instructions: instructions || null,
      input: inputItems,
      max_output_tokens: Math.max(1, maxTokens),
      store: false,
      stream: false,
    };
    if (AzureOpenAIProvider.supportsTemperature(deployment, reasoningEffort)) body.temperature = temperature;
    if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") {
      body.reasoning = { effort: reasoningEffort };
      body.include = ["reasoning.encrypted_content"];
    }
    if (tools?.length) {
      body.tools = convertTools(tools);
      body.tool_choice = toolChoice || "auto";
    }
    return body;
  }

  static handleError(error: any): LLMResponse {
    const response = error?.response;
    const body = error?.body ?? response?.text ?? error?.message;
    const bodyText = body == null ? "" : typeof body === "string" ? body.trim() : JSON.stringify(body);
    const content = bodyText ? `Error: ${bodyText.slice(0, 500)}` : `Error calling Azure OpenAI: ${error}`;
    const retryAfter = LLMProvider.extractRetryAfterFromHeaders(response?.headers) ?? LLMProvider.extractRetryAfter(content);
    return new LLMResponse({ content, finishReason: "error", retryAfter });
  }

  handleError(error: any): LLMResponse {
    return AzureOpenAIProvider.handleError(error);
  }

  async chat(
    argsOrMessages:
      | {
          messages: Record<string, any>[];
          tools?: Record<string, any>[] | null;
          model?: string | null;
          maxTokens?: number;
          temperature?: number;
          reasoningEffort?: string | null;
          toolChoice?: string | Record<string, any> | null;
          signal?: AbortSignal | null;
        }
      | Record<string, any>[],
    tools: Record<string, any>[] | null = null,
    model: string | null = null,
    maxTokens = 4096,
    temperature = 0.7,
    reasoningEffort: string | null = null,
    toolChoice: string | Record<string, any> | null = null,
  ): Promise<LLMResponse> {
    const args = Array.isArray(argsOrMessages)
      ? { messages: argsOrMessages, tools, model, maxTokens, temperature, reasoningEffort, toolChoice }
      : argsOrMessages;
    const body = this.buildBody(
      args.messages,
      args.tools ?? null,
      args.model ?? null,
      args.maxTokens ?? 4096,
      args.temperature ?? 0.7,
      args.reasoningEffort ?? null,
      args.toolChoice ?? null,
    );
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const response = options
        ? await this.client.responses.create(body, options as any)
        : await this.client.responses.create(body);
      return parseResponseOutput(response);
    } catch (error) {
      if (isProviderAbortError(error)) throw error;
      return this.handleError(error);
    }
  }

  async chatStream(
    argsOrMessages:
      | {
          messages: Record<string, any>[];
          tools?: Record<string, any>[] | null;
          model?: string | null;
          maxTokens?: number;
          temperature?: number;
          reasoningEffort?: string | null;
          toolChoice?: string | Record<string, any> | null;
          onContentDelta?: (delta: string) => Promise<void> | void;
          onThinkingDelta?: (delta: string) => Promise<void> | void;
          onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
          signal?: AbortSignal | null;
        }
      | Record<string, any>[],
    tools: Record<string, any>[] | null = null,
    model: string | null = null,
    maxTokens = 4096,
    temperature = 0.7,
    reasoningEffort: string | null = null,
    toolChoice: string | Record<string, any> | null = null,
    onContentDelta: ((delta: string) => Promise<void> | void) | null = null,
    onThinkingDelta: ((delta: string) => Promise<void> | void) | null = null,
    onToolCallDelta: ((delta: Record<string, any>) => Promise<void> | void) | null = null,
  ): Promise<LLMResponse> {
    void onThinkingDelta;
    const args: any = Array.isArray(argsOrMessages)
      ? { messages: argsOrMessages, tools, model, maxTokens, temperature, reasoningEffort, toolChoice, onContentDelta, onToolCallDelta }
      : argsOrMessages;
    const body = this.buildBody(
      args.messages,
      args.tools ?? null,
      args.model ?? null,
      args.maxTokens ?? 4096,
      args.temperature ?? 0.7,
      args.reasoningEffort ?? null,
      args.toolChoice ?? null,
    );
    body.stream = true;
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const stream = options
        ? await this.client.responses.create(body, options as any)
        : await this.client.responses.create(body);
      const [content, toolCalls, finishReason, usage, reasoningContent] = await consumeSdkStream(stream, {
        onContentDelta: args.onContentDelta ?? undefined,
        onToolCallDelta: args.onToolCallDelta ?? undefined,
        signal: args.signal ?? null,
      });
      return new LLMResponse({
        content: content || null,
        toolCalls,
        finishReason,
        usage,
        reasoningContent,
      });
    } catch (error) {
      if (isProviderAbortError(error)) throw error;
      return this.handleError(error);
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }
}
