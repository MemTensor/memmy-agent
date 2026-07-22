import type {
  CheckReleaseInput,
  CloudAuthorizeIntegrationInput,
  CloudClient,
  CloudDeleteIntegrationConnectionInput,
  CloudExecuteIntegrationToolInput,
  CloudHealth,
  CloudIntegrationSessionInput,
  CloudAccountProfile,
  GetAccountInfoInput,
  GetTokenQuotaEligibilityInput,
  GetTokenUsageInput,
  GrantTokensInput,
  RequestTokenQuotaInput,
  TokenQuotaApplyResult,
  TokenQuotaEligibility,
  CloudLoginInput,
  CloudLogoutInput,
  SendEmailCodeInput,
  SendPhoneCodeInput,
  SendTelemetryInput,
  TokenUsageSnapshot,
  UpdateAccountGuideInput,
  UpdateCloudAccountProfileInput
} from "../../adapters/outbound/cloud-client/types.js";
import type { LegalAgreementUrls, PromotionFlags } from "@memmy/local-api-contracts";

export interface CreateMockCloudClientOptions {
  health?: CloudHealth;
  tokenUsage?: TokenUsageSnapshot;
  now?: () => string;
  /** Legal. */
  legal?: LegalAgreementUrls;
  /** Promotions. */
  promotions?: PromotionFlags;
}

export function createMockCloudClient(options: CreateMockCloudClientOptions = {}): CloudClient {
  const now = options.now ?? (() => new Date().toISOString());
  const tokenUsage = options.tokenUsage ?? createDefaultTokenUsage();
  const profiles = new Map<string, CloudAccountProfile>();
  let fallbackProfile: CloudAccountProfile | null = null;

  return {
    async health() {
      return (
        options.health ?? {
          status: "mock",
          checkedAt: now(),
          message: "Mock Cloud Client is active"
        }
      );
    },

    async sendEmailCode(_input: SendEmailCodeInput) {
      return undefined;
    },

    async sendPhoneCode(_input: SendPhoneCodeInput) {
      return undefined;
    },

    async login(input: CloudLoginInput) {
      const email = input.email ?? null;
      const phoneNumber = input.phoneNumber ?? null;
      const identityKey = toIdentityKey(email, phoneNumber);
      const existingProfile = profiles.get(identityKey);
      if (existingProfile) {
        return {
          uuid: "mock-cloud-uuid",
          accountUuid: existingProfile.userId,
          isNewUser: false,
          profile: existingProfile
        };
      }

      const nickname = email ? (email.split("@")[0] ?? "Memmy User") : "Memmy User";
      const registeredAt = now();
      const profile: CloudAccountProfile = {
        userId: `mock-user:${email ?? phoneNumber ?? "unknown"}`,
        email,
        phoneNumber,
        nickname,
        avatarUrl: null,
        planType: "mock",
        hasFinishedGuide: false,
        improvementProgramGranted: false,
        region: null,
        registeredAt,
        rawProfile: {
          id: `mock-user:${email ?? phoneNumber ?? "unknown"}`,
          email,
          phoneNumber,
          userName: nickname,
          planType: "mock",
          hasFinishedGuide: false,
          isNewUser: true,
          createdAt: registeredAt
        }
      };
      profiles.set(identityKey, profile);
      fallbackProfile = profile;

      return {
        uuid: "mock-cloud-uuid",
        accountUuid: profile.userId,
        isNewUser: true,
        profile
      };
    },

    async logout(_input: CloudLogoutInput) {
      return undefined;
    },

    async getAccountInfo(_input: GetAccountInfoInput) {
      return fallbackProfile ?? createDefaultProfile(now());
    },

    async updateAccountGuide(input: UpdateAccountGuideInput) {
      if (fallbackProfile) {
        fallbackProfile = withGuideFlag(fallbackProfile, input.hasFinishedGuide);
      }
      for (const [key, profile] of profiles.entries()) {
        profiles.set(key, withGuideFlag(profile, input.hasFinishedGuide));
      }
    },

    async updateAccountProfile(input: UpdateCloudAccountProfileInput) {
      if (fallbackProfile) {
        fallbackProfile = withProfileUpdate(fallbackProfile, input);
      }
      for (const [key, profile] of profiles.entries()) {
        profiles.set(key, withProfileUpdate(profile, input));
      }
    },

    async getTokenUsage(_input: GetTokenUsageInput): Promise<TokenUsageSnapshot> {
      return tokenUsage;
    },

    async grantImprovementProgramTokens(_input: GrantTokensInput): Promise<TokenUsageSnapshot> {
      return {
        ...tokenUsage,
        totalTokens: tokenUsage.totalTokens + 5_000_000,
        remainingTokens: tokenUsage.remainingTokens + 5_000_000,
        lastSyncedAt: now()
      };
    },

    async requestTokenQuota(_input: RequestTokenQuotaInput): Promise<TokenQuotaApplyResult> {
      return { requestId: "mock-req", status: "pending" };
    },

    async getTokenQuotaEligibility(
      _input: GetTokenQuotaEligibilityInput
    ): Promise<TokenQuotaEligibility> {
      return {
        state: "available",
        requestCount: 0,
        maxRequestCount: 5,
        nextAllowedAtEpochMs: null,
        latestRequestStatus: null,
        latestReviewNote: null
      };
    },

    async listIntegrationCapabilities(_input: CloudIntegrationSessionInput) {
      return { toolkits: [] };
    },

    async authorizeIntegration(input: CloudAuthorizeIntegrationInput) {
      return {
        connectUrl: `https://backend.composio.dev/api/v3/s/${input.slug}-mock`,
        connectionId: `mock-${input.slug}`
      };
    },

    async listIntegrationConnections(_input: CloudIntegrationSessionInput) {
      return { connections: [] };
    },

    async deleteIntegrationConnection(_input: CloudDeleteIntegrationConnectionInput) {
      return { ok: true };
    },

    async executeIntegrationRouterTool(input: CloudExecuteIntegrationToolInput) {
      return {
        data: { mockToolSlug: input.toolSlug, arguments: input.arguments ?? {} },
        successful: true
      };
    },

    async sendTelemetry(_input: SendTelemetryInput) {
      return undefined;
    },

    async checkRelease(_input: CheckReleaseInput) {
      return {
        updateAvailable: false
      };
    },

    async getLegalUrls() {
      return options.legal;
    },

    async getPromotions() {
      return options.promotions;
    }
  };
}

