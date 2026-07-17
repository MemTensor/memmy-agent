/** Http cloud client module. */
import {
  ASR_PROVIDER,
  AuthorizeIntegrationResponseSchema,
  resolveCloudServiceBaseUrl,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  LegalAgreementUrlsSchema,
  IntegrationToolResultSchema,
  OkResponseSchema,
  PromotionFlagsSchema,
  QWEN_ASR_MODEL_ID,
  TokenUsageDtoSchema,
  type AuthorizeIntegrationResponse,
  type IntegrationCapabilitiesResponse,
  type IntegrationConnection,
  type IntegrationConnectionsResponse,
  type LegalAgreementUrls,
  type IntegrationToolResult,
  type OkResponse,
  type PromotionFlags
} from "@memmy/local-api-contracts";
import type {
  CloudAuthorizeIntegrationInput,
  CloudAsrTranscriptionInput,
  CloudAsrTranscriptionResult,
  CheckReleaseInput,
  CloudAccountProfile,
  CloudClient,
  CloudDeleteIntegrationConnectionInput,
  CloudExecuteIntegrationToolInput,
  CloudHealth,
  CloudIntegrationSessionInput,
  CloudLoginInput,
  CloudLoginResult,
  CloudLogoutInput,
  GetAccountInfoInput,
  GetTokenUsageInput,
  GrantTokensInput,
  ReleaseCheckResult,
  RequestTokenQuotaInput,
  TokenQuotaApplyResult,
  SendEmailCodeInput,
  SendPhoneCodeInput,
  SendTelemetryInput,
  TokenUsageSnapshot,
  UpdateAccountGuideInput,
  UpdateCloudAccountProfileInput
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const CLOUD_COMPOSIO_ROUTER_TIMEOUT_MS = 60_000;
const CLOUD_COMPOSIO_UNAVAILABLE_MESSAGE = "工具连接服务暂时不可用";
const CLOUD_COMPOSIO_SERVICE_UNAVAILABLE_CODE = 60020;
const CLOUD_COMPOSIO_TOOLKIT_UNSUPPORTED_CODE = 60021;

export interface CreateHttpCloudClientOptions {
  /** Base url. */
  baseUrl?: string;
  /** Timeout ms. */
  timeoutMs?: number;
  /** Fetch impl. */
  fetchImpl?: typeof fetch;
}

/** Creates create http cloud client. */
export function createHttpCloudClient(options: CreateHttpCloudClientOptions = {}): CloudClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async health(): Promise<CloudHealth> {
      return {
        status: "ok",
        checkedAt: new Date().toISOString(),
        message: "HTTP Cloud Client configured"
      };
    },

    async sendEmailCode(input: SendEmailCodeInput): Promise<void> {
      await requestBoolean(fetchImpl, baseUrl, timeoutMs, "/api/user/sendVerification", {
        body: {
          email: input.email,
          zhEnv: input.zhEnv
        },
        lang: langFromZhEnv(input.zhEnv)
      });
    },

    async sendPhoneCode(input: SendPhoneCodeInput): Promise<void> {
      await requestBoolean(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/sendPhoneVerification", {
        body: {
          phoneNumber: input.phoneNumber,
          zhEnv: input.zhEnv
        },
        lang: langFromZhEnv(input.zhEnv)
      });
    },

    async login(input: CloudLoginInput): Promise<CloudLoginResult> {
      const data = await requestCloudData<Record<string, unknown>>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/login", {
        body: {
          ...(input.email ? { email: input.email } : {}),
          ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
          verificationCode: input.verificationCode,
          loginSource: input.loginSource.toLowerCase()
        },
        lang: "zh"
      });

      const uuid = readString(data.uuid) ?? readString(data.token);
      if (!uuid) {
        throw new Error("Cloud login response missing uuid");
      }
      const profile = toCloudAccountProfile(data);

      return {
        uuid,
        accountUuid: resolveAccountUuid(data, profile),
        profile,
        isNewUser: readBoolean(data.isNewUser, data.newUser, data.is_new_user, data.new_user, data.firstLogin, data.isFirstLogin)
      };
    },

    async logout(input: CloudLogoutInput): Promise<void> {
      await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/logout", {
        lang: "zh",
        bearerCredential: input.uuid
      });
    },

    async getAccountInfo(input: GetAccountInfoInput): Promise<CloudAccountProfile> {
      const data = await requestCloudData<Record<string, unknown>>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/info", {
        method: "GET",
        lang: "zh",
        bearerCredential: input.uuid
      });

      return toCloudAccountProfile(data);
    },

    async updateAccountGuide(input: UpdateAccountGuideInput): Promise<void> {
      await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/update", {
        body: {
          hasFinishedGuide: input.hasFinishedGuide
        },
        lang: "zh",
        bearerCredential: input.uuid
      });
    },

    async updateAccountProfile(input: UpdateCloudAccountProfileInput): Promise<void> {
      await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/update", {
        body: toAccountProfileUpdateBody(input),
        lang: "zh",
        bearerCredential: input.uuid
      });
    },

    async getTokenUsage(input: GetTokenUsageInput): Promise<TokenUsageSnapshot> {
      const data = await requestCloudData<Record<string, unknown>>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/info", {
        method: "GET",
        lang: "zh",
        bearerCredential: input.uuid
      });

      return toAgentUserInfoTokenUsageSnapshot(data);
    },

    async grantImprovementProgramTokens(input: GrantTokensInput): Promise<TokenUsageSnapshot> {
      await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/quota/updateTokenTotal", {
        body: {
          tokenExtra: input.tokenExtra,
          // Per-user idempotency key: the cloud must grant a named benefit at most once, so
          // reinstalling and re-accepting cannot stack the improvement-program tokens again.
          ...(input.grantKey ? { grantKey: input.grantKey } : {})
        },
        lang: "zh",
        bearerCredential: input.uuid
      });

      const data = await requestCloudData<Record<string, unknown>>(fetchImpl, baseUrl, timeoutMs, "/api/agentUser/info", {
        method: "GET",
        lang: "zh",
        bearerCredential: input.uuid
      });

      return toAgentUserInfoTokenUsageSnapshot(data);
    },

    async requestTokenQuota(input: RequestTokenQuotaInput): Promise<TokenQuotaApplyResult> {
      const data = await requestCloudData<Record<string, unknown>>(
        fetchImpl,
        baseUrl,
        timeoutMs,
        "/api/agentUser/quota/apply",
        {
          body: { reason: input.reason },
          lang: "zh",
          bearerCredential: input.uuid
        }
      );

      const status = String(data.status);
      return {
        requestId: String(data.requestId ?? ""),
        status: (["pending", "approved", "rejected"].includes(status) ? status : "pending") as TokenQuotaApplyResult["status"]
      };
    },

    async listIntegrationCapabilities(input: CloudIntegrationSessionInput): Promise<IntegrationCapabilitiesResponse> {
      const data = await requestCloudData<unknown>(
        fetchImpl,
        baseUrl,
        timeoutMs,
        "/api/composio/auth-configs?limit=100&show_disabled=false",
        {
          method: "GET",
          lang: "zh",
          composioMachineToken: input.machineComposioToken,
          toError: toCloudIntegrationError
        }
      );

      return IntegrationCapabilitiesResponseSchema.parse(toIntegrationCapabilities(data));
    },

    async authorizeIntegration(input: CloudAuthorizeIntegrationInput): Promise<AuthorizeIntegrationResponse> {
      const data = await requestCloudData<unknown>(
        fetchImpl,
        baseUrl,
        timeoutMs,
        `/api/composio/integrations/${encodeURIComponent(input.slug)}/authorize`,
        {
          body: {},
          lang: "zh",
          composioMachineToken: input.machineComposioToken,
          toError: toCloudIntegrationError
        }
      );

      return AuthorizeIntegrationResponseSchema.parse(toAuthorizeIntegrationResponse(data));
    },

    async listIntegrationConnections(input: CloudIntegrationSessionInput): Promise<IntegrationConnectionsResponse> {
      const data = await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/composio/connections", {
        method: "GET",
        lang: "zh",
        composioMachineToken: input.machineComposioToken,
        toError: toCloudIntegrationError
      });

      return IntegrationConnectionsResponseSchema.parse(toIntegrationConnections(data));
    },

    async deleteIntegrationConnection(input: CloudDeleteIntegrationConnectionInput): Promise<OkResponse> {
      const data = await requestCloudData<unknown>(
        fetchImpl,
        baseUrl,
        timeoutMs,
        `/api/composio/connections/${encodeURIComponent(input.id)}`,
        {
          method: "DELETE",
          lang: "zh",
          composioMachineToken: input.machineComposioToken,
          toError: toCloudIntegrationError
        }
      );

      return OkResponseSchema.parse(toOkResponse(data));
    },

    async executeIntegrationRouterTool(input: CloudExecuteIntegrationToolInput): Promise<IntegrationToolResult> {
      const routerTimeoutMs = Math.max(timeoutMs, CLOUD_COMPOSIO_ROUTER_TIMEOUT_MS);
      const data = await requestCloudData<unknown>(fetchImpl, baseUrl, routerTimeoutMs, "/api/composio/router/execute", {
        body: { toolSlug: input.toolSlug, arguments: input.arguments ?? {} },
        lang: "zh",
        composioMachineToken: input.machineComposioToken,
        toError: toCloudIntegrationError
      });

      return IntegrationToolResultSchema.parse(toIntegrationToolResult(data));
    },

    async transcribeAudio(input: CloudAsrTranscriptionInput): Promise<CloudAsrTranscriptionResult> {
      const data = await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/agentAsr/transcriptions", {
        body: {
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
        },
        lang: "zh",
        bearerCredential: input.uuid
      });

      return toCloudAsrTranscriptionResult(data);
    },

    async sendTelemetry(_input: SendTelemetryInput): Promise<void> {
      return undefined;
    },

    async checkRelease(_input: CheckReleaseInput): Promise<ReleaseCheckResult> {
      return {
        updateAvailable: false
      };
    },

    async getLegalUrls(): Promise<LegalAgreementUrls | undefined> {
      try {
        const data = await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/memmy/desktop/legal/agreements", {
          method: "GET",
          lang: "zh"
        });
        const parsed = LegalAgreementUrlsSchema.safeParse(data);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },

    async getPromotions(): Promise<PromotionFlags | undefined> {
      try {
        const data = await requestCloudData<unknown>(fetchImpl, baseUrl, timeoutMs, "/api/memmy/desktop/promotions", {
          method: "GET",
          lang: "zh"
        });
        const parsed = PromotionFlagsSchema.safeParse(data);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    }
  };
}

