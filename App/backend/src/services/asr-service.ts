/** Asr service module. */
import {
  AsrTranscriptionResponseSchema,
  type ActualModelContext,
  type AppSettingsDto,
  type AsrTranscriptionInput,
  type AsrTranscriptionResponse,
  type ResolvedProviderSnapshot
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";

export interface AsrService {
  transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResponse>;
}

export interface CreateAsrServiceOptions {
  /** Bootstrap repository. */
  bootstrapRepository: Pick<BootstrapRepository, "getAppSettings"> | { getAppSettings(): Pick<AppSettingsDto, "userMode"> };
  /** Account session repository. */
  accountSessionRepository?: Pick<AccountSessionRepository, "get" | "getCloudUuid">;
  /** Current YAML model catalog reader. */
  memmyConfigWriter?: Pick<MemmyConfigWriter, "resolveAssignedModel">;
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
      if (userMode !== "account" && userMode !== "byok") {
        throw Object.assign(new Error("ASR requires account or BYOK mode"), { code: "invalid_argument" as const });
      }
      const resolved = await requireAsrSelection(options, userMode);
      if (resolved.context.source === "account") {
        return transcribeWithAccount(input, options, resolved.context, now);
      }
      if (resolved.context.protocol !== "dashscope-input-audio-chat") {
        throw modelSelectionUnavailable(resolved.context);
      }
      return transcribeWithByok(
        input,
        resolved.context,
        resolved.provider,
        fetchImpl,
        timeoutMs,
        now
      );
    }
  };
}

/** Handles transcribe with account. */
async function transcribeWithAccount(
  input: AsrTranscriptionInput,
  options: CreateAsrServiceOptions,
  context: Readonly<ActualModelContext>,
  now: () => string
): Promise<AsrTranscriptionResponse> {
  const uuid = options.accountSessionRepository?.getCloudUuid();
  if (!uuid) {
    throw Object.assign(new Error("Cloud account is not authenticated"), { code: "unauthorized" as const });
  }

  let result: Awaited<ReturnType<CloudClient["transcribeAudio"]>>;
  try {
    result = await options.cloudClient.transcribeAudio({
      uuid,
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      durationMs: input.durationMs
    });
  } catch (error) {
    throw withActualModelContext(error, context);
  }

  return AsrTranscriptionResponseSchema.parse({
    text: result.text,
    modelId: context.model,
    provider: context.provider,
    source: context.source,
    transcribedAt: now()
  });
}

/** Handles transcribe with byok. */
async function transcribeWithByok(
  input: AsrTranscriptionInput,
  context: Readonly<ActualModelContext>,
  provider: Readonly<ResolvedProviderSnapshot>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => string
): Promise<AsrTranscriptionResponse> {
  const response = await fetchImpl(toChatCompletionsUrl(provider.apiBase), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...provider.extraHeaders
    },
    body: JSON.stringify({
      model: context.model,
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
      },
      ...provider.extraBody
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await readDashScopeTranscript(response, context);
  return AsrTranscriptionResponseSchema.parse({
    text,
    modelId: context.model,
    provider: context.provider,
    source: context.source,
    transcribedAt: now()
  });
}

/**
 * Reads the BYOK ASR config.
 *
 * @param options Service dependencies.
 * @returns The BYOK ASR runtime config.
 */
async function requireAsrSelection(
  options: CreateAsrServiceOptions,
  mode: "account" | "byok"
) {
  const resolver = options.memmyConfigWriter?.resolveAssignedModel;
  if (!resolver) {
    throw Object.assign(new Error("ASR model catalog is not configured"), { code: "invalid_argument" as const });
  }
  const session = options.accountSessionRepository?.get();
  const activeAccountId = session?.authenticated ? session.profile.userId : null;
  const resolved = await resolver({ mode, activeAccountId, capability: "asr" });
  if (!resolved.ok) throw modelSelectionUnavailable();
  return resolved;
}

function modelSelectionUnavailable(context?: Readonly<ActualModelContext>): Error {
  return Object.assign(new Error("Assigned ASR model is unavailable"), {
    code: "model_selection_unavailable" as const,
    ...(context ? { actualModelContext: context } : {})
  });
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
async function readDashScopeTranscript(
  response: Response,
  context: Readonly<ActualModelContext>
): Promise<string> {
  const value = await readJson(response);
  if (!response.ok) {
    throw withActualModelContext(Object.assign(
      new Error(readErrorMessage(value) ?? `ASR request failed with HTTP ${response.status}`),
      { code: classifyHttpError(response.status) }
    ), context);
  }

  const text = readChoiceMessageContent(value);
  if (text === null) {
    throw Object.assign(new Error("ASR response missing transcript text"), { code: "internal" as const });
  }

  return text;
}

function withActualModelContext(
  error: unknown,
  context: Readonly<ActualModelContext>
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return Object.assign(normalized, { actualModelContext: context });
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