/**
 * Builds the default mock cloud account profile.
 *
 * @param registeredAt Registration time.
 * @returns An account profile usable for agentUser/info.
 */
function createDefaultProfile(registeredAt: string): CloudAccountProfile {
  return {
    userId: "mock-user:unknown",
    email: null,
    phoneNumber: null,
    nickname: "Memmy User",
    avatarUrl: null,
    planType: "mock",
    hasFinishedGuide: false,
    improvementProgramGranted: false,
    region: null,
    registeredAt,
    rawProfile: {
      id: "mock-user:unknown",
      userName: "Memmy User",
      planType: "mock",
      hasFinishedGuide: false,
      createdAt: registeredAt
    }
  };
}

/**
 * Updates the onboarding-guide flag in a mock profile.
 *
 * @param profile The original account profile.
 * @param hasFinishedGuide The new cloud guide flag.
 * @returns The account profile with the new flag.
 */
function withGuideFlag(profile: CloudAccountProfile, hasFinishedGuide: boolean): CloudAccountProfile {
  return {
    ...profile,
    hasFinishedGuide,
    rawProfile: {
      ...profile.rawProfile,
      hasFinishedGuide
    }
  };
}

/**
 * Updates the cloud account profile fields in a mock profile.
 *
 * @param profile The original account profile.
 * @param input The cloud account profile update request.
 * @returns The account profile with the new profile fields.
 */
function withProfileUpdate(profile: CloudAccountProfile, input: UpdateCloudAccountProfileInput): CloudAccountProfile {
  const nickname = input.userName ?? profile.nickname;
  const avatarUrl = input.userAvatar === undefined ? profile.avatarUrl : input.userAvatar;
  const hasFinishedGuide = input.hasFinishedGuide ?? profile.hasFinishedGuide;
  return {
    ...profile,
    nickname,
    avatarUrl,
    hasFinishedGuide,
    rawProfile: {
      ...profile.rawProfile,
      userName: nickname,
      userAvatar: avatarUrl,
      hasFinishedGuide
    }
  };
}

/**
 * Builds a mock cloud account identity key.
 *
 * @param email Email account.
 * @param phoneNumber Phone account.
 * @returns A stable string usable as a registry key.
 */
function toIdentityKey(email: string | null, phoneNumber: string | null): string {
  if (email) {
    return `email:${email.toLowerCase()}`;
  }

  if (phoneNumber) {
    return `phone:${phoneNumber}`;
  }

  return "unknown";
}

function createDefaultTokenUsage(): TokenUsageSnapshot {
  return {
    planName: "mock",
    totalTokens: 30_000_000,
    usedTokens: 0,
    remainingTokens: 30_000_000,
    expiresAt: null,
    lastSyncedAt: null
  };
}
