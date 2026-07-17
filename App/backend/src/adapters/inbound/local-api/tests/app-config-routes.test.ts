/** App config routes tests. */
import { afterEach, describe, expect, it } from "vitest";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("app config local api routes", () => {
  it("registers A group routes behind the runtime token", async () => {
    const calls: string[] = [];
    app = createServer({
      appConfig: {
        async updateSettings(input) {
          calls.push(`settings:${input.language}`);
          return appSettings({ language: input.language ?? "system" });
        },
        async updatePrivacy(input) {
          calls.push(`privacy:${input.localOnlyMode}`);
          return {
            telemetryOptIn: false,
            crashReportOptIn: false,
            allowMemoryImprovementUpload: false,
            localOnlyMode: input.localOnlyMode ?? false
          };
        },
        async updateOnboarding(input) {
          calls.push(`onboarding:${input.currentStep}`);
          return onboarding({ currentStep: input.currentStep ?? "scan_permission_required" });
        },
        async setImprovementProgram(input) {
          calls.push(`improvement:${input.improvementProgram}`);
          return {
            onboarding: onboarding({ improvementProgram: input.improvementProgram }),
            privacy: {
              telemetryOptIn: false,
              crashReportOptIn: false,
              allowMemoryImprovementUpload: input.improvementProgram === "accepted",
              localOnlyMode: false
            },
            tokenUsage: {
              planName: "体验 Token",
              totalTokens: 35000000,
              usedTokens: 1000000,
              remainingTokens: 34000000,
              expiresAt: null,
              lastSyncedAt: "2026-06-05T10:00:00.000Z"
            }
          };
        },
        async getTokenUsage() {
          calls.push("tokenUsage:get");
          return {
            planName: "体验 Token",
            totalTokens: 40000000,
            usedTokens: 900000,
            remainingTokens: 39100000,
            expiresAt: null,
            lastSyncedAt: "2026-06-24T10:00:00.000Z"
          };
        },
        async getModelConfig() {
          calls.push("model:get");
          return modelConfigView({
            provider: "openai_compatible",
            baseUrl: "https://api.example.com/v1",
            modelId: "gpt-4.1-mini",
            hasApiKey: true,
            apiKeyMasked: "sk-l••••cret",
            embedding: localEmbeddingView()
          });
        },
        async setModelConfig(input) {
          calls.push(`model:${input.provider}`);
          return modelConfigView({
            provider: input.provider,
            baseUrl: input.baseUrl,
            modelId: input.modelId,
            hasApiKey: Boolean(input.apiKey),
            apiKeyMasked: "sk-l••••cret",
            embedding: localEmbeddingView()
          });
        },
        async testModelConfig(input) {
          calls.push(`model:test:${input.provider}:${input.modelId}`);
          return {
            ok: true,
            message: "连接成功",
            checkedAt: "2026-06-05T10:00:00.000Z"
          };
        },
        async setSkin(input) {
          calls.push(`skin:${input.skinId}`);
          return { skinId: input.skinId };
        }
      }
    });

    const modelConfigBeforeSave = await injectJson("GET", "/api/app/model-config");
    const settings = await injectJson("PATCH", "/api/app/settings", { language: "zh-CN" });
    const privacy = await injectJson("PATCH", "/api/app/privacy", { localOnlyMode: true });
    const onboardingResponse = await injectJson("PATCH", "/api/app/onboarding", { currentStep: "completed" });
    const improvement = await injectJson("PATCH", "/api/app/improvement-program", { improvementProgram: "declined" });
    const tokenUsage = await injectJson("GET", "/api/app/token-usage");
    const modelConfig = await injectJson("PUT", "/api/app/model-config", {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-live-secret"
    });
    const modelConfigTest = await injectJson("POST", "/api/app/model-config/test", {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-5.5",
      apiKey: "sk-test-secret"
    });
    const skin = await injectJson("PATCH", "/api/app/skin", { skinId: "midnight" });

    expect(settings.json()).toMatchObject({ language: "zh-CN" });
    expect(privacy.json()).toMatchObject({ localOnlyMode: true });
    expect(onboardingResponse.json()).toMatchObject({ currentStep: "completed" });
    expect(improvement.json()).toMatchObject({
      onboarding: { improvementProgram: "declined" },
      privacy: { allowMemoryImprovementUpload: false },
      tokenUsage: { remainingTokens: 34000000 }
    });
    expect(tokenUsage.json()).toMatchObject({
      totalTokens: 40000000,
      remainingTokens: 39100000,
      lastSyncedAt: "2026-06-24T10:00:00.000Z"
    });
    expect(modelConfigBeforeSave.json()).toMatchObject({
      provider: "openai_compatible",
      hasApiKey: true,
      apiKeyMasked: "sk-l••••cret"
    });
    expect(modelConfig.json()).toMatchObject({
      provider: "openai_compatible",
      hasApiKey: true,
      apiKeyMasked: "sk-l••••cret"
    });
    expect(JSON.stringify(modelConfig.json())).not.toContain("sk-live-secret");
    expect(modelConfigTest.json()).toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    expect(JSON.stringify(modelConfigTest.json())).not.toContain("sk-test-secret");
    expect(skin.json()).toEqual({ skinId: "midnight" });
    expect(calls).toEqual([
      "model:get",
      "settings:zh-CN",
      "privacy:true",
      "onboarding:completed",
      "improvement:declined",
      "tokenUsage:get",
      "model:openai_compatible",
      "model:test:openai_compatible:gpt-5.5",
      "skin:midnight"
    ]);
  });

  it("rejects app config routes without a valid runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/app/settings",
      payload: { language: "zh-CN" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns invalid_argument for invalid app config payloads", async () => {
    app = createServer();

    const response = await injectJson("PATCH", "/api/app/settings", { language: "fr-FR" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_argument"
      }
    });
  });
});

