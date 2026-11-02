/** Local-only startup data for the explicitly selected error UI examples. */
import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";

export function creditErrorPreviewBootstrap() {
  const plan = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("credits-plan") === "pro" ? "进阶版" : "免费版";
  return AppBootstrapResponseSchema.parse({
    app: { userMode: "account", language: "zh-CN", theme: "system", autoUpdateEnabled: false },
    onboarding: {
      completed: true, currentStep: "completed", hasAcceptedTerms: false,
      acceptedTermsVersion: null, scanPermission: "unset", improvementProgram: "unset", completedAt: null
    },
    privacy: { telemetryOptIn: false, crashReportOptIn: false, allowMemoryImprovementUpload: false, localOnlyMode: true },
    tokenUsage: { planName: plan, totalTokens: 0, usedTokens: 0, remainingTokens: 0, expiresAt: null, lastSyncedAt: null },
    health: { localApi: "ok", memory: "mock", cloud: "mock" },
    promotions: { loginBanner: false, improvementGift: false, improvementGiftRewardTokens: 0, applyMore: false, agentChatTokenTotal: 0 }
  });
}
