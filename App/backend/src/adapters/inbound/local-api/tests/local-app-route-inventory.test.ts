/** Local app route inventory tests. */
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

describe("local app route inventory", () => {
  it("registers all local backend routes from docs/codex-spec-backend-route-fill-260602.md", async () => {
    app = createServer();
    const requests = [
      { method: "PATCH", url: "/api/app/settings", payload: { language: "zh-CN" } },
      { method: "GET", url: "/api/app/model-config" },
      {
        method: "PUT",
        url: "/api/app/model-config",
        payload: { provider: "openai_compatible", baseUrl: "https://api.example.com/v1", modelId: "gpt-4.1-mini" }
      },
      {
        method: "POST",
        url: "/api/app/model-config/test",
        payload: { provider: "openai_compatible", baseUrl: "https://api.example.com/v1", modelId: "gpt-4.1-mini", apiKey: "sk-test" }
      },
      { method: "PATCH", url: "/api/app/privacy", payload: { localOnlyMode: true } },
      { method: "PATCH", url: "/api/app/onboarding", payload: { currentStep: "completed" } },
      { method: "PATCH", url: "/api/app/improvement-program", payload: { improvementProgram: "declined" } },
      { method: "GET", url: "/api/app/token-usage" },
      { method: "GET", url: "/api/account/avatars" },
      { method: "PATCH", url: "/api/account/avatar", payload: { avatarId: "memmy-default" } },
      { method: "PATCH", url: "/api/app/skin", payload: { skinId: "default" } },
      { method: "POST", url: "/api/account/send-code", payload: { channel: "email", email: "hello@example.com", locale: "zh" } },
      {
        method: "POST",
        url: "/api/account/verify-code",
        payload: { channel: "email", email: "hello@example.com", verificationCode: "123456", loginSource: "Memmy" }
      },
      { method: "PATCH", url: "/api/account/profile", payload: { nickname: "Memmy User" } },
      { method: "POST", url: "/api/account/logout", payload: {} },
      { method: "GET", url: "/api/account/session" },
      { method: "POST", url: "/api/local-data/reveal", payload: {} },
      { method: "POST", url: "/api/local-data/export", payload: {} },
      { method: "DELETE", url: "/api/local-data", payload: { confirm: true } },
      { method: "GET", url: "/api/v1/channels/definitions" },
      { method: "GET", url: "/api/v1/channels/connections" },
      { method: "POST", url: "/api/v1/channels/wechat/connect", payload: {} },
      { method: "GET", url: "/api/v1/channels/wechat/connect/poll-1" },
      { method: "POST", url: "/api/v1/channels/wechat/disconnect", payload: {} },
      { method: "POST", url: "/api/app/byok-token-usage/events", payload: byokUsageEvent() },
      { method: "GET", url: "/api/app/byok-token-usage/summary" },
      { method: "POST", url: "/api/asr/transcriptions", payload: { audioBase64: "UklGRg==", mimeType: "audio/wav" } },
      { method: "POST", url: "/api/onboarding/insight-report", payload: { locale: "zh-CN" } },
      { method: "POST", url: "/api/onboarding/insight-report/stream", payload: { locale: "zh-CN", stream: true } }
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { "x-memmy-local-token": "test-token" },
        payload: request.payload
      });

      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
    }
  });
});

