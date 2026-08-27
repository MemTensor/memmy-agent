/** App config service tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { createAppConfigService } from "../app-config-service.js";
import { createAppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import type {
  AppSettingsDto,
  ModelConfigView,
  OnboardingStateDto,
  PrivacySettingsDto,
  TokenUsageDto
} from "@memmy/local-api-contracts";

describe("AppConfigService", () => {
  it("updates app settings through the bootstrap repository", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push(patch);
          return {
            ...appSettings(),
            ...patch
          };
        }
      }
    });

    const result = await service.updateSettings({ theme: "dark", defaultLaunchMode: "pet" });

    expect(calls).toEqual([{ theme: "dark", defaultLaunchMode: "pet" }]);
    expect(result).toMatchObject({
      theme: "dark",
      defaultLaunchMode: "pet"
    });
  });

  it("updates scan preferences through the bootstrap repository", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateScanPreferences(patch) {
          calls.push(patch);
          return {
            autoScanKnownAgents: true,
            watchFileChanges: true,
            autoInjectSkill: Boolean(patch.autoInjectSkill)
          };
        }
      }
    });

    const result = await service.updateScanPreferences({ autoInjectSkill: true });

    expect(calls).toEqual([{ autoInjectSkill: true }]);
    expect(result).toMatchObject({ autoInjectSkill: true });
  });

  it("persists userMode without changing the model directory", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          return {
            ...appSettings(),
            ...patch
          };
        }
      },
      memmyConfigWriter: {
        async writeUserMode(mode) {
          calls.push({ runtimeMode: mode });
        },
        async readModelConfig() {
          calls.push("model:read");
          return modelConfigView();
        },
        async writeModelConfig(input) {
          calls.push({ model: input });
          return modelConfigView();
        },
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
          return projectionResult();
        },
        async clearAccountModelProjection() {
          return projectionResult();
        },
        async patchChannelConfig() {
          return undefined;
        },
        async patchMcpServerConfig() {
          return undefined;
        }
      }
    });

    await expect(service.updateSettings({ userMode: "byok" })).resolves.toMatchObject({ userMode: "byok" });
    await expect(service.updateSettings({ userMode: "account" })).resolves.toMatchObject({ userMode: "account" });

    expect(calls).toEqual([
      { runtimeMode: "byok" },
      { settings: { userMode: "byok" } },
      { runtimeMode: "account" },
      { settings: { userMode: "account" } }
    ]);
  });

  it("keeps completed onboarding when switching a completed user to BYOK mode", async () => {
    const calls: unknown[] = [];
    let userMode: AppSettingsDto["userMode"] = "account";
    const completedOnboarding: OnboardingStateDto = {
      ...onboardingState(),
      completed: true,
      currentStep: "completed",
      hasAcceptedTerms: true,
      acceptedTermsVersion: "2026-06-01",
      scanPermission: "scan_only",
      improvementProgram: "accepted",
      completedAt: "2026-06-20T12:00:00.000Z"
    };
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        getOnboardingState() {
          return userMode === "account" ? completedOnboarding : onboardingState();
        },
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          userMode = patch.userMode ?? userMode;
          return appSettings({ userMode });
        },
        updateOnboarding(patch) {
          calls.push({ onboarding: patch });
          return {
            ...onboardingState(),
            ...patch
          };
        }
      }
    });

    await expect(service.updateSettings({ userMode: "byok" })).resolves.toMatchObject({ userMode: "byok" });

    expect(calls).toEqual([
      {
        settings: {
          userMode: "byok"
        }
      },
      {
        onboarding: {
          completed: true,
          currentStep: "completed",
          completedAt: "2026-06-20T12:00:00.000Z",
          hasAcceptedTerms: true,
          acceptedTermsVersion: "2026-06-01",
          scanPermission: "scan_only",
          improvementProgram: "accepted"
        }
      }
    ]);
  });

  it("does not re-project saved image configuration when userMode changes", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          return {
            ...appSettings(),
            ...patch
          };
        }
      },
      modelConfigRepository: {
        get() {
          return modelConfigView({
            imageGen: {
              provider: "doubao",
              baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
              modelId: "doubao-seedream-4-0-250828",
              hasApiKey: true,
              apiKeyMasked: "sk-i••••cret",
              apiKey: "sk-image-secret"
            }
          });
        },
        upsert() {
          throw new Error("upsert should not be called");
        }
      },
      memmyConfigWriter: {
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
          return projectionResult("account");
        },
        async writeByokModelProjection(input, options) {
          calls.push({ byok: input, options });
          return projectionResult("byok");
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
          return projectionResult(profile);
        }
      }
    });

    await service.updateSettings({ userMode: "byok" });

    expect(calls).toEqual([{ settings: { userMode: "byok" } }]);
  });

  it("does not invoke a model writer that cannot affect userMode changes", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          return {
            ...appSettings(),
            ...patch
          };
        }
      },
      modelConfigRepository: {
        get() {
          calls.push("get-model-config");
          return modelConfigView();
        },
        upsert() {
          throw new Error("upsert should not be called");
        }
      },
      memmyConfigWriter: {
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
          return projectionResult("account");
        },
        async writeByokModelProjection(input, options) {
          calls.push({ byok: input, options });
          throw new Error("runtime projection failed");
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
          return projectionResult(profile);
        }
      }
    });

    await expect(service.updateSettings({ userMode: "byok" })).resolves.toMatchObject({ userMode: "byok" });
    expect(calls).toEqual([{ settings: { userMode: "byok" } }]);
  });

  it("saves BYOK model config without an active cloud account", async () => {
    const calls: unknown[] = [];
    let savedConfig = modelConfigView({
      hasApiKey: false,
      apiKeyMasked: "",
      memmyMemory: {
        summary: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: false,
          apiKeyMasked: ""
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: false,
          apiKeyMasked: ""
        }
      }
    });
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          return {
            ...appSettings(),
            ...patch
          };
        }
      },
      modelConfigRepository: {
        get() {
          calls.push("get-model-config");
          return savedConfig;
        },
        upsert(input) {
          calls.push({ upsert: input });
          savedConfig = modelConfigView({
            provider: input.provider,
            baseUrl: input.baseUrl,
            modelId: input.modelId,
            hasApiKey: true,
            apiKeyMasked: "sk-l••••cret",
            memmyMemory: {
              summary: {
                provider: input.memmyMemory?.summary.provider ?? input.provider,
                baseUrl: input.memmyMemory?.summary.baseUrl ?? input.baseUrl,
                modelId: input.memmyMemory?.summary.modelId ?? input.modelId,
                hasApiKey: true,
                apiKeyMasked: "sk-l••••cret"
              },
              evolution: {
                provider: input.memmyMemory?.evolution.provider ?? input.provider,
                baseUrl: input.memmyMemory?.evolution.baseUrl ?? input.baseUrl,
                modelId: input.memmyMemory?.evolution.modelId ?? input.modelId,
                hasApiKey: true,
                apiKeyMasked: "sk-l••••cret"
              }
            }
          });
          return savedConfig;
        }
      },
      memmyConfigWriter: {
        async readModelConfig() {
          calls.push("writer:read");
          return savedConfig;
        },
        async writeModelConfig(input) {
          calls.push({ writeModel: input });
          savedConfig = modelConfigView({
            hasApiKey: true,
            apiKeyMasked: "sk-l••••cret"
          });
          return savedConfig;
        },
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
        },
        async writeByokModelProjection(input, options) {
          calls.push({ byok: input, options });
          return projectionResult(options?.activate ? "byok" : "account");
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
        }
      }
    });

    await expect(
      service.setModelConfig(currentModelConfigInput("sk-local-secret"))
    ).resolves.toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      hasApiKey: true,
      apiKeyMasked: "sk-l••••cret",
      memmyMemory: {
        summary: {
          hasApiKey: true,
          apiKeyMasked: "sk-t••••cret"
        },
        evolution: {
          hasApiKey: true,
          apiKeyMasked: "sk-t••••cret"
        }
      }
    });
    await expect(service.updateSettings({ userMode: "byok" })).resolves.toMatchObject({ userMode: "byok" });

    expect(calls).toContainEqual({
      writeModel: expect.objectContaining({
        providers: expect.arrayContaining([expect.objectContaining({ apiKey: "sk-local-secret" })])
      })
    });
    expect(calls).toContainEqual({ settings: { userMode: "byok" } });
    expect(calls).not.toEqual([
      {
        upsert: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-local-secret",
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            }
          }
        }
      },
      {
        byok: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-local-secret",
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            }
          }
        },
        options: {
          activate: false
        }
      },
      {
        settings: {
          userMode: "byok"
        }
      },
      "get-model-config",
      {
        byok: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          embedding: {
            mode: "local"
          },
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini"
            }
          }
        },
        options: {
          activate: true
        }
      }
    ]);
  });

  it("reloads Memory after saving BYOK model config when BYOK mode is active", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        getAppSettings() {
          return appSettings({ userMode: "byok" });
        }
      },
      modelConfigRepository: {
        get() {
          throw new Error("get should not be called");
        },
        upsert(input) {
          calls.push({ upsert: input });
          return modelConfigView({
            provider: input.provider,
            baseUrl: input.baseUrl,
            modelId: input.modelId,
            hasApiKey: true,
            apiKeyMasked: "sk-l••••cret"
          });
        }
      },
      memmyConfigWriter: {
        async readModelConfig() {
          throw new Error("read should not be called");
        },
        async writeModelConfig(input) {
          calls.push({ writeModel: input });
          return modelConfigView({
            hasApiKey: true,
            apiKeyMasked: "sk-l••••cret"
          });
        },
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
          return projectionResult("account");
        },
        async writeByokModelProjection(input, options) {
          calls.push({ byok: input, options });
          return {
            changed: true,
            activeProfile: "byok" as const,
            activeProfileChanged: false,
            activeProfileAffected: true
          };
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
          return projectionResult(profile);
        }
      },
      memoryClient: {
        async reloadConfig(input) {
          calls.push({ reload: input });
        }
      }
    });

    await expect(
      service.setModelConfig(currentModelConfigInput("sk-local-secret"))
    ).resolves.toMatchObject({
      hasApiKey: true,
      apiKeyMasked: "sk-l••••cret"
    });

    expect(calls).toContainEqual({
      writeModel: expect.objectContaining({
        providers: expect.arrayContaining([expect.objectContaining({ apiKey: "sk-local-secret" })])
      })
    });
    expect(calls).toContainEqual({ reload: { reason: "model_config_saved" } });
    expect(calls).not.toEqual([
      {
        upsert: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-local-secret",
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            }
          }
        }
      },
      {
        byok: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-local-secret",
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-local-secret"
            }
          }
        },
        options: {
          activate: true
        }
      },
      { reload: { reason: "byok_model_saved" } }
    ]);
  });

  it("does not rewrite account models when userMode changes", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateAppSettings(patch) {
          calls.push({ settings: patch });
          return {
            ...appSettings(),
            ...patch
          };
        }
      },
      accountSessionRepository: {
        get() {
          return {
            authenticated: true as const,
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
        },
        getCloudUuid() {
          return "cloud-login-uuid";
        }
      },
      memmyConfigWriter: {
        async readModelConfig() {
          calls.push("writer:get");
          return modelConfigView();
        },
        async writeModelConfig(input) {
          calls.push({ writerSet: input });
          return modelConfigView();
        },
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
          return projectionResult("account");
        },
        async writeByokModelProjection(input) {
          calls.push({ byok: input });
          return projectionResult("byok");
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
          return projectionResult(profile);
        }
      }
    });

    await expect(service.updateSettings({ userMode: "account" })).resolves.toMatchObject({ userMode: "account" });

    expect(calls).toEqual([{ settings: { userMode: "account" } }]);
  });

  it("updates privacy, onboarding, and improvement program through the bootstrap repository", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updatePrivacy(patch) {
          calls.push({ privacy: patch });
          return {
            ...privacySettings(),
            ...patch
          };
        },
        updateOnboarding(patch) {
          calls.push({ onboarding: patch });
          return {
            ...onboardingState(),
            ...patch
          };
        }
      },
      accountSessionRepository: createAuthenticatedAccountSessionRepository(),
      cloudClient: {
        ...createCloudClientStub(),
        async getTokenUsage(input) {
          calls.push({ getTokenUsage: input });
          return tokenUsage();
        }
      }
    });

    await expect(service.updatePrivacy({ localOnlyMode: true })).resolves.toMatchObject({ localOnlyMode: true });
    await expect(service.updateOnboarding({ scanPermission: "scan_only" })).resolves.toMatchObject({
      scanPermission: "scan_only"
    });
    await expect(service.setImprovementProgram({ improvementProgram: "declined" })).resolves.toMatchObject({
      onboarding: { currentStep: "product_tour_required", improvementProgram: "declined" },
      privacy: { localOnlyMode: false },
      tokenUsage: { remainingTokens: 30000000 }
    });

    expect(calls).toEqual([
      { privacy: { localOnlyMode: true } },
      { onboarding: { scanPermission: "scan_only" } },
      { onboarding: { improvementProgram: "declined", currentStep: "product_tour_required" } },
      {
        getTokenUsage: {
          userId: "user-1",
          uuid: "cloud.login.uuid"
        }
      }
    ]);
  });

  it("accepting improvement program returns the cloud token usage snapshot", async () => {
    const calls: unknown[] = [];
    const grantedTokenUsage = tokenUsage({
      totalTokens: 35000000,
      usedTokens: 1000000,
      remainingTokens: 34000000,
      lastSyncedAt: "2026-06-05T10:00:00.000Z"
    });
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        updateOnboarding(patch) {
          calls.push({ onboarding: patch });
          return {
            ...onboardingState(),
            ...patch
          };
        },
        updatePrivacy(patch) {
          calls.push({ privacy: patch });
          return {
            ...privacySettings(),
            ...patch
          };
        },
        updateTokenUsage(usage) {
          calls.push({ tokenUsage: usage });
          return usage;
        }
      },
      accountSessionRepository: {
        get() {
          return {
            authenticated: true as const,
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
        },
        getCloudUuid() {
          return "cloud.login.uuid";
        }
      },
      cloudClient: {
        ...createCloudClientStub(),
        async grantImprovementProgramTokens(input) {
          calls.push({ grant: input });
          return grantedTokenUsage;
        }
      }
    });

    await expect(service.setImprovementProgram({ improvementProgram: "accepted" })).resolves.toEqual({
      onboarding: {
        ...onboardingState(),
        currentStep: "product_tour_required",
        improvementProgram: "accepted"
      },
      privacy: {
        ...privacySettings(),
        allowMemoryImprovementUpload: true
      },
      tokenUsage: grantedTokenUsage
    });

    expect(calls).toEqual([
      { onboarding: { improvementProgram: "accepted", currentStep: "product_tour_required" } },
      { privacy: { allowMemoryImprovementUpload: true } },
      {
        grant: {
          uuid: "cloud.login.uuid"
        }
      }
    ]);
  });

  it("refreshes account token usage from cloud", async () => {
    const calls: unknown[] = [];
    const cloudTokenUsage = tokenUsage({
      totalTokens: 40000000,
      usedTokens: 900000,
      remainingTokens: 39100000,
      lastSyncedAt: "2026-06-24T10:00:00.000Z"
    });
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub()
      },
      accountSessionRepository: {
        get() {
          return {
            authenticated: true as const,
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
        },
        getCloudUuid() {
          return "cloud.login.uuid";
        }
      },
      cloudClient: {
        ...createCloudClientStub(),
        async getTokenUsage(input) {
          calls.push({ getTokenUsage: input });
          return cloudTokenUsage;
        }
      }
    });

    await expect(service.getTokenUsage()).resolves.toEqual(cloudTokenUsage);
    expect(calls).toEqual([
      {
        getTokenUsage: {
          userId: "user-1",
          uuid: "cloud.login.uuid"
        }
      }
    ]);
  });

  it("does not fall back to cached account token usage when the cloud request fails", async () => {
    const service = createAppConfigService({
      bootstrapRepository: createBootstrapRepositoryStub(),
      accountSessionRepository: createAuthenticatedAccountSessionRepository(),
      cloudClient: {
        ...createCloudClientStub(),
        async getTokenUsage() {
          throw new Error("cloud token usage unavailable");
        }
      }
    });

    await expect(service.getTokenUsage()).rejects.toThrow("cloud token usage unavailable");
  });

  it("reads and stores model config through the model config repository", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: createBootstrapRepositoryStub(),
      modelConfigRepository: {
        get() {
          calls.push("get");
          return {
            provider: "openai_compatible",
            baseUrl: "https://api.example.com/v1",
            modelId: "gpt-4.1-mini",
            hasApiKey: true,
            apiKeyMasked: "sk-t••••cret",
            embedding: localEmbeddingView(),
            memmyMemory: {
              summary: {
                provider: "openai_compatible",
                baseUrl: "https://api.example.com/v1",
                modelId: "gpt-4.1-mini",
                hasApiKey: true,
                apiKeyMasked: "sk-t••••cret"
              },
              evolution: {
                provider: "openai_compatible",
                baseUrl: "https://api.example.com/v1",
                modelId: "gpt-4.1-mini",
                hasApiKey: true,
                apiKeyMasked: "sk-t••••cret"
              }
            },
            updatedAt: "2026-06-02T10:00:00.000Z"
          };
        },
        upsert(input) {
          calls.push(input);
          return {
            provider: input.provider,
            baseUrl: input.baseUrl,
            modelId: input.modelId,
            hasApiKey: Boolean(input.apiKey),
            apiKeyMasked: "sk-t••••cret",
            embedding: localEmbeddingView(),
            memmyMemory: {
              summary: {
                provider: input.memmyMemory?.summary.provider ?? input.provider,
                baseUrl: input.memmyMemory?.summary.baseUrl ?? input.baseUrl,
                modelId: input.memmyMemory?.summary.modelId ?? input.modelId,
                hasApiKey: true,
                apiKeyMasked: "sk-t••••cret"
              },
              evolution: {
                provider: input.memmyMemory?.evolution.provider ?? input.provider,
                baseUrl: input.memmyMemory?.evolution.baseUrl ?? input.baseUrl,
                modelId: input.memmyMemory?.evolution.modelId ?? input.modelId,
                hasApiKey: true,
                apiKeyMasked: "sk-t••••cret"
              }
            },
            updatedAt: "2026-06-02T10:00:00.000Z"
          };
        }
      },
      memmyConfigWriter: {
        async readModelConfig() {
          calls.push("writer:get");
          return modelConfigView();
        },
        async writeModelConfig(input) {
          calls.push({ writerSet: input });
          return modelConfigView();
        },
        async writeAccountModelProjection(input) {
          calls.push({ account: input });
        },
        async writeByokModelProjection(input, options) {
          calls.push({ byok: input, options });
        },
        async writeActiveMemoryProfile(profile) {
          calls.push({ activeProfile: profile });
        }
      }
    });

    await expect(service.getModelConfig()).resolves.toMatchObject({
      provider: "openai_compatible",
      hasApiKey: true,
      apiKeyMasked: "sk-t••••cret"
    });
    await expect(
      service.setModelConfig(currentModelConfigInput("sk-test-secret"))
    ).resolves.toMatchObject({
      hasApiKey: true,
      apiKeyMasked: "sk-t••••cret"
    });
    expect(calls).toContain("writer:get");
    expect(calls).toContainEqual({
      writerSet: expect.objectContaining({
        providers: expect.arrayContaining([expect.objectContaining({ apiKey: "sk-test-secret" })])
      })
    });
    expect(calls).not.toEqual([
      "get",
      {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "gpt-4.1-mini",
        apiKey: "sk-test-secret",
        memmyMemory: {
          summary: {
            provider: "openai_compatible",
            baseUrl: "https://api.example.com/v1",
            modelId: "gpt-4.1-mini",
            apiKey: "sk-test-secret"
          },
          evolution: {
            provider: "openai_compatible",
            baseUrl: "https://api.example.com/v1",
            modelId: "gpt-4.1-mini",
            apiKey: "sk-test-secret"
          }
        }
      },
      {
        byok: {
          provider: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-test-secret",
          memmyMemory: {
            summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-test-secret"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              modelId: "gpt-4.1-mini",
              apiKey: "sk-test-secret"
            }
          }
        },
        options: {
          activate: false
        }
      }
    ]);
  });

  it("tests model config through the injected validator without storing secrets", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: createBootstrapRepositoryStub(),
      modelConfigTester: {
        async test(input) {
          calls.push(input);
          return {
            ok: false,
            message: "API Key 无效或模型不可用",
            checkedAt: "2026-06-05T10:00:00.000Z"
          };
        }
      }
    });

    await expect(
      service.testModelConfig({
        provider: "openai_compatible",
        endpointId: "chat",
        protocol: "openai-chat-completions",
        apiBase: "https://api.openai.com/v1",
        modelId: "gpt-5.5",
        apiKey: "sk-test-secret"
      })
    ).resolves.toEqual({
      ok: false,
      message: "API Key 无效或模型不可用",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });

    expect(calls).toEqual([
      {
        provider: "openai_compatible",
        endpointId: "chat",
        protocol: "openai-chat-completions",
        apiBase: "https://api.openai.com/v1",
        modelId: "gpt-5.5",
        apiKey: "sk-test-secret"
      }
    ]);
  });

  it("does not project the post-write catalog back into legacy SQLite model config", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-app-config-secret-switch-"));
    const configPath = join(root, "config.yaml");
    const store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    try {
      writeFileSync(configPath, YAML.stringify({
        app: { userMode: "byok" },
        agents: { defaults: { modelPreset: "preset-a" } },
        providers: {
          openai: {
            apiKey: "secret-a",
            endpoints: { chat: { apiBase: "https://a.example.test/v1", protocol: "openai-chat-completions" } }
          },
          deepseek: {
            apiKey: "secret-b",
            endpoints: { chat: { apiBase: "https://b.example.test/v1", protocol: "openai-chat-completions" } }
          }
        },
        modelPresets: {
          "preset-a": {
            provider: "openai", endpoint: "chat", model: "model-a", source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          },
          "preset-b": {
            provider: "deepseek", endpoint: "chat", model: "model-b", source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          }
        },
        modelAssignments: {
          byok: {
            agent: { candidates: ["preset-a"], default: "preset-a" },
            memorySummary: "preset-a", memoryEvolution: "preset-a",
            embedding: null, asr: null, imageGeneration: null
          },
          account: {
            agent: { candidates: [], default: null },
            memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null
          }
        }
      }), "utf8");
      const legacyBefore = store.db.prepare("SELECT * FROM account_model_config ORDER BY uuid").all();
      const writer = createMemmyConfigWriter({ configPath });
      const current = await writer.readModelConfig!();
      const service = createAppConfigService({
        bootstrapRepository: createBootstrapRepositoryStub(),
        memmyConfigWriter: writer
      });

      await service.setModelConfig({
        configRevision: current.configRevision,
        providers: [{
          provider: "deepseek",
          apiKey: "",
          endpoints: [{ endpointId: "chat", apiBase: "https://b.example.test/v1", protocol: "openai-chat-completions" }],
          models: [{
            presetId: "preset-b", endpointId: "chat", model: "model-b", source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          }]
        }],
        modelAssignments: {
          byok: {
            agent: { candidates: ["preset-b"], default: "preset-b" },
            memorySummary: "preset-b", memoryEvolution: "preset-b",
            embedding: null, asr: null, imageGeneration: null
          },
          account: {
            agent: { candidates: [], default: null },
            memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null
          }
        }
      });

      await expect(writer.readEndpointApiKey?.("deepseek", "chat")).resolves.toBe("secret-b");
      expect(store.db.prepare("SELECT * FROM account_model_config ORDER BY uuid").all()).toEqual(legacyBefore);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tests saved model config with the stored secret when no plaintext key is provided", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: createBootstrapRepositoryStub(),
      memmyConfigWriter: {
        async readEndpointApiKey(provider, endpointId) {
          calls.push({ provider, endpointId });
          return "sk-stored-secret";
        },
        async writeAccountModelProjection() {
          throw new Error("not used");
        },
        async patchChannelConfig() {
          throw new Error("not used");
        },
        async patchMcpServerConfig() {
          throw new Error("not used");
        }
      },
      modelConfigTester: {
        async test(input) {
          calls.push({ testInput: input });
          return {
            ok: true,
            message: "连接成功",
            checkedAt: "2026-06-05T10:00:00.000Z"
          };
        }
      }
    });

    await expect(
      service.testModelConfig({
        provider: "openai_compatible",
        endpointId: "chat",
        protocol: "openai-chat-completions",
        apiBase: "https://api.openai.com/v1",
        modelId: "gpt-4o"
      } as any)
    ).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual([
      { provider: "openai", endpointId: "chat" },
      {
        testInput: {
          provider: "openai_compatible",
          endpointId: "chat",
          protocol: "openai-chat-completions",
          apiBase: "https://api.openai.com/v1",
          modelId: "gpt-4o",
          apiKey: "sk-stored-secret"
        }
      }
    ]);
  });

  it("lists avatars and stores avatar and skin through the bootstrap repository", async () => {
    const calls: unknown[] = [];
    const service = createAppConfigService({
      bootstrapRepository: {
        ...createBootstrapRepositoryStub(),
        setAvatarSkin(input) {
          calls.push(input);
          return {
            ...appSettings(),
            avatarId: input.avatarId ?? "memmy-default",
            skinId: input.skinId ?? "default"
          };
        }
      }
    });

    const avatars = await service.listAvatars();
    expect(avatars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memmy-default",
          kind: "image"
        })
      ])
    );
    expect(avatars.length).toBeGreaterThanOrEqual(3);
    await expect(service.setAvatar({ avatarId: "memmy-focus" })).resolves.toEqual({ avatarId: "memmy-focus" });
    await expect(service.setSkin({ skinId: "midnight" })).resolves.toEqual({ skinId: "midnight" });
    expect(calls).toEqual([{ avatarId: "memmy-focus" }, { skinId: "midnight" }]);
  });
});

function createBootstrapRepositoryStub() {
  return {
    getAppSettings: appSettings,
    getOnboardingState: onboardingState,
    getPrivacySettings: privacySettings,
    getScanPreferences() {
      return {
        autoScanKnownAgents: true,
        watchFileChanges: true,
        autoInjectSkill: false
      };
    },
    updateScanPreferences(patch: { autoScanKnownAgents?: boolean; watchFileChanges?: boolean; autoInjectSkill?: boolean }) {
      return {
        autoScanKnownAgents: true,
        watchFileChanges: true,
        autoInjectSkill: false,
        ...patch
      };
    },
    getTokenUsage() {
      return tokenUsage();
    },
    updateTokenUsage(usage: TokenUsageDto) {
      return usage;
    }
  };
}

function createAuthenticatedAccountSessionRepository() {
  return {
    get() {
      return {
        authenticated: true as const,
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
    },
    getCloudUuid() {
      return "cloud.login.uuid";
    }
  };
}

function appSettings(overrides: Partial<AppSettingsDto> = {}): AppSettingsDto {
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

function currentModelConfigInput(apiKey: string): any {
  const emptyAssignment = {
    agent: { candidates: [], default: null },
    memorySummary: null,
    memoryEvolution: null,
    embedding: null,
    asr: null,
    imageGeneration: null
  };
  return {
    configRevision: "revision-1",
    providers: [{
      provider: "openai",
      apiKey,
      endpoints: [{
        endpointId: "chat",
        apiBase: "https://api.example.com/v1",
        protocol: "openai-chat-completions"
      }],
      models: [{
        presetId: "byok-agent",
        endpointId: "chat",
        model: "gpt-4.1-mini",
        source: "byok",
        capabilities: ["agent", "memory_summary", "memory_evolution"]
      }]
    }],
    modelAssignments: {
      byok: {
        ...emptyAssignment,
        agent: { candidates: ["byok-agent"], default: "byok-agent" },
        memorySummary: "byok-agent",
        memoryEvolution: "byok-agent"
      },
      account: emptyAssignment
    }
  };
}

function modelConfigView(overrides: Partial<ModelConfigView> = {}): ModelConfigView {
  return {
    provider: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    modelId: "gpt-4.1-mini",
    hasApiKey: true,
    apiKeyMasked: "sk-t••••cret",
    embedding: localEmbeddingView(),
    memmyMemory: {
      summary: {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeyMasked: "sk-t••••cret"
      },
      evolution: {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        modelId: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeyMasked: "sk-t••••cret"
      }
    },
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides
  };
}

function localEmbeddingView(): ModelConfigView["embedding"] {
  return {
    mode: "local",
    baseUrl: null,
    modelId: null,
    hasApiKey: false,
    apiKeyMasked: ""
  };
}

function projectionResult(activeProfile: "account" | "byok") {
  return {
    changed: true,
    activeProfile,
    activeProfileChanged: false,
    activeProfileAffected: false
  };
}

function privacySettings(): PrivacySettingsDto {
  return {
    telemetryOptIn: false,
    crashReportOptIn: false,
    allowMemoryImprovementUpload: false,
    localOnlyMode: false
  };
}

function onboardingState(): OnboardingStateDto {
  return {
    completed: false,
    currentStep: "scan_permission_required",
    hasAcceptedTerms: false,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "unset",
    completedAt: null
  };
}

function tokenUsage(overrides: Partial<TokenUsageDto> = {}): TokenUsageDto {
  return {
    planName: "体验 Token",
    totalTokens: 30000000,
    usedTokens: 0,
    remainingTokens: 30000000,
    expiresAt: null,
    lastSyncedAt: null,
    sceneUsages: [],
    ...overrides
  };
}

function createCloudClientStub() {
  return {
    async health() {
      return { status: "ok" as const, checkedAt: "2026-06-05T10:00:00.000Z" };
    },
    async sendEmailCode() {
      return undefined;
    },
    async sendPhoneCode() {
      return undefined;
    },
    async login() {
      throw new Error("login not used");
    },
    async logout() {
      return undefined;
    },
    async getTokenUsage() {
      return tokenUsage();
    },
    async grantImprovementProgramTokens() {
      return tokenUsage();
    },
    async sendTelemetry() {
      return undefined;
    },
    async checkRelease() {
      return { updateAvailable: false };
    }
  };
}
