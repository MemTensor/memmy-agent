/** Model config tester module. */
import type {
  ModelConfigTestInput,
  ModelConfigTestResult,
  ModelEndpointProtocol,
  ModelProvider
} from "@memmy/local-api-contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Contract for model config tester. */
export interface ModelConfigTester {
  test(input: ResolvedModelConfigTestInput): Promise<ModelConfigTestResult>;
}

type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

export interface CreateHttpModelConfigTesterOptions {
  fetch?: FetchLike;
  now?: () => string;
  timeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const SUCCESS_MESSAGE = "连接成功";
const FALLBACK_ERROR_MESSAGE = "API Key 无效或模型列表不可用";
const INVALID_SUCCESS_BODY_MESSAGE = "API 返回格式不符合模型列表接口，请检查 API 地址和协议";
const UNSUPPORTED_MESSAGE = "当前 endpoint 协议不支持模型列表连接测试";
const ANTHROPIC_VERSION = "2023-06-01";

type ListProbe = {
  url: string;
  headers: Record<string, string>;
  isValidBody(body: unknown): boolean;
  listedModels(body: unknown): string[];
};

/** Creates an HTTP tester that only reads model-list endpoints. */
export function createHttpModelConfigTester(options: CreateHttpModelConfigTesterOptions = {}): ModelConfigTester {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    async test(input) {
      const probe = listProbe(input);
      if (!probe) return result(false, UNSUPPORTED_MESSAGE, now);
      try {
        const response = await fetchImpl(probe.url, {
          method: "GET",
          headers: probe.headers,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          const errorMessage = redactSecret(await readErrorMessage(response), input.apiKey);
          return result(
            false,
            response.status === 404
              ? appendBaseUrlGuidance(errorMessage, input.provider)
              : errorMessage,
            now
          );
        }

        const body = await readJsonSafely(response);
        const providerError = extractErrorMessage(body);
        if (providerError) {
          return result(false, redactSecret(providerError, input.apiKey), now);
        }
        if (!probe.isValidBody(body)) {
          return result(false, appendBaseUrlGuidance(INVALID_SUCCESS_BODY_MESSAGE, input.provider), now);
        }

        const modelListed = probe.listedModels(body).some((model) => model === input.modelId);
        return result(true, SUCCESS_MESSAGE, now, modelListed);
      } catch (error) {
        return result(false, redactSecret(normalizeThrownError(error), input.apiKey), now);
      }
    }
  };
}

function listProbe(input: ResolvedModelConfigTestInput): ListProbe | null {
  if (input.protocol === "anthropic-messages") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1"),
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      isValidBody: isAnthropicModelsBody,
      listedModels: anthropicModelIds
    };
  }
  if (input.protocol === "gemini-generate-content") {
    return {
      url: versionedModelsUrl(input.apiBase, "v1beta"),
      headers: { "x-goog-api-key": input.apiKey },
      isValidBody: isGoogleModelsBody,
      listedModels: googleModelIds
    };
  }
  if (supportsOpenAiModelList(input.protocol)) {
    return {
      url: resourceUrl(input.apiBase, "models"),
      headers: { Authorization: `Bearer ${input.apiKey}` },
      isValidBody: isOpenAiModelsBody,
      listedModels: openAiModelIds
    };
  }
  return null;
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

function baseUrlGuidance(provider: ModelProvider): string {
  if (provider === "anthropic") {
    return "Anthropic API 地址通常不包含 /v1，例如 https://api.anthropic.com";
  }
  if (provider === "google") return "";
  return "OpenAI 兼容 API 地址通常以 /v1 结尾，例如 https://api.openai.com/v1";
}

function appendBaseUrlGuidance(message: string, provider: ModelProvider): string {
  const hint = baseUrlGuidance(provider);
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

async function readErrorMessage(response: Response): Promise<string> {
  const message = extractErrorMessage(await readJsonSafely(response));
  return message ?? `${FALLBACK_ERROR_MESSAGE}（HTTP ${response.status}）`;
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