interface CloudRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  lang: "zh" | "en";
  bearerCredential?: string;
  composioMachineToken?: string;
  toError?: (status: number, envelope: CloudEnvelope) => Error;
}

interface CloudEnvelope {
  code: number;
  message?: string;
  data: unknown;
}

/**
 * Requests a cloud boolean endpoint.
 *
 * @param fetchImpl fetch implementation.
 * @param baseUrl cloud base URL.
 * @param timeoutMs timeout duration.
 * @param path cloud endpoint path.
 * @param options request body and language.
 */
async function requestBoolean(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  path: string,
  options: CloudRequestOptions
): Promise<void> {
  const data = await requestCloudData<boolean>(fetchImpl, baseUrl, timeoutMs, path, options);
  if (data !== true) {
    throw new Error("Cloud verification response was not true");
  }
}

/**
 * Requests the cloud and parses the unified response envelope.
 *
 * @param fetchImpl fetch implementation.
 * @param baseUrl cloud base URL.
 * @param timeoutMs timeout duration.
 * @param path cloud endpoint path.
 * @param options request body and language.
 * @returns the cloud data field.
 */
async function requestCloudData<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  path: string,
  options: CloudRequestOptions
): Promise<T> {
  const method = options.method ?? "POST";
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      lang: options.lang,
      ...(options.bearerCredential ? { authorization: `Bearer ${options.bearerCredential}` } : {}),
      ...(options.composioMachineToken ? { "x-memmy-composio-token": options.composioMachineToken } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const envelope = await readCloudEnvelope(response);

  if (!response.ok || envelope.code !== 0) {
    throw options.toError?.(response.status, envelope) ?? new Error(envelope.message || `Cloud request failed with HTTP ${response.status}`);
  }

  return envelope.data as T;
}

/**
 * Reads the Cloud Service unified response envelope.
 *
 * @param response fetch response.
 * @returns the normalized envelope; synthesizes an error envelope when the body is not JSON.
 */
async function readCloudEnvelope(response: Response): Promise<CloudEnvelope> {
  try {
    const value = await response.json() as Partial<CloudEnvelope>;
    return {
      code: typeof value.code === "number" ? value.code : response.ok ? 0 : response.status,
      message: typeof value.message === "string" ? value.message : undefined,
      data: "data" in value ? value.data : null
    };
  } catch {
    return {
      code: response.ok ? 0 : response.status,
      message: response.ok ? "ok" : `Cloud request failed with HTTP ${response.status}`,
      data: null
    };
  }
}

/**
 * Maps cloud account data into a local profile.
 *
 * @param data cloud agentLogin data.
 * @returns the account profile without login credentials.
 */
function toCloudAccountProfile(data: Record<string, unknown>): CloudAccountProfile {
  const email = readString(data.email);
  const phoneNumber = readString(data.phoneNumber) ?? readString(data.phone);
  const nickname = readString(data.userName) ?? (email ? email.split("@")[0] : null) ?? "Memmy User";
  const rawProfile = { ...data };
  delete rawProfile.token;
  delete rawProfile.uuid;

  return {
    userId: readString(data.id) ?? "unknown",
    email,
    phoneNumber,
    nickname,
    avatarUrl: readString(data.userAvatar),
    planType: readString(data.planType),
    hasFinishedGuide: readNullableBoolean(data.hasFinishedGuide),
    improvementProgramGranted: readNullableBoolean(data.improvementProgramGranted ?? data.improvement_program_granted),
    region: readString(data.region),
    registeredAt: readIsoTime(data.registeredAt, data.registerTime, data.createdAt, data.created_at, data.createTime, data.create_time),
    rawProfile
  };
}

/**
 * Builds the cloud account-profile update body.
 *
 * @param input the account-profile fields to update this time.
 * @returns a cloud request body containing only the explicitly provided fields.
 */
function toAccountProfileUpdateBody(input: UpdateCloudAccountProfileInput): Record<string, unknown> {
  return {
    ...(input.userName === undefined ? {} : { userName: input.userName }),
    ...(input.userAvatar === undefined ? {} : { userAvatar: input.userAvatar }),
    ...(input.hasFinishedGuide === undefined ? {} : { hasFinishedGuide: input.hasFinishedGuide })
  };
}

/**
 * Resolves the stable cloud account uuid.
 *
 * @param data cloud agentLogin data.
 * @param profile the normalized account profile.
 * @returns the stable account uuid.
 */
function resolveAccountUuid(data: Record<string, unknown>, profile: CloudAccountProfile): string {
  const accountUuid =
    readString(data.accountUuid) ?? readString(data.account_uuid) ?? readString(data.userUuid) ?? readString(data.user_uuid);
  if (accountUuid) {
    return accountUuid;
  }

  if (profile.userId && profile.userId !== "unknown") {
    return profile.userId;
  }

  throw new Error("Cloud login response missing stable account uuid");
}

/**
 * Maps the cloud Token usage response into the local quota DTO.
 *
 * @param data cloud token usage data.
 * @returns the local shared-contract TokenUsageSnapshot.
 */
function toTokenUsageSnapshot(data: Record<string, unknown>): TokenUsageSnapshot {
  const totalTokens = readNonNegativeInteger(data.totalTokens, data.total_tokens, data.total, data.quota, data.tokenTotal);
  const usedTokens = readNonNegativeInteger(data.usedTokens, data.used_tokens, data.used, data.consumedTokens, data.tokenUsed, data.tokenConsumer);
  const remainingTokens = readNonNegativeInteger(
    data.remainingTokens,
    data.remaining_tokens,
    data.remaining,
    data.availableTokens,
    data.tokenRemaining,
    data.tokenAvailable
  );

  return TokenUsageDtoSchema.parse({
    planName: readString(data.planName) ?? readString(data.plan_name) ?? readString(data.planType) ?? readString(data.plan_type) ?? "体验 Token",
    totalTokens,
    usedTokens,
    remainingTokens,
    expiresAt: readIsoTime(data.expiresAt, data.expires_at, data.expiredAt, data.expired_at),
    lastSyncedAt: readIsoTime(data.lastSyncedAt, data.last_synced_at, data.updatedAt, data.updated_at) ?? new Date().toISOString()
  });
}

/**
 * Maps the Token fields of agentUser/info into the local quota DTO.
 *
 * @param data cloud agentUser/info data.
 * @returns the local shared-contract TokenUsageSnapshot.
 */
function toAgentUserInfoTokenUsageSnapshot(data: Record<string, unknown>): TokenUsageSnapshot {
  return TokenUsageDtoSchema.parse({
    planName: readString(data.planName) ?? readString(data.plan_name) ?? readString(data.planType) ?? readString(data.plan_type) ?? "体验 Token",
    totalTokens: readNonNegativeInteger(data.tokenTotal),
    usedTokens: readNonNegativeInteger(data.tokenConsumer),
    remainingTokens: readNonNegativeInteger(data.tokenAvailable),
    expiresAt: readIsoTime(data.expiresAt, data.expires_at, data.expiredAt, data.expired_at),
    lastSyncedAt: readIsoTime(data.lastSyncedAt, data.last_synced_at, data.updatedAt, data.updated_at) ?? new Date().toISOString()
  });
}

/**
 * Maps the Cloud tool-config response into the local capabilities list.
 *
 * @param value Cloud Service data.
 * @returns the list of connectable toolkit slugs.
 */
function toIntegrationCapabilities(value: unknown): IntegrationCapabilitiesResponse {
  const record = asRecord(value);
  const items = Array.isArray(value)
    ? value
    : (arrayField(record, "items") ?? arrayField(record, "data") ?? []);

  return {
    toolkits: [...new Set(items.map(readToolkitSlug).filter((slug): slug is string => Boolean(slug)))]
  };
}

/**
 * Maps the Cloud authorization response into the local authorization DTO.
 *
 * @param value Cloud Service data.
 * @returns the authorization redirect URL and connection id.
 */
function toAuthorizeIntegrationResponse(value: unknown): AuthorizeIntegrationResponse {
  const record = asRecord(value);
  return {
    connectUrl:
      readString(record.connectUrl) ??
      readString(record.connect_url) ??
      readString(record.redirectUrl) ??
      readString(record.redirect_url) ??
      readString(record.url) ??
      "",
    connectionId:
      readString(record.connectionId) ??
      readString(record.connection_id) ??
      readString(record.connectedAccountId) ??
      readString(record.connected_account_id) ??
      readString(record.id) ??
      ""
  };
}

/**
 * Maps the Cloud connection-list response into local connection DTOs.
 *
 * @param value Cloud Service data.
 * @returns the list of tool connections.
 */
function toIntegrationConnections(value: unknown): IntegrationConnectionsResponse {
  const record = asRecord(value);
  const connections = Array.isArray(value)
    ? value
    : (arrayField(record, "connections") ?? arrayField(record, "items") ?? arrayField(record, "data") ?? []);

  return {
    connections: connections.map(toIntegrationConnection)
  };
}

/**
 * Maps a single Cloud connection record into a local connection DTO.
 *
 * @param value Cloud connection item.
 * @returns the local connection record.
 */
function toIntegrationConnection(value: unknown): IntegrationConnection {
  const record = asRecord(value);
  const toolkitRecord = asRecord(record.toolkit);
  return {
    id: readString(record.id) ?? readString(record.connectionId) ?? readString(record.connectedAccountId) ?? "",
    toolkit:
      readString(record.toolkit) ??
      readString(record.toolkit_slug) ??
      readString(toolkitRecord.slug) ??
      readString(toolkitRecord.name) ??
      "",
    status: readString(record.status) ?? readString(record.state) ?? "",
    createdAt: readString(record.createdAt) ?? readString(record.created_at) ?? undefined,
    accountEmail: readString(record.accountEmail) ?? readString(record.account_email) ?? readString(record.email) ?? undefined,
    workspace: readString(record.workspace) ?? undefined,
    username: readString(record.username) ?? undefined
  };
}

/**
 * Maps the Cloud delete response into a local ok response.
 *
 * @param value Cloud Service data.
 * @returns the ok response.
 */
function toOkResponse(value: unknown): OkResponse {
  if (value === true || value === null) {
    return { ok: true };
  }

  const record = asRecord(value);
  if (record.ok === true || record.success === true) {
    return { ok: true };
  }

  throw Object.assign(new Error(CLOUD_COMPOSIO_UNAVAILABLE_MESSAGE), { code: "internal" as const });
}

/**
 * Maps the Cloud ASR response into a local transcription result.
 *
 * @param value Cloud Service data.
 * @returns the text, model, and provider.
 */
function toCloudAsrTranscriptionResult(value: unknown): CloudAsrTranscriptionResult {
  const record = asRecord(value);
  return {
    text: readString(record.text) ?? "",
    modelId: QWEN_ASR_MODEL_ID,
    provider: ASR_PROVIDER
  };
}

/**
 * Reads the toolkit slug from a tool-config item.
 *
 * @param value Cloud tool-config item.
 * @returns the toolkit slug; returns null when missing.
 */
function readToolkitSlug(value: unknown): string | null {
  const record = asRecord(value);
  const toolkitRecord = asRecord(record.toolkit);
  return readString(toolkitRecord.slug) ?? readString(record.toolkit_slug);
}

/**
 * Normalizes the Tool Router execution result, ensuring an object shape for zod validation.
 *
 * @param value the data field returned by Cloud.
 * @returns an object containing at least a data field.
 */
function toIntegrationToolResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value ?? null };
}

