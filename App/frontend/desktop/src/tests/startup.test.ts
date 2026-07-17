import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { describe, expect, it } from "vitest";
import { selectStartupRoute } from "../startup.js";

const baseBootstrap = AppBootstrapResponseSchema.parse({
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
    planName: "mock",
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
  promotions: {
    loginBanner: true,
    improvementGift: true,
    applyMore: true
  }
});

describe("startup routing", () => {
  it("routes incomplete bootstrap state to onboarding", () => {
    expect(selectStartupRoute(baseBootstrap)).toBe("onboarding");
  });

  it("routes completed bootstrap state to home", () => {
    expect(
      selectStartupRoute({
        ...baseBootstrap,
        onboarding: {
          ...baseBootstrap.onboarding,
          completed: true,
          currentStep: "completed",
          completedAt: new Date().toISOString()
        }
      })
    ).toBe("home");
  });
});
