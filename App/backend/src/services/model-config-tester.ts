/** Model config tester module. */
import type { ModelConfigTestInput, ModelConfigTestResult, ModelProvider } from "@memmy/local-api-contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Contract for model config tester. */
export interface ModelConfigTester {
  test(input: ResolvedModelConfigTestInput): Promise<ModelConfigTestResult>;
}

/** Type definition for resolved model config test input. */
type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

/** Contract for create http model config tester options. */
export interface CreateHttpModelConfigTesterOptions {
  fetch?: FetchLike;
  now?: () => string;
  timeoutMs?: number;
}

// Aggregation gateways (e.g. new-api) can take 2-13 seconds to return the first
// non-streaming reasoning response, and sometimes >30 seconds when slow. A 60-second
// probe timeout separates "slow gateway" from "unreachable address/network" and reduces
// false connection-timeout reports for slow gateways.
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const SUCCESS_MESSAGE = "连接成功";
const FALLBACK_ERROR_MESSAGE = "API Key 无效或模型不可用";
const INVALID_SUCCESS_BODY_MESSAGE = "API 返回格式不符合模型接口，请检查 API 地址是否包含正确版本路径";
const ANTHROPIC_VERSION = "2023-06-01";
const ASR_PROBE_AUDIO_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3";

/** Creates create http model config tester. */
export function createHttpModelConfigTester(options: CreateHttpModelConfigTesterOptions = {}): ModelConfigTester {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    async test(input) {
      try {
        const response = await runProbe(fetchImpl, input, timeoutMs);
        if (response.ok) {
          const successBodyError = await validateSuccessfulProbeResponse(response, input);
          if (successBodyError) {
            // Guidance is our own secret-free constant, appended after redaction so a short apiKey
            // (e.g. "1") cannot mangle the hint's own /v1 example.
            const guided = appendBaseUrlGuidance(redactSecret(successBodyError, input.apiKey), input.provider);
            return result(false, guided, now);
          }

          return result(true, SUCCESS_MESSAGE, now);
        }

        const errorMessage = redactSecret(await readErrorMessage(response), input.apiKey);
        const guidedMessage =
          response.status === 404 ? appendBaseUrlGuidance(errorMessage, input.provider) : errorMessage;
        return result(false, guidedMessage, now);
      } catch (error) {
        return result(false, redactSecret(normalizeThrownError(error), input.apiKey), now);
      }
    }
  };
}

/** Validates validate successful probe response. */
async function validateSuccessfulProbeResponse(response: Response, input: ResolvedModelConfigTestInput): Promise<string | null> {
  const body = await readJsonSafely(response);
  const errorMessage = extractErrorMessage(body);
  if (errorMessage) {
    return errorMessage;
  }

  if (!isExpectedProbeBody(body, input)) {
    return INVALID_SUCCESS_BODY_MESSAGE;
  }

  return null;
}

/**
 * Returns a protocol-specific base URL hint, or an empty string when no actionable hint applies.
 *
 * @param provider Model provider.
 * @returns A user-facing hint sentence.
 */
function baseUrlGuidance(provider: ModelProvider): string {
  if (provider === "anthropic") {
    return "Anthropic API 地址不应包含 /v1，例如 https://api.anthropic.com";
  }

  if (provider === "google") {
    return "";
  }

  return "OpenAI 兼容 API 地址通常以 /v1 结尾，例如 https://api.openai.com/v1";
}

/**
 * Appends the protocol-specific base URL hint to an error message.
 *
 * @param message The base error message.
 * @param provider Model provider.
 * @returns The message with an actionable base URL hint.
 */
function appendBaseUrlGuidance(message: string, provider: ModelProvider): string {
  const hint = baseUrlGuidance(provider);
  if (!hint) {
    return message;
  }

  const trimmed = message.replace(/[。.\s]+$/u, "");
  return `${trimmed}。${hint}`;
}

/** Checks is expected probe body. */
function isExpectedProbeBody(body: unknown, input: ResolvedModelConfigTestInput): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  if (input.capability === "embedding") {
    return isExpectedEmbeddingBody(body, input.provider);
  }

  if (input.capability === "image") {
    return true;
  }

  if (input.provider === "anthropic") {
    return Array.isArray((body as { content?: unknown }).content);
  }

  if (input.provider === "google") {
    return Array.isArray((body as { candidates?: unknown }).candidates);
  }

  return Array.isArray((body as { choices?: unknown }).choices);
}