function createServer(): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    progressBus: createProgressBus(),
    appConfig: {
      async updateSettings(input) {
        return appSettings(input);
      },
      async setModelConfig(input) {
        return modelConfigView({
          provider: input.provider,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          hasApiKey: Boolean(input.apiKey),
          apiKeyMasked: input.apiKey ? "sk-t••••cret" : "",
          embedding: localEmbeddingView()
        });
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
      async testModelConfig() {
        return {
          ok: true,
          message: "连接成功",
          checkedAt: "2026-06-05T10:00:00.000Z"
        };
      },
      async updatePrivacy(input) {
        return {
          telemetryOptIn: false,
          crashReportOptIn: false,
          allowMemoryImprovementUpload: false,
          localOnlyMode: input.localOnlyMode ?? false
        };
      },
      async updateOnboarding(input) {
        return onboarding(input);
      },
      async setImprovementProgram(input) {
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
      async listAvatars() {
        return [{ id: "memmy-default", displayName: "Memmy", assetKey: "avatar.memmy.default", kind: "image" }];
      },
      async setAvatar(input) {
        return { avatarId: input.avatarId };
      },
      async setSkin(input) {
        return { skinId: input.skinId };
      }
    },
    account: {
      async sendCode() {
        return { ok: true, resendAfterSec: 60 };
      },
      async verifyCode() {
        return accountSession();
      },
      async updateProfile(input) {
        return { ...accountSession().profile, nickname: input.nickname };
      },
      async logout() {
        return { ok: true };
      },
      async getSession() {
        return accountSession();
      }
    },
    localData: {
      async reveal() {
        return { ok: true, dataPath: "/tmp/memmy-data" };
      },
      async export() {
        return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
      },
      async clear() {
        return { ok: true, clearedAt: "2026-06-02T10:00:00.000Z" };
      }
    },
    channels: {
      async listDefinitions() {
        return { channels: [] };
      },
      async listConnections() {
        return { connections: [] };
      },
      async connect() {
        return { status: "pendingQr", connectionId: "channel-wechat-local", pollToken: "poll-1" };
      },
      async pollConnect() {
        return { status: "connected", connectionId: "channel-wechat-local" };
      },
      async disconnect() {
        return { ok: true };
      }
    },
    byokTokenUsage: {
      async recordEvent() {
        return undefined;
      },
      async getSummary() {
        return byokUsageSummary();
      }
    },
    asr: {
      async transcribe() {
        return {
          text: "你好",
          modelId: "qwen3-asr-flash",
          provider: "aliyun",
          source: "byok",
          transcribedAt: "2026-06-15T10:00:00.000Z"
        };
      }
    },
    onboardingInsight: {
      async generateReport() {
        return {
          status: "ready",
          reportMarkdown: "初见报告",
          secondaryActions: [],
          diagnostics: {
            discoveredAgentCount: 1,
            sampledQueryCount: 1,
            usedLlm: false,
            elapsedMs: 1,
            agents: []
          }
        };
      },
      async *streamReport() {
        yield {
          type: "done",
          response: {
            status: "ready",
            reportMarkdown: "初见报告",
            secondaryActions: [],
            diagnostics: {
              discoveredAgentCount: 1,
              sampledQueryCount: 1,
              usedLlm: false,
              elapsedMs: 1,
              agents: []
            }
          }
        };
      }
    }
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
    asr: overrides.asr ?? asrView(),
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

function asrView() {
  return {
    provider: "aliyun",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen3-asr-flash",
    hasApiKey: false,
    apiKeyMasked: ""
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

function accountSession() {
  return {
    authenticated: true,
    isNewUser: false,
    profile: {
      userId: "user-1",
      email: "hello@example.com",
      phoneNumber: null,
      nickname: "hello",
      avatarUrl: null,
      planType: "free",
      hasFinishedGuide: false,
      region: null,
      registeredAt: "2026-06-02T10:00:00.000Z"
    }
  };
}

function byokUsageEvent() {
  return {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    metadata: {
      sessionKey: "cli:direct",
      provider: "openai",
      modelId: "gpt-4.1-mini"
    },
    rawUsage: { prompt_tokens: 10, completion_tokens: 20 },
    createdAt: "2026-06-11T10:00:00.000Z"
  };
}

function byokUsageSummary() {
  return {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    updatedAt: "2026-06-11T10:00:00.000Z",
    byKind: [{
      kind: "agent_chat",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
      eventCount: 1,
      updatedAt: "2026-06-11T10:00:00.000Z"
    }]
  };
}
