/** Bootstrap tests. */
import { AppBootstrapResponseSchema, legalPageUrl } from "@memmy/local-api-contracts";

const MOCK_LEGAL_BASE = "https://gw.example.cn";

export const mockBootstrap = AppBootstrapResponseSchema.parse({
  app: {
    userMode: "unset",
    language: "system",
    theme: "system",
    autoUpdateEnabled: true
  },
  onboarding: {
    completed: false,
    currentStep: "scan_permission_required",
    hasAcceptedTerms: false,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "unset",
    completedAt: null
  },
  privacy: {
    telemetryOptIn: false,
    crashReportOptIn: false,
    allowMemoryImprovementUpload: false,
    localOnlyMode: false
  },
  tokenUsage: {
    planName: "体验 Token",
    totalTokens: 30000000,
    usedTokens: 0,
    remainingTokens: 30000000,
    expiresAt: null,
    lastSyncedAt: null
  },
  health: {
    localApi: "ok",
    memory: "mock",
    cloud: "mock"
  },
  legal: {
    terms: {
      "zh-CN": legalPageUrl(MOCK_LEGAL_BASE, "terms", "zh-CN"),
      "en-US": legalPageUrl(MOCK_LEGAL_BASE, "terms", "en-US")
    },
    data: {
      "zh-CN": legalPageUrl(MOCK_LEGAL_BASE, "data", "zh-CN"),
      "en-US": legalPageUrl(MOCK_LEGAL_BASE, "data", "en-US")
    }
  },
  promotions: {
    loginBanner: true,
    improvementGift: true,
    applyMore: true
  }
});