/**
 * Maps a Cloud tool-connection error into a local error code.
 *
 * @param status HTTP status code.
 * @param envelope Cloud Service response envelope.
 * @returns an Error recognizable by error-envelope.
 */
function toCloudIntegrationError(status: number, envelope: CloudEnvelope): Error {
  const rawMessage = envelope.message || `Cloud integration request failed with HTTP ${status}`;
  if (envelope.code === CLOUD_COMPOSIO_SERVICE_UNAVAILABLE_CODE || isComposioConfigMessage(rawMessage)) {
    return Object.assign(new Error(CLOUD_COMPOSIO_UNAVAILABLE_MESSAGE), { code: "composio_not_configured" as const });
  }

  if (envelope.code === CLOUD_COMPOSIO_TOOLKIT_UNSUPPORTED_CODE || isToolkitUnsupportedMessage(rawMessage)) {
    return Object.assign(new Error(sanitizeMessage(rawMessage)), { code: "toolkit_unsupported" as const });
  }

  const code = classifyCloudError(status, envelope.code);
  const message = code === "internal" ? CLOUD_COMPOSIO_UNAVAILABLE_MESSAGE : sanitizeMessage(rawMessage);
  return Object.assign(new Error(message), { code });
}

/**
 * Determines whether this is a Cloud-internal Composio configuration error.
 *
 * @param message the original error message.
 * @returns true means the product side should hide internal configuration details.
 */
function isComposioConfigMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("composio") &&
    (lower.includes("api-key") || lower.includes("api_key") || lower.includes("api key") || lower.includes("base-url") || lower.includes("base_url"));
}

/**
 * Determines whether this is a toolkit-not-configured error.
 *
 * @param message the original error message.
 * @returns true means the current toolkit has no usable connection configuration.
 */
function isToolkitUnsupportedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("auth config") && lower.includes("toolkit");
}

/**
 * Classifies the local error code by Cloud business code and HTTP status code.
 *
 * @param status HTTP status code.
 * @param cloudCode Cloud Service BaseResponse.code.
 * @returns an error code supported by error-envelope.
 */
function classifyCloudError(
  status: number,
  cloudCode: number
): "invalid_argument" | "unauthorized" | "forbidden" | "rate_limited" | "internal" {
  if (cloudCode === 40100) {
    return "unauthorized";
  }
  if (cloudCode === 40101) {
    return "forbidden";
  }
  if (cloudCode >= 40300 && cloudCode < 40400) {
    return "rate_limited";
  }
  if (cloudCode >= 40000 && cloudCode < 40100) {
    return "invalid_argument";
  }
  if (cloudCode >= 60000 && cloudCode < 60100) {
    return "internal";
  }
  if (status === 400 || status === 422) {
    return "invalid_argument";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "rate_limited";
  }

  return "internal";
}