/** Checks is expected embedding body. */
function isExpectedEmbeddingBody(body: unknown, provider: ModelProvider): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  if (provider === "google") {
    const embedding = (body as { embedding?: { values?: unknown } }).embedding;
    return Boolean(embedding && Array.isArray(embedding.values));
  }

  return Array.isArray((body as { data?: unknown }).data);
}

/** Runs run probe. */
async function runProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  if (input.capability === "embedding") {
    return runEmbeddingProbe(fetchImpl, input, timeoutMs);
  }

  if (input.capability === "asr") {
    return runAsrProbe(fetchImpl, input, timeoutMs);
  }

  if (input.capability === "image") {
    return runImageProbe(fetchImpl, input, timeoutMs);
  }

  if (input.provider === "anthropic") {
    return fetchImpl(endpoint(input.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: input.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  if (input.provider === "google") {
    return fetchImpl(endpoint(input.baseUrl, `/v1beta/models/${encodeURIComponent(input.modelId)}:generateContent`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  return runOpenAiCompatibleProbe(fetchImpl, input, timeoutMs);
}

/**
 * Issues a minimal audio probe request for an ASR model.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
function runAsrProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  return fetchImpl(endpoint(input.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    body: JSON.stringify({
      model: input.modelId,
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: {
            data: ASR_PROBE_AUDIO_URL
          }
        }]
      }],
      stream: false,
      asr_options: {
        enable_itn: false
      }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Issues a lightweight probe request for an image-generation model.
 *
 * Only fetches the models list to verify the endpoint is reachable and authenticated; it does not actually generate an image, to avoid incurring charges.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
function runImageProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  if (input.provider === "google") {
    // The Gemini image base already carries the /v1beta version segment (matching the runtime, which
    // appends /models to the same base), so only the resource path is added here.
    return fetchImpl(endpoint(input.baseUrl, "/models"), {
      method: "GET",
      headers: { "x-goog-api-key": input.apiKey },
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  const base = input.provider === "qwen" ? qwenImageProbeBase(input.baseUrl) : input.baseUrl;
  return fetchImpl(endpoint(base, "/models"), {
    method: "GET",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function qwenImageProbeBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (base.endsWith("/compatible-mode/v1")) {
    return base;
  }
  if (base.endsWith("/api/v1") && isDashScopeWorkspaceBase(base)) {
    return `${base.slice(0, -"/api/v1".length)}/compatible-mode/v1`;
  }
  return base;
}

function isDashScopeWorkspaceBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith(".maas.aliyuncs.com");
  } catch {
    return false;
  }
}

/**
 * Issues a minimal probe request for an Embedding model.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
function runEmbeddingProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  if (input.provider === "google") {
    return fetchImpl(endpoint(input.baseUrl, `/v1beta/models/${encodeURIComponent(input.modelId)}:embedContent`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey
      },
      body: JSON.stringify({
        content: { parts: [{ text: "ping" }] }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  return fetchImpl(endpoint(input.baseUrl, "/embeddings"), {
    method: "POST",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    body: JSON.stringify({
      model: input.modelId,
      input: "ping"
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Issues a minimal OpenAI-compatible chat completion request.
 *
 * Reasoning models (GPT-5 series, o-series) reject max_tokens and require max_completion_tokens,
 * so a rejected max_tokens probe is retried once with the replacement parameter.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @returns The third-party response.
 */
async function runOpenAiCompatibleProbe(fetchImpl: FetchLike, input: ResolvedModelConfigTestInput, timeoutMs: number): Promise<Response> {
  const response = await sendOpenAiCompatibleChatProbe(fetchImpl, input, timeoutMs, "max_tokens");
  if (await isMaxTokensUnsupported(response)) {
    return sendOpenAiCompatibleChatProbe(fetchImpl, input, timeoutMs, "max_completion_tokens");
  }

  return response;
}

/**
 * Sends the chat completion probe with the given output-limit parameter name.
 *
 * @param fetchImpl HTTP client.
 * @param input Model test input.
 * @param timeoutMs Timeout duration.
 * @param tokenLimitParam Output-limit parameter name expected by the target model.
 * @returns The third-party response.
 */
function sendOpenAiCompatibleChatProbe(
  fetchImpl: FetchLike,
  input: ResolvedModelConfigTestInput,
  timeoutMs: number,
  tokenLimitParam: "max_tokens" | "max_completion_tokens"
): Promise<Response> {
  return fetchImpl(chatCompletionsEndpoint(input.baseUrl), {
    method: "POST",
    headers: openAiCompatibleHeaders(input.provider, input.apiKey),
    body: JSON.stringify({
      model: input.modelId,
      messages: [{ role: "user", content: "ping" }],
      // Reasoning tokens consume the output budget first, so the fallback needs enough budget to emit content.
      [tokenLimitParam]: tokenLimitParam === "max_completion_tokens" ? 128 : input.provider === "baidu" ? 64 : 1
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Checks whether the failure response says the model rejects max_tokens.
 *
 * @param response The third-party HTTP response.
 * @returns True when the retry with max_completion_tokens should run.
 */
async function isMaxTokensUnsupported(response: Response): Promise<boolean> {
  if (response.ok || response.status !== 400) {
    return false;
  }

  const message = extractErrorMessage(await readJsonSafely(response.clone()));
  return typeof message === "string" && message.includes("max_tokens") && /unsupported|not supported/iu.test(message);
}

/**
 * Builds the Chat Completions probe URL.
 *
 * Mirrors the OpenAI SDK's runtime behavior exactly (`baseURL` + `/chat/completions`) so the connection
 * test hits the same URL the agent will use at runtime. The address is used verbatim — no version
 * segment is auto-filled. A base that already ends with /chat/completions is kept as-is for the
 * user who pasted the full endpoint.
 *
 * @param baseUrl The API address entered by the user.
 * @returns The full Chat Completions URL.
 */
function chatCompletionsEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (base.endsWith("/chat/completions")) {
    return base;
  }
  return `${base}/chat/completions`;
}

/**
 * Builds OpenAI-compatible request headers.
 *
 * @param provider Model provider.
 * @param apiKey Plaintext API Key.
 * @returns The third-party probe request headers.
 */
function openAiCompatibleHeaders(provider: ModelProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  if (provider === "qwen") {
    headers["dashscope-plugin"] = "memmy";
  }

  return headers;
}

/**
 * Joins the baseUrl and the endpoint path verbatim.
 *
 * The address is used as entered — no version segment is deduplicated. A user who adds a redundant
 * /v1 (e.g. an Anthropic base of https://api.anthropic.com/v1) will probe the same URL the runtime
 * would build and get an actionable error, rather than the tester silently repairing it.
 *
 * @param baseUrl The API address entered by the user.
 * @param path The target endpoint path.
 * @returns The full URL.
 */
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Creates a safe test result.
 *
 * @param ok Whether it succeeded.
 * @param message The display message.
 * @param now Function returning the current time.
 * @returns A test result that does not contain the API Key.
 */
function result(ok: boolean, message: string, now: () => string): ModelConfigTestResult {
  return {
    ok,
    message: message.trim() || FALLBACK_ERROR_MESSAGE,
    checkedAt: now()
  };
}

/**
 * Reads the third-party error message.
 *
 * @param response The third-party HTTP response.
 * @returns A displayable error message.
 */
async function readErrorMessage(response: Response): Promise<string> {
  const body = await readJsonSafely(response);
  const message = extractErrorMessage(body);
  if (message) {
    return message;
  }

  return `${FALLBACK_ERROR_MESSAGE}（HTTP ${response.status}）`;
}

/**
 * Extracts displayable information from an unknown error object.
 *
 * @param error The caught exception.
 * @returns A user-readable error message.
 */
function normalizeThrownError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /timeout|aborted?/iu.test(error.message)) {
      return "连接超时，请检查 API 地址或网络";
    }

    return error.message || FALLBACK_ERROR_MESSAGE;
  }

  return FALLBACK_ERROR_MESSAGE;
}

/**
 * Extracts the error message from the third-party response body.
 *
 * @param body The third-party response JSON.
 * @returns The error message, or null.
 */
function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }

  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * Removes the API Key entered this time from the display message.
 *
 * @param message The original error message.
 * @param secret The API Key entered by the user.
 * @returns The redacted message.
 */
function redactSecret(message: string, secret: string): string {
  if (!secret) {
    return message;
  }

  return message.split(secret).join("[redacted]");
}

/**
 * Reads JSON with fault tolerance.
 *
 * @param response The third-party HTTP response.
 * @returns The JSON body, or null.
 */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
