import type {
  AsrModelId,
  AsrProvider,
  AuthorizeIntegrationResponse,
  HealthStatus,
  IntegrationCapabilitiesResponse,
  IntegrationConnectionsResponse,
  LegalAgreementUrls,
  IntegrationToolResult,
  OkResponse,
  PromotionFlags,
  TokenUsageDto
} from "@memmy/local-api-contracts";

export interface CloudHealth {
  status: HealthStatus;
  checkedAt: string;
  message?: string;
}

export interface SendEmailCodeInput {
  email: string;
  zhEnv: boolean;
}

export interface SendPhoneCodeInput {
  phoneNumber: string;
  zhEnv: boolean;
}

export interface CloudLoginInput {
  email?: string;
  phoneNumber?: string;
  verificationCode: string;
  loginSource: "Memmy";
}

export interface CloudAccountProfile {
  userId: string;
  email: string | null;
  phoneNumber: string | null;
  nickname: string;
  avatarUrl: string | null;
  planType: string | null;
  hasFinishedGuide: boolean | null;
  /** Cloud per-user flag: this account has already received the improvement-program token grant. */
  improvementProgramGranted: boolean | null;
  region: string | null;
  registeredAt: string | null;
  rawProfile: Record<string, unknown>;
}

export interface CloudLoginResult {
  profile: CloudAccountProfile;
  /** Account uuid. */
  accountUuid: string;
  /** Uuid. */
  uuid: string;
  /** Is new user. */
  isNewUser: boolean | null;
}

export interface GetTokenUsageInput {
  /** User id. */
  userId?: string;
  /** Uuid. */
  uuid?: string;
}

export type TokenUsageSnapshot = TokenUsageDto;

/** Contract for get account info input. */
export interface GetAccountInfoInput {
  uuid?: string;
}

/** Contract for update account guide input. */
export interface UpdateAccountGuideInput {
  uuid: string;
  hasFinishedGuide: boolean;
}

/** Contract for update cloud account profile input. */
export interface UpdateCloudAccountProfileInput {
  uuid: string;
  userName?: string;
  userAvatar?: string | null;
  hasFinishedGuide?: boolean;
}

export interface GrantTokensInput {
  /** Uuid. */
  uuid?: string;
  /** Token extra. */
  tokenExtra: number;
  /** Per-user idempotency key so the cloud grants each named benefit at most once. */
  grantKey?: string;
}

/** Contract for request token quota input. */
export interface RequestTokenQuotaInput {
  /** Uuid. */
  uuid: string;
  /** Reason. */
  reason: string;
}

/** Contract for token quota apply result. */
export interface TokenQuotaApplyResult {
  requestId: string;
  status: "pending" | "approved" | "rejected";
}

export interface SendTelemetryInput {
  eventName: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export interface CheckReleaseInput {
  currentVersion: string;
  platform: string;
}

export interface ReleaseCheckResult {
  updateAvailable: boolean;
  version?: string;
  notes?: string;
  downloadUrl?: string;
}

/** Contract for cloud integration session input. */
export interface CloudIntegrationSessionInput {
  machineComposioToken: string;
}

/** Contract for cloud authorize integration input. */
export interface CloudAuthorizeIntegrationInput extends CloudIntegrationSessionInput {
  slug: string;
}

/** Contract for cloud delete integration connection input. */
export interface CloudDeleteIntegrationConnectionInput extends CloudIntegrationSessionInput {
  id: string;
}

/** Contract for cloud execute integration tool input. */
export interface CloudExecuteIntegrationToolInput extends CloudIntegrationSessionInput {
  toolSlug: string;
  arguments?: Record<string, unknown>;
}

/** Contract for cloud logout input. */
export interface CloudLogoutInput {
  uuid: string;
}

/** Contract for cloud asr transcription input. */
export interface CloudAsrTranscriptionInput {
  uuid: string;
  audioBase64: string;
  mimeType: string;
  durationMs?: number;
}

/** Contract for cloud asr transcription result. */
export interface CloudAsrTranscriptionResult {
  text: string;
  modelId: AsrModelId;
  provider: AsrProvider;
}

export interface CloudClient {
  health(): Promise<CloudHealth>;
  sendEmailCode(input: SendEmailCodeInput): Promise<void>;
  sendPhoneCode(input: SendPhoneCodeInput): Promise<void>;
  login(input: CloudLoginInput): Promise<CloudLoginResult>;
  logout(input: CloudLogoutInput): Promise<void>;
  getAccountInfo(input: GetAccountInfoInput): Promise<CloudAccountProfile>;
  updateAccountGuide(input: UpdateAccountGuideInput): Promise<void>;
  updateAccountProfile(input: UpdateCloudAccountProfileInput): Promise<void>;
  getTokenUsage(input: GetTokenUsageInput): Promise<TokenUsageSnapshot>;
  grantImprovementProgramTokens(input: GrantTokensInput): Promise<TokenUsageSnapshot>;
  requestTokenQuota(input: RequestTokenQuotaInput): Promise<TokenQuotaApplyResult>;
  listIntegrationCapabilities(input: CloudIntegrationSessionInput): Promise<IntegrationCapabilitiesResponse>;
  authorizeIntegration(input: CloudAuthorizeIntegrationInput): Promise<AuthorizeIntegrationResponse>;
  listIntegrationConnections(input: CloudIntegrationSessionInput): Promise<IntegrationConnectionsResponse>;
  deleteIntegrationConnection(input: CloudDeleteIntegrationConnectionInput): Promise<OkResponse>;
  executeIntegrationRouterTool(input: CloudExecuteIntegrationToolInput): Promise<IntegrationToolResult>;
  transcribeAudio(input: CloudAsrTranscriptionInput): Promise<CloudAsrTranscriptionResult>;
  sendTelemetry(input: SendTelemetryInput): Promise<void>;
  checkRelease(input: CheckReleaseInput): Promise<ReleaseCheckResult>;
  /** Reads get legal urls. */
  getLegalUrls(): Promise<LegalAgreementUrls | undefined>;
  /** Reads get promotions. */
  getPromotions(): Promise<PromotionFlags | undefined>;
}
