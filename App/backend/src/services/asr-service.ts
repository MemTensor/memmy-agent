/** Asr service module. */
import {
  AsrTranscriptionResponseSchema,
  type AppSettingsDto,
  type AsrTranscriptionInput,
  type AsrTranscriptionResponse
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { AsrRuntimeConfig, ModelConfigRepository } from "../infrastructure/app-state-store/repositories/model-config-repo.js";

export interface AsrService {
  transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResponse>;
}

export interface CreateAsrServiceOptions {
  /** Bootstrap repository. */
  bootstrapRepository: Pick<BootstrapRepository, "getAppSettings"> | { getAppSettings(): Pick<AppSettingsDto, "userMode"> };
  /** Account session repository. */
  accountSessionRepository?: Pick<AccountSessionRepository, "getCloudUuid">;
  /** Model config repository. */
  modelConfigRepository?: Pick<ModelConfigRepository, "getAsrRuntimeConfig">;
  /** Cloud client. */
  cloudClient: Pick<CloudClient, "transcribeAudio">;
  /** Fetch. */
  fetch?: typeof fetch;
  /** Now. */
  now?: () => string;
  /** Timeout ms. */
  timeoutMs?: number;
}

const DEFAULT_ASR_TIMEOUT_MS = 30_000;

/** Creates create asr service. */
export function createAsrService(options: CreateAsrServiceOptions): AsrService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async transcribe(input) {
      const userMode = options.bootstrapRepository.getAppSettings().userMode;
      if (userMode === "account") {
        return transcribeWithAccount(input, options, now);
      }

      if (userMode === "byok") {
        return transcribeWithByok(input, requireByokAsrConfig(options), fetchImpl, timeoutMs, now);
      }

      throw Object.assign(new Error("ASR requires account or BYOK mode"), { code: "invalid_argument" as const });
    }
  };
}

/** Handles transcribe with account. */
async function transcribeWithAccount(
  input: AsrTranscriptionInput,
  options: CreateAsrServiceOptions,
  now: () => string
): Promise<AsrTranscriptionResponse> {
  const uuid = options.accountSessionRepository?.getCloudUuid();
  if (!uuid) {
    throw Object.assign(new Error("Cloud account is not authenticated"), { code: "unauthorized" as const });
  }

  const result = await options.cloudClient.transcribeAudio({
    uuid,
    audioBase64: input.audioBase64,
    mimeType: input.mimeType,
    durationMs: input.durationMs
  });

  return AsrTranscriptionResponseSchema.parse({
    text: result.text,
    modelId: result.modelId,
    provider: result.provider,
    source: "account",
    transcribedAt: now()
  });
}

/** Handles transcribe with byok. */
async function transcribeWithByok(
  input: AsrTranscriptionInput,
  config: AsrRuntimeConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => string
): Promise<AsrTranscriptionResponse> {
  const response = await fetchImpl(toChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.modelId,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: toAudioDataUrl(input)
              }
            }
          ]
        }
      ],
      asr_options: {
        enable_itn: false
      }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await readDashScopeTranscript(response);
  return AsrTranscriptionResponseSchema.parse({
    text,
    modelId: config.modelId,
    provider: config.provider,
    source: "byok",
    transcribedAt: now()
  });
}

/**
 * Reads the BYOK ASR config.
 *
 * @param options Service dependencies.
 * @returns The BYOK ASR runtime config.
 */
function requireByokAsrConfig(options: CreateAsrServiceOptions): AsrRuntimeConfig {
  if (!options.modelConfigRepository) {
    throw Object.assign(new Error("ASR model config repository is not configured"), { code: "invalid_argument" as const });
  }

  return options.modelConfigRepository.getAsrRuntimeConfig();
}

/**
 * Builds the DashScope chat completions endpoint.
 *
 * @param baseUrl The OpenAI-compatible base URL configured by the user.
 * @returns The full chat completions URL.
 */
function toChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Builds the audio data URL.
 *
 * @param input Audio transcription input.
 * @returns The DashScope input_audio.data field.
 */
function toAudioDataUrl(input: AsrTranscriptionInput): string {
  return `data:${input.mimeType};base64,${input.audioBase64}`;
}

/**
 * Parses the DashScope qwen3-asr-flash response.
 *
 * @param response Fetch response.
 * @returns The transcribed text.
 */
async function readDashScopeTranscript(response: Response): Promise<string> {
  const value = await readJson(response);
  if (!response.ok) {
    throw Object.assign(new Error(readErrorMessage(value) ?? `ASR request failed with HTTP ${response.status}`), {
      code: classifyHttpError(response.status)
    });
  }

  const text = readChoiceMessageContent(value);
  if (text === null) {
    throw Object.assign(new Error("ASR response missing transcript text"), { code: "internal" as const });
  }

  return text;
}

/**
 * Safely reads a JSON response.
 *
 * @param response Fetch response.
 * @returns The JSON object, or null.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Reads the text from a DashScope response.
 *
 * @param value JSON response.
 * @returns choices[0].message.content; returns null when missing.
 */
function readChoiceMessageContent(value: unknown): string | null {
  const record = asRecord(value);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  return typeof message.content === "string" ? message.content : null;
}

/**
 * Reads the upstream error message.
 *
 * @param value JSON response.
 * @returns The upstream message; returns null when missing.
 */
function readErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  const error = asRecord(record.error);
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return typeof record.message === "string" && record.message.trim() ? record.message : null;
}

/**
 * Classifies a local error by HTTP status code.
 *
 * @param status HTTP status code.
 * @returns The local error code.
 */
function classifyHttpError(status: number): "invalid_argument" | "unauthorized" | "forbidden" | "rate_limited" | "internal" {
  if (status === 400 || status === 422) return "invalid_argument";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "internal";
}

/**
 * Treats an unknown value as a plain object.
 *
 * @param value Unknown value.
 * @returns A record; returns an empty object when not an object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
