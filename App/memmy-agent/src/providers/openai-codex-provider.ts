import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { createProviderAbortError, isProviderAbortError, LLMProvider, LLMResponse, ToolCallRequest } from "./base.js";
import { consumeSdkStream, convertMessages, convertTools, iterSse } from "./openai-responses/index.js";

export const DEFAULT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_ORIGINATOR = "memmy-agent";
export const CODEX_TOKEN_FILENAME = "codex.json";

export type CodexToken = { accountId?: string; account_id?: string; access?: string; accessToken?: string; expires?: number };

export class CodexTokenStorage {
  tokenPath: string;

  constructor(tokenPath: string = codexTokenPath()) {
    this.tokenPath = tokenPath;
  }

  getTokenPath(): string {
    return this.tokenPath;
  }

  load(): CodexToken | null {
    try {
      if (!fs.existsSync(this.tokenPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  save(token: CodexToken): void {
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  }
}

export function codexTokenPath(): string {
  return (
    process.env.OAUTH_CLI_KIT_TOKEN_PATH ??
    process.env.OPENAI_CODEX_TOKEN_PATH ??
    process.env.CHATGPT_TOKEN_PATH ??
    path.join(getDataDir(), "auth", CODEX_TOKEN_FILENAME)
  );
}

export function getCodexStorage(): CodexTokenStorage {
  return new CodexTokenStorage();
}

function loadStoredCodexToken(): CodexToken | null {
  const token = getCodexStorage().load();
  const accountId = token?.accountId ?? token?.account_id;
  const access = token?.access ?? token?.accessToken;
  return accountId && access ? token : null;
}

export const logger = {
  warning: (...args: any[]) => {
    console.warn(...args);
  },
};

export class CodexHTTPError extends Error {
  statusCode: number | null;
  retryAfter: number | null;
  errorType: string | null;
  errorCode: string | null;
  shouldRetry: boolean | null;

  constructor(
    message: string,
    init: {
      statusCode?: number | null;
      retryAfter?: number | null;
      errorType?: string | null;
      errorCode?: string | null;
      shouldRetry?: boolean | null;
    } = {},
  ) {
    super(message);
    this.name = "CodexHTTPError";
    this.statusCode = init.statusCode ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.errorType = init.errorType ?? null;
    this.errorCode = init.errorCode ?? null;
    this.shouldRetry = init.shouldRetry ?? null;
  }
}

export class OpenAICodexProvider extends LLMProvider {
  static override supportsProgressDeltas = true;

  defaultModel: string;
  getToken: (() => Promise<CodexToken> | CodexToken) | null;
  codexUrl: string;

  constructor(
    init:
      | string
      | {
          defaultModel?: string | null;
          getToken?: (() => Promise<CodexToken> | CodexToken) | null;
          codexUrl?: string | null;
        }
      | null = null,
  ) {
    super(null, null);
    if (init && typeof init === "object") {
      this.defaultModel = init.defaultModel ?? "openai-codex/gpt-5.1-codex";
      this.getToken = init.getToken ?? null;
      this.codexUrl = init.codexUrl ?? DEFAULT_CODEX_URL;
    } else {
      this.defaultModel = init ?? "openai-codex/gpt-5.1-codex";
      this.getToken = null;
      this.codexUrl = DEFAULT_CODEX_URL;
    }
  }

  async resolveToken(): Promise<{ accountId: string; access: string }> {
    const provided = this.getToken ? await this.getToken() : null;
    const stored = provided ? null : loadStoredCodexToken();
    const accountId =
      provided?.accountId ??
      provided?.account_id ??
      stored?.accountId ??
      stored?.account_id ??
      process.env.OPENAI_CODEX_ACCOUNT_ID ??
      process.env.CHATGPT_ACCOUNT_ID ??
      "";
    const access =
      provided?.access ??
      provided?.accessToken ??
      stored?.access ??
      stored?.accessToken ??
      process.env.OPENAI_CODEX_ACCESS_TOKEN ??
      process.env.CHATGPT_ACCESS_TOKEN ??
      "";
    if (!accountId || !access) {
      throw new Error("OpenAI Codex provider requires an OAuth account id and access token.");
    }
    return { accountId, access };
  }

  async callCodex(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
    onContentDelta?: (delta: string) => Promise<void> | void;
    onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
    signal?: AbortSignal | null;
  }): Promise<LLMResponse> {
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      const model = args.model ?? this.defaultModel;
      const [instructions, input] = convertMessages(args.messages);
      const token = await this.resolveToken();
      const body: Record<string, any> = {
        model: stripModelPrefix(model),
        store: false,
        stream: true,
        instructions,
        input,
        text: { verbosity: "medium" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: promptCacheKey(args.messages.slice(0, 2)),
        tool_choice: args.toolChoice ?? "auto",
        parallel_tool_calls: true,
      };
      const reasoningEffort = args.reasoningEffort;
      if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") body.reasoning = { effort: reasoningEffort };
      if (args.tools?.length) body.tools = convertTools(args.tools);

      const [content, toolCalls, finishReason, usage, reasoningContent] = await requestCodex(
        this.codexUrl,
        buildHeaders(token.accountId, token.access),
        body,
        {
          onContentDelta: args.onContentDelta,
          onToolCallDelta: args.onToolCallDelta,
          signal: args.signal ?? null,
        },
      );
      return new LLMResponse({ content, toolCalls, finishReason, usage, reasoningContent });
    } catch (error) {
      if (isProviderAbortError(error)) throw error;
      const response = codexErrorResponse(error);
      const excType = codexErrorTypeName(error);
      logger.warning(
        "Codex API request failed: type={} kind={} retryable={} status={} errorType={} errorCode={} retryAfter={} summary={}",
        excType,
        response.errorKind,
        response.errorShouldRetry,
        response.errorStatusCode,
        response.errorType,
        response.errorCode,
        response.retryAfter,
        codexLogSummary(excType, response),
      );
      return response;
    }
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
    void args.maxTokens;
    void args.temperature;
    return this.callCodex(args);
  }

  override async chatStream(args: Parameters<LLMProvider["chat"]>[0] & {
    onContentDelta?: (delta: string) => Promise<void> | void;
    onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
  }): Promise<LLMResponse> {
    return this.callCodex(args);
  }

  override getDefaultModel(): string {
    return this.defaultModel;
  }
}

export function stripModelPrefix(model: string): string {
  return model.replace(/^(codex|openai[-_]codex)\//, "");
}

export function buildHeaders(accountId: string, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: DEFAULT_ORIGINATOR,
    "User-Agent": "memmy-agent (typescript)",
    accept: "text/event-stream",
    "content-type": "application/json",
  };
}

export async function requestCodex(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  callbacks: {
    onContentDelta?: (delta: string) => Promise<void> | void;
    onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
    signal?: AbortSignal | null;
  } = {},
): Promise<[string | null, ToolCallRequest[], string, Record<string, any>, string | null]> {
  if (callbacks.signal?.aborted) throw createProviderAbortError();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: callbacks.signal ?? undefined });
  if (!response.ok) {
    const raw = await response.text();
    const retryAfter = LLMProvider.extractRetryAfterFromHeaders(response.headers);
    const [errorType, errorCode] = LLMProvider.extractErrorTypeCode(raw);
    throw new CodexHTTPError(friendlyError(response.status, raw), {
      statusCode: response.status,
      retryAfter,
      errorType,
      errorCode,
      shouldRetry: shouldRetryStatus(response.status, errorType, errorCode, raw),
    });
  }
  const [content, toolCalls, finishReason, usage, reasoningContent] = await consumeSdkStream(iterSse(response), callbacks);
  return [content || null, toolCalls, finishReason, usage, reasoningContent];
}

export function promptCacheKey(messages: Record<string, any>[]): string {
  return crypto.createHash("sha256").update(stableStringify(messages)).digest("hex");
}

export function friendlyError(statusCode: number, raw = ""): string {
  void raw;
  if (statusCode === 429) return "ChatGPT usage quota exceeded or rate limit triggered. Please try again later.";
  return `HTTP ${statusCode}: Codex API request failed`;
}

function codexErrorTypeName(error: any): string {
  if (error instanceof CodexHTTPError) return "CodexHTTPError";
  return error?.constructor?.name ?? error?.name ?? "Error";
}

export function codexErrorResponse(error: any): LLMResponse {
  const isCodexHttp = error instanceof CodexHTTPError;
  const typeName = codexErrorTypeName(error);
  const statusCode = error?.statusCode ?? null;
  let errorKind: string | null = null;
  let shouldRetry = error?.shouldRetry ?? null;
  const messageText = String(error?.message ?? error ?? "").trim();
  let defaultDetail: string | null = null;

  if (/timeout|timed out/i.test(typeName) || /timeout|timed out/i.test(messageText)) {
    errorKind = "timeout";
    defaultDetail = "timed out waiting for response";
    if (shouldRetry == null) shouldRetry = true;
  } else if (/remoteprotocol/i.test(typeName)) {
    errorKind = "connection";
    defaultDetail = "network protocol error while reading response";
    if (shouldRetry == null) shouldRetry = true;
  } else if (/network|transport|protocol|connection/i.test(typeName) || /network|connection|protocol/i.test(messageText)) {
    errorKind = "connection";
    defaultDetail = "network connection failed";
    if (shouldRetry == null) shouldRetry = true;
  } else if (isCodexHttp) {
    errorKind = "http";
    defaultDetail = "HTTP request failed";
  }
  if (statusCode != null && shouldRetry == null) {
    shouldRetry = shouldRetryStatus(Number(statusCode), error.errorType, error.errorCode, statusCode === 429 ? null : messageText);
  }
  const content = `Error calling Codex (${typeName}): ${messageText || defaultDetail || "unexpected error"}`;
  const retryAfter = error?.retryAfter ?? LLMProvider.extractRetryAfter(content);
  return new LLMResponse({
    content,
    finishReason: "error",
    retryAfter,
    errorStatusCode: statusCode == null ? null : Number(statusCode),
    errorKind,
    errorType: error?.errorType ?? null,
    errorCode: error?.errorCode ?? null,
    errorRetryAfterS: retryAfter,
    errorShouldRetry: shouldRetry,
  });
}

export function codexLogSummary(typeName: string, response: LLMResponse): string {
  if (response.errorStatusCode != null) {
    const parts = [`HTTP ${response.errorStatusCode}`];
    if (response.errorType) parts.push(`type=${response.errorType}`);
    if (response.errorCode) parts.push(`code=${response.errorCode}`);
    return parts.join(" ");
  }
  return response.errorKind ? `${typeName} ${response.errorKind}` : typeName;
}

export function shouldRetryStatus(statusCode: number, errorType: string | null, errorCode: string | null, content: string | null): boolean {
  if (statusCode === 429) {
    return LLMProvider.isRetryable429Response(
      new LLMResponse({
        content: content ?? "",
        finishReason: "error",
        errorStatusCode: statusCode,
        errorType,
        errorCode,
      }),
    );
  }
  return new Set([408, 409, 429]).has(statusCode) || statusCode >= 500;
}

function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
