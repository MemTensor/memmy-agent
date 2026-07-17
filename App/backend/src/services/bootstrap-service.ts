import {
  AppBootstrapResponseSchema,
  TokenUsageDtoSchema,
  type AppBootstrapResponse,
  type AppSettingsDto,
  type HealthStatus,
  type LegalAgreementUrls,
  type OnboardingStateDto,
  type PromotionFlags,
  type TokenUsageDto
} from "@memmy/local-api-contracts";
import type { AppStateStore } from "../infrastructure/app-state-store/index.js";
import type { CloudClient, CloudHealth } from "../adapters/outbound/cloud-client/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";

export type BootstrapScenario = "onboarding" | "completed";

export interface BootstrapService {
  getBootstrap(): Promise<AppBootstrapResponse>;
}

export interface CreateBootstrapServiceOptions {
  appStateStore: AppStateStore;
  memoryClient: MemoryClient;
  cloudClient: CloudClient;
  bootstrapScenario?: BootstrapScenario;
}

const TOKEN_USAGE_PLACEHOLDER = TokenUsageDtoSchema.parse({
  planName: "体验 Token",
  totalTokens: 30000000,
  usedTokens: 0,
  remainingTokens: 30000000,
  expiresAt: null,
  lastSyncedAt: null
});

export function createBootstrapService(options: CreateBootstrapServiceOptions): BootstrapService {
  return {
    async getBootstrap() {
      const bootstrap = options.appStateStore.repositories.bootstrap;
      const appSettings = bootstrap.getAppSettings();
      const onboarding = await reconcileImprovementProgram(options, appSettings, bootstrap.getOnboardingState());
      const [memoryHealth, cloudHealth, tokenUsage, legal, promotions] = await Promise.all([
        getMemoryHealth(options.memoryClient),
        getCloudHealth(options.cloudClient),
        refreshTokenUsage(options),
        getLegalUrls(options.cloudClient),
        getPromotions(options.cloudClient)
      ]);

      return AppBootstrapResponseSchema.parse({
        app: appSettings,
        onboarding:
          options.bootstrapScenario === "completed"
            ? {
                ...onboarding,
                completed: true,
                currentStep: "completed",
                completedAt: onboarding.completedAt ?? new Date().toISOString()
              }
            : onboarding,
        privacy: bootstrap.getPrivacySettings(),
        scanPreferences: bootstrap.getScanPreferences(),
        tokenUsage,
        health: {
          localApi: "ok",
          memory: memoryHealth,
          cloud: cloudHealth.status
        },
        ...(legal ? { legal } : {}),
        promotions
      });
    }
  };
}

/**
 * Reconciles the local improvement-program decision against the cloud per-user flag.
 *
 * The authoritative "already joined / already granted" state lives on the cloud account, not in local
 * storage. Deleting local data resets the local decision to "unset", which would otherwise re-show the
 * improvement dialog and re-trigger the token grant. When the cloud reports the grant was already made,
 * project the local onboarding decision to "accepted" so the dialog stays suppressed for that user.
 *
 * This is fail-open and non-authoritative: BYOK, unauthenticated, an already-decided local state, a
 * cloud outage, or a cloud that does not yet return the flag all keep the current local onboarding
 * unchanged. The real per-user dedup is enforced by cloud grant idempotency.
 */
async function reconcileImprovementProgram(
  options: CreateBootstrapServiceOptions,
  appSettings: AppSettingsDto,
  onboarding: OnboardingStateDto
): Promise<OnboardingStateDto> {
  if (appSettings.userMode === "byok" || onboarding.improvementProgram !== "unset") {
    return onboarding;
  }

  const accountSession = options.appStateStore.repositories.accountSession;
  const session = accountSession.get();
  const uuid = accountSession.getCloudUuid();
  if (!session.authenticated || !uuid) {
    return onboarding;
  }

  try {
    const profile = await options.cloudClient.getAccountInfo({ uuid });
    if (profile.improvementProgramGranted === true) {
      return options.appStateStore.repositories.bootstrap.updateOnboarding({ improvementProgram: "accepted" });
    }
  } catch {
    // Fail-open: keep the local onboarding decision when the cloud flag cannot be read.
  }

  return onboarding;
}

/** Handles refresh token usage. */
async function refreshTokenUsage(options: CreateBootstrapServiceOptions): Promise<TokenUsageDto> {
  const accountSession = options.appStateStore.repositories.accountSession;
  const session = accountSession.get();
  const uuid = accountSession.getCloudUuid();
  if (!session.authenticated || !uuid) {
    return TOKEN_USAGE_PLACEHOLDER;
  }

  try {
    const usage = await options.cloudClient.getTokenUsage({
      userId: session.profile.userId,
      uuid
    });
    return TokenUsageDtoSchema.parse(usage);
  } catch {
    return TOKEN_USAGE_PLACEHOLDER;
  }
}

/** Reads get legal urls. */
async function getLegalUrls(cloudClient: CloudClient): Promise<LegalAgreementUrls | undefined> {
  try {
    return await cloudClient.getLegalUrls();
  } catch {
    return undefined;
  }
}

const PROMOTIONS_FALLBACK: PromotionFlags = {
  loginBanner: true,
  improvementGift: true,
  applyMore: true
};

/** Reads get promotions. */
async function getPromotions(cloudClient: CloudClient): Promise<PromotionFlags> {
  try {
    return (await cloudClient.getPromotions()) ?? PROMOTIONS_FALLBACK;
  } catch {
    return PROMOTIONS_FALLBACK;
  }
}

async function getMemoryHealth(memoryClient: MemoryClient): Promise<HealthStatus> {
  try {
    const health = await memoryClient.health();
    return health.ok ? "ok" : "unavailable";
  } catch (error) {
    return "unavailable";
  }
}

async function getCloudHealth(cloudClient: CloudClient): Promise<CloudHealth> {
  try {
    return await cloudClient.health();
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Cloud Client health check failed"
    };
  }
}