/**
 * Redacts URL query strings in an error message.
 *
 * @param message the original error message.
 * @returns the redacted error message.
 */
function sanitizeMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[redacted:url]";
    }
  });
}

/**
 * Treats an unknown value as a plain object.
 *
 * @param value the unknown value.
 * @returns a record; returns an empty object when not an object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Reads an array field.
 *
 * @param record the object.
 * @param key the field name.
 * @returns the array; undefined when missing or of a mismatched type.
 */
function arrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Reads and normalizes an ISO time from candidate cloud fields.
 *
 * @param values the registration-time fields the cloud may return.
 * @returns an ISO 8601 time string; returns null when missing or unparseable.
 */
function readIsoTime(...values: unknown[]): string | null {
  for (const value of values) {
    const numericTimestamp = readTimestampNumber(value);
    if (numericTimestamp !== null) {
      return new Date(numericTimestamp).toISOString();
    }

    const raw = readString(value);
    if (!raw) {
      continue;
    }

    const numericStringTimestamp = readTimestampNumber(raw);
    if (numericStringTimestamp !== null) {
      return new Date(numericStringTimestamp).toISOString();
    }

    const timestamp = Date.parse(raw);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  return null;
}

/**
 * Reads a boolean field from unknown values.
 *
 * @param values the new/returning-user candidate fields the cloud may return.
 * @returns the first unambiguous boolean value; returns null when missing.
 */
function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }

    if (typeof value === "number" && (value === 0 || value === 1)) {
      return value === 1;
    }
  }

  return null;
}

