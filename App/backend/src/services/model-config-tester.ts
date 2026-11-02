/** Model config tester module. */
import type {
  ModelConfigTestInput,
  ModelConfigTestResult,
  ModelEndpointProtocol
} from "@memmy/local-api-contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Contract for model config tester. */
export interface ModelConfigTester {
  test(input: ResolvedModelConfigTestInput): Promise<ModelConfigTestResult>;
}

export type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string; extraHeaders?: Record<string, string> };

export interface CreateHttpModelConfigTesterOptions {
  fetch?: FetchLike;
  now?: () => string;
  timeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const SUCCESS_MESSAGE = "连接成功";
const FALLBACK_ERROR_MESSAGE = "连接测试失败，请检查 API 地址、凭证和模型配置";
const INVALID_SUCCESS_BODY_MESSAGE = "API 返回格式不符合模型列表接口，请检查 API 地址和协议";
const UNSUPPORTED_MESSAGE = "当前 endpoint 协议不支持模型列表连接测试";
const ANTHROPIC_VERSION = "2023-06-01";

type ConnectionProbe = {
  url: string;
  headers: Record<string, string>;
  isValidBody(body: unknown): boolean;
  listedModels?(body: unknown): string[];
  body?: Record<string, unknown>;
};

/** Validate supported chat models with one bounded inference; retain list probes for other capabilities. */
export function createHttpModelConfigTester(options: CreateHttpModelConfigTesterOptions = {}): ModelConfigTester {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    async test(input) {
      const probe = chatProbe(input) ?? listProbe(input);
      if (!probe) return result(false, UNSUPPORTED_MESSAGE, now);
      try {
        const response = await fetchImpl(probe.url, {
          method: probe.body ? "POST" : "GET",
          headers: probe.headers,
          ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          const errorMessage = redactProbeSecrets(await readErrorMessage(response, Boolean(probe.body)), input);
          return result(
            false,
            response.status === 404 && !probe.body
              ? appendBaseUrlGuidance(errorMessage, input.protocol)
              : errorMessage,
            now
          );
        }

        const body = await readJsonSafely(response);
        const providerError = extractErrorMessage(body);
        if (providerError) {
          return result(false, redactProbeSecrets(providerError, input), now);
        }
        if (!probe.isValidBody(body)) {
          return result(false, probe.body
            ? "API 未返回有效的聊天响应，请检查 API 地址、模型和协议"
            : appendBaseUrlGuidance(INVALID_SUCCESS_BODY_MESSAGE, input.protocol), now);
        }

        const modelListed = probe.listedModels?.(body).some((model) => model === input.modelId);
        return result(true, SUCCESS_MESSAGE, now, modelListed);
      } catch (error) {
        return result(false, redactProbeSecrets(normalizeThrownError(error), input), now);
      }
    }
  };
}

// Do not infer chat availability from /models: compatible gateways may not expose it.
function chatProbe(input: ResolvedModelConfigTestInput): ConnectionProbe | null {
  if (input.capability && input.capability !== "chat") return null;
  const messages = [{ role: "user", content: "Reply briefly with OK." }];
  if (input.protocol === "openai-chat-completions") {
    // Modern OpenAI reasoning models use max_completion_tokens. Other compatible
    // providers still accept max_tokens; do not retry paid inference automatically.
    const modernTokens = input.provider === "doubao"
      || /(?:^|\/)(?:gpt-[56]|o[134])(?:[-.\/]|$)/iu.test(input.modelId);
    return {
      url: resourceUrl(input.apiBase, "chat/completions"),
      headers: probeHeaders({ "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}) }, input.extraHeaders),
      body: { model: input.modelId, messages, stream: false,
        [modernTokens ? "max_completion_tokens" : "max_tokens"]: 64 },
      isValidBody(body) {
        return records(record(body).choices).some(choice => {
          const message = record(choice.message);
          return message.role === "assistant" && (typeof message.content === "string"
            || typeof message.refusal === "string"
            || (message.content === null && choice.finish_reason === "length"));
        });
      }
    };
  }
  if (input.protocol === "anthropic-messages") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1").replace(/\/models$/u, "/messages"),
      headers: probeHeaders({ "Content-Type": "application/json",
        ...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
        "anthropic-version": ANTHROPIC_VERSION }, input.extraHeaders),
      body: { model: input.modelId, messages, max_tokens: 64, stream: false },
      isValidBody(body) {
        const value = record(body);
        return value.type === "message" && value.role === "assistant" && Array.isArray(value.content)
          && (value.content.some(item => record(item).type === "text" && typeof record(item).text === "string")
            || (value.content.length === 0 && value.stop_reason === "max_tokens"));
      }
    };
  }
  return null;
}

function listProbe(input: ResolvedModelConfigTestInput): ConnectionProbe | null {
  if (input.protocol === "anthropic-messages") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1"),
      headers: probeHeaders({
        ...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
        "anthropic-version": ANTHROPIC_VERSION
      }, input.extraHeaders),
      isValidBody: isAnthropicModelsBody,
      listedModels: anthropicModelIds
    };
  }
  if (input.protocol === "gemini-generate-content") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1beta"),
      headers: probeHeaders(input.apiKey ? { "x-goog-api-key": input.apiKey } : {}, input.extraHeaders),
      isValidBody: isGoogleModelsBody,
      listedModels: googleModelIds
    };
  }
  if (supportsOpenAiModelList(input.protocol)) {
    return {
      url: resourceUrl(input.apiBase, "models"),
      headers: probeHeaders(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}, input.extraHeaders),
      isValidBody: isOpenAiModelsBody,
      listedModels: openAiModelIds
    };
  }
  return null;
}