async function injectJson(method: string, url: string, payload?: unknown) {
  if (!app) {
    throw new Error("Test server is not initialized");
  }

  return app.inject({
    method,
    url,
    headers: {
      "x-memmy-local-token": "test-token"
    },
    payload
  });
}

function createServer(overrides: Record<string, unknown> = {}): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    progressBus: createProgressBus(),
    appConfig: {
      async updateSettings() {
        return appSettings();
      },
      async updatePrivacy() {
        return {
          telemetryOptIn: false,
          crashReportOptIn: false,
          allowMemoryImprovementUpload: false,
          localOnlyMode: false
        };
      },
      async updateOnboarding() {
        return onboarding();
      },
      async setImprovementProgram() {
        return {
          onboarding: onboarding(),
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
          }
        };
      },
      async getTokenUsage() {
        return {
          planName: "体验 Token",
          totalTokens: 30000000,
          usedTokens: 0,
          remainingTokens: 30000000,
          expiresAt: null,
          lastSyncedAt: null
        };
      },
      async getModelConfig() {
        return modelConfigView({
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: false,
          apiKeyMasked: "",
          embedding: localEmbeddingView()
        });
      },
      async setModelConfig() {
        return modelConfigView({
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: false,
          apiKeyMasked: "",
          embedding: localEmbeddingView()
        });
      },
      async testModelConfig() {
        return {
          ok: true,
          message: "连接成功",
          checkedAt: "2026-06-05T10:00:00.000Z"
        };
      },
      async setSkin() {
        return { skinId: "default" };
      }
    },
    ...overrides
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}

function modelConfigView(overrides: Record<string, unknown> = {}) {
  const provider = (overrides.provider ?? "openai_compatible") as string;
  const baseUrl = (overrides.baseUrl ?? "https://api.example.com/v1") as string;
  const modelId = (overrides.modelId ?? "gpt-4.1-mini") as string;
  const hasApiKey = Boolean(overrides.hasApiKey);
  const apiKeyMasked = (overrides.apiKeyMasked ?? "") as string;
  return {
    provider,
    baseUrl,
    modelId,
    hasApiKey,
    apiKeyMasked,
    embedding: overrides.embedding ?? localEmbeddingView(),
    asr: overrides.asr ?? null,
    imageGen: overrides.imageGen ?? null,
    memmyMemory: {
      summary: {
        provider,
        baseUrl,
        modelId,
        hasApiKey,
        apiKeyMasked
      },
      evolution: {
        provider,
        baseUrl,
        modelId,
        hasApiKey,
        apiKeyMasked
      }
    },
    updatedAt: "2026-06-02T10:00:00.000Z"
  };
}

function localEmbeddingView() {
  return {
    mode: "local",
    baseUrl: null,
    modelId: null,
    hasApiKey: false,
    apiKeyMasked: ""
  };
}

function appSettings(overrides: Record<string, unknown> = {}) {
  return {
    userMode: "unset",
    language: "system",
    theme: "system",
    autoUpdateEnabled: true,
    defaultLaunchMode: "last",
    avatarId: "memmy-default",
    skinId: "default",
    ...overrides
  };
}

function onboarding(overrides: Record<string, unknown> = {}) {
  return {
    completed: false,
    currentStep: "scan_permission_required",
    hasAcceptedTerms: false,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "unset",
    completedAt: null,
    ...overrides
  };
}