/**
 * Reads a non-negative integer from candidate cloud fields.
 *
 * @param values fields that may contain a number or a numeric string.
 * @returns a non-negative integer; returns 0 when missing.
 */
function readNonNegativeInteger(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return 0;
}

/**
 * Reads a second- or millisecond-precision timestamp from an unknown value.
 *
 * @param value the cloud timestamp field, which may be a number or a purely numeric string.
 * @returns a millisecond timestamp suitable for Date; returns null when unparseable.
 */
function readTimestampNumber(value: unknown): number | null {
  const numericValue = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue >= 100_000_000_000 ? numericValue : numericValue * 1000;
}

/**
 * Reads a string from an unknown value.
 *
 * @param value an unknown cloud field.
 * @returns a string or null.
 */
function readString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * Leniently parses a cloud boolean field.
 *
 * The cloud often returns booleans as 0/1 numbers or "true"/"false" strings; strictly accepting only boolean
 * would drop these to null, e.g. hasFinishedGuide being treated as "guide not finished" so the onboarding pops up on every login.
 *
 * @param value the raw cloud field value.
 * @returns the parsed boolean; returns null when undeterminable.
 */
function readNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  return null;
}

/**
 * Derives the cloud lang header from zhEnv.
 *
 * @param zhEnv whether it is a Chinese-language environment.
 * @returns the cloud lang header.
 */
function langFromZhEnv(zhEnv: boolean): "zh" | "en" {
  return zhEnv ? "zh" : "en";
}

/**
 * Normalizes the base URL by removing trailing slashes.
 *
 * @param baseUrl the user-provided or default cloud base URL.
 * @returns the base URL without a trailing slash.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