function probeHeaders(defaults: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...defaults };
  for (const [key, value] of Object.entries(extra)) {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
    headers[key] = value;
  }
  return headers;
}

function redactProbeSecrets(message: string, input: ResolvedModelConfigTestInput): string {
  for (const secret of [input.apiKey, ...Object.values(input.extraHeaders ?? {})]) message = redactSecret(message, secret);
  return message;
}

function supportsOpenAiModelList(protocol: ModelEndpointProtocol): boolean {
  return protocol === "openai-chat-completions"
    || protocol === "openai-responses"
    || protocol === "openai-embeddings"
    || protocol === "openai-images";
}

function isOpenAiModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).data);
}

function isAnthropicModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).data);
}

function isGoogleModelsBody(body: unknown): boolean {
  return Array.isArray(record(body).models);
}

function openAiModelIds(body: unknown): string[] {
  return records(record(body).data).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
}

function anthropicModelIds(body: unknown): string[] {
  return records(record(body).data).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
}

function googleModelIds(body: unknown): string[] {
  return records(record(body).models).flatMap((item) => {
    if (typeof item.name !== "string") return [];
    return [item.name.replace(/^models\//u, "")];
  });
}

function versionedModelsUrl(apiBase: string, version: "v1" | "v1beta"): string {
  const base = apiBase.replace(/\/+$/u, "");
  return base.endsWith(`/${version}`)
    ? `${base}/models`
    : `${base}/${version}/models`;
}

function resourceUrl(apiBase: string, resource: string): string {
  return `${apiBase.replace(/\/+$/u, "")}/${resource}`;
}

function baseUrlGuidance(protocol: ModelEndpointProtocol): string {
  if (protocol === "anthropic-messages") {
    return "Anthropic API 地址通常不包含 /v1，例如 https://api.anthropic.com";
  }
  if (protocol === "gemini-generate-content") return "";
  if (
    protocol === "openai-chat-completions"
    || protocol === "openai-responses"
    || protocol === "openai-embeddings"
    || protocol === "openai-images"
  ) {
    return "OpenAI 兼容 API 地址通常以 /v1 结尾，例如 https://api.openai.com/v1";
  }
  return "";
}

function appendBaseUrlGuidance(message: string, protocol: ModelEndpointProtocol): string {
  const hint = baseUrlGuidance(protocol);
  if (!hint) return message;
  return `${message.replace(/[。\.\s]+$/u, "")}。${hint}`;
}

function result(
  ok: boolean,
  message: string,
  now: () => string,
  modelListed?: boolean
): ModelConfigTestResult {
  return {
    ok,
    message: message.trim() || FALLBACK_ERROR_MESSAGE,
    checkedAt: now(),
    ...(modelListed === undefined ? {} : { modelListed })
  };
}

async function readErrorMessage(response: Response, chat: boolean): Promise<string> {
  const message = extractErrorMessage(await readJsonSafely(response));
  if (!chat) return message ?? `${FALLBACK_ERROR_MESSAGE}（HTTP ${response.status}）`;
  const hint = response.status === 401 || response.status === 403
    ? "认证或访问被拒绝，请检查 API Key 和访问权限"
    : response.status === 404 ? "未找到聊天接口或模型，请检查 API 地址、模型名称和协议"
    : response.status === 429 ? "服务拒绝了本次请求，请检查调用限额或稍后重试"
    : "聊天测试请求失败";
  return `${hint}（HTTP ${response.status}）${message ? `：${message}` : ""}`;
}

function normalizeThrownError(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK_ERROR_MESSAGE;
  if (error.name === "TimeoutError" || /timeout|aborted?/iu.test(error.message)) {
    return "连接超时，请检查 API 地址或网络";
  }
  return error.message || FALLBACK_ERROR_MESSAGE;
}

function extractErrorMessage(body: unknown): string | null {
  const value = record(body);
  if (typeof value.error === "string") return value.error;
  const error = record(value.error);
  if (typeof error.message === "string") return error.message;
  return typeof value.message === "string" ? value.message : null;
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
