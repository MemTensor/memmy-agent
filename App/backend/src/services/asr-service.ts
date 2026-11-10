/** Asr service module. */
import { mergeProviderHeaders } from "../shared/provider-headers.js";
import { randomUUID } from "node:crypto";
import {
  AsrTranscriptionResponseSchema,
  canonicalCatalogProviderId,
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

export interface AsrSelectionSnapshot {
  context: Readonly<ActualModelContext>;
  provider: Readonly<ResolvedProviderSnapshot>;
  cloudUuid: string | null;
}

export interface AsrService {
  prepare(): Promise<{ sessionId: string }>;
  getSession(sessionId: string): AsrSelectionSnapshot;
  release(sessionId: string): void;
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

  // Credentials stay in the backend. A recording carries only this opaque ID.
  const sessions = new Map<string, { snapshot: AsrSelectionSnapshot; expiresAt: number }>();
  const resolve = async (): Promise<AsrSelectionSnapshot> => {
    const mode = options.bootstrapRepository.getAppSettings().userMode;
    if (mode !== "account" && mode !== "byok") {
      throw Object.assign(new Error("ASR requires account or BYOK mode"), { code: "invalid_argument" });
    }
    const resolved = await requireAsrSelection(options, mode);
    return structuredClone({ context: resolved.context, provider: resolved.provider,
      cloudUuid: options.accountSessionRepository?.getCloudUuid() ?? null });
  };
  const getSession = (id: string): AsrSelectionSnapshot => {
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(id);
      throw Object.assign(new Error("ASR recording session expired; its model configuration cannot be recovered"), { code: "model_config_changed" });
    }
    return session.snapshot;
  };
  return {
    async prepare() {
      for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
      const snapshot = await resolve();
      if (sessions.size >= 32) throw Object.assign(new Error("Too many active ASR recordings"), { code: "rate_limited" });
      const sessionId = randomUUID();
      sessions.set(sessionId, { snapshot, expiresAt: Date.now() + 3 * 60 * 60 * 1_000 });
      return { sessionId };
    },
    getSession,
    release(id) { sessions.delete(id); },
    async transcribe(input) {
      const resolved = input.sessionId ? getSession(input.sessionId) : await resolve();
      if (resolved.context.source === "account") {
        return transcribeWithAccount(input, options, resolved.context, now, resolved.cloudUuid);
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
  now: () => string,
  uuid: string | null
): Promise<AsrTranscriptionResponse> {
  if (!uuid) {
    throw Object.assign(new Error("Cloud account is not authenticated"), { code: "unauthorized" as const });
  }

  let result: Awaited<ReturnType<CloudClient["transcribeAudio"]>>;
  try {
    result = await options.cloudClient.transcribeAudio({
      uuid,
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      durationMs: input.durationMs,
      diarization: input.diarization
    });
  } catch (error) {
    throw withActualModelContext(error, context);
  }

  const actualProvider = canonicalCatalogProviderId(result.provider === "aliyun" ? "dashscope" : result.provider);
  if (!actualProvider) throw withActualModelContext(new Error("Cloud ASR returned an unknown provider"), context);
  return AsrTranscriptionResponseSchema.parse({
    text: result.text,
    modelId: result.modelId,
    provider: actualProvider,
    source: context.source,
    transcribedAt: now(),
    ...(result.segments?.length ? { segments: result.segments } : {})
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
  try {
    const response = await fetchImpl(toChatCompletionsUrl(provider.apiBase), {
      method: "POST",
      redirect: "error",
      headers: mergeProviderHeaders({
        "content-type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      }, provider.extraHeaders),
      body: JSON.stringify({
        ...provider.extraBody,
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
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await readDashScopeTranscript(response, context);
    return AsrTranscriptionResponseSchema.parse({
      text, modelId: context.model, provider: context.provider, source: context.source, transcribedAt: now()
    });
  } catch (caught) {
    const error = withActualModelContext(caught, context);
    for (const secret of [provider.apiKey, ...Object.values(provider.extraHeaders)]) {
      if (secret) error.message = error.message.split(secret).join("[REDACTED]");
    }
    throw error;
  }
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
  const body = await response.text();
  let value: unknown;
  try { value = JSON.parse(body); } catch { value = null; }
  const text = readChoiceMessageContent(value);
  const upstreamCode = readErrorCode(value);
  const upstreamMessage = readErrorMessage(value);
  if (!response.ok || asRecord(value).error || (text === null && (upstreamCode || upstreamMessage))) {
    throw withActualModelContext(Object.assign(
      new Error(`ASR ${context.model} HTTP ${response.status}${upstreamCode ? ` (${upstreamCode})` : ""}: ${upstreamMessage ?? ((value === null ? body.trim().slice(0, 800) : "") || response.statusText)}`),
      { code: upstreamCode === "model_not_found" ? "model_selection_unavailable" : classifyHttpError(response.status) }
    ), context);
  }
  if (text === null) throw Object.assign(new Error(`ASR ${context.model} HTTP ${response.status}: response missing transcript text (choices[0].message.content)`), { code: "internal" as const });

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

/** Reads a stable upstream error code when one is present. */
function readErrorCode(value: unknown): string | null {
  const record = asRecord(value);
  const error = asRecord(record.error);
  const code = error.code ?? record.code;
  return typeof code === "string" && code.trim() ? code : null;
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
