/** Bootstrap service tests. */
import { describe, expect, it } from "vitest";
import type { AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createBootstrapService } from "../bootstrap-service.js";

describe("BootstrapService", () => {
  it("refreshes token usage from cloud for authenticated account sessions", async () => {
    const calls: unknown[] = [];
    const cloudTokenUsage = {
      planName: "体验 Token",
      totalTokens: 35000000,
      usedTokens: 1000000,
      remainingTokens: 34000000,
      expiresAt: null,
      lastSyncedAt: "2026-06-05T10:00:00.000Z"
    };
    const service = createBootstrapService({
      appStateStore: {
        repositories: {
          bootstrap: {
            ...createBootstrapRepositoryStub()
          },
          accountSession: {
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
          }
        }
      } as AppStateStore,
      memoryClient: {
        async health() {
          return {
            ok: true,
            version: "test",
            uptimeMs: 0,
            mode: "dev",
            storage: { backend: "sqlite", schemaVersion: "test", ready: true },
            capabilities: { routes: [], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: false },
            activeProfile: "byok",
            models: memoryModels(),
            serverTime: "2026-06-05T10:00:00.000Z"
          };
        }
      } as never,
      cloudClient: {
        async health() {
          return { status: "ok" as const, checkedAt: "2026-06-05T10:00:00.000Z" };
        },
        async getTokenUsage(input) {
          calls.push({ getTokenUsage: input });
          return cloudTokenUsage;
        }
      } as never
    });

    await expect(service.getBootstrap()).resolves.toMatchObject({
      tokenUsage: {
        remainingTokens: 34000000,
        lastSyncedAt: "2026-06-05T10:00:00.000Z"
      }
    });
    expect(calls).toEqual([
      {
        getTokenUsage: {
          userId: "user-1",
          uuid: "cloud.login.uuid"
        }
      }
    ]);
  });

  it("does not fall back to cached token usage when the authenticated cloud refresh fails during bootstrap", async () => {
    const calls: unknown[] = [];
    const service = createBootstrapService({
      appStateStore: {
        repositories: {
          bootstrap: {
            ...createBootstrapRepositoryStub(),
            getTokenUsage() {
              throw new Error("cached token usage should not be read");
            }
          },
          accountSession: {
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
          }
        }
      } as AppStateStore,
      memoryClient: {
        async health() {
          return {
            ok: true,
            version: "test",
            uptimeMs: 0,
            mode: "dev",
            storage: { backend: "sqlite", schemaVersion: "test", ready: true },
            capabilities: { routes: [], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: false },
            activeProfile: "byok",
            models: memoryModels(),
            serverTime: "2026-06-05T10:00:00.000Z"
          };
        }
      } as never,
      cloudClient: {
        async health() {
          return { status: "ok" as const, checkedAt: "2026-06-05T10:00:00.000Z" };
        },
        async getTokenUsage(input) {
          calls.push({ getTokenUsage: input });
          throw new Error("cloud token usage unavailable");
        }
      } as never
    });

    await expect(service.getBootstrap()).resolves.toMatchObject({
      tokenUsage: {
        totalTokens: 30000000,
        usedTokens: 0,
        remainingTokens: 30000000
      }
    });
    expect(calls).toEqual([
      {
        getTokenUsage: {
          userId: "user-1",
          uuid: "cloud.login.uuid"
        }
      }
    ]);
  });

  it("账号模式下云端标记已发放改进计划时把本地 improvementProgram 投影为 accepted", async () => {
    const service = createBootstrapService(
      createAuthenticatedAccountOptions({
        async getAccountInfo() {
          return { improvementProgramGranted: true } as never;
        },
        async getTokenUsage() {
          return {
            planName: "体验 Token",
            totalTokens: 35000000,
            usedTokens: 0,
            remainingTokens: 35000000,
            expiresAt: null,
            lastSyncedAt: null
          };
        }
      })
    );

    await expect(service.getBootstrap()).resolves.toMatchObject({
      onboarding: { improvementProgram: "accepted" }
    });
  });

  it("账号模式下云端标记未发放时保持本地 improvementProgram 为 unset", async () => {
    const service = createBootstrapService(
      createAuthenticatedAccountOptions({
        async getAccountInfo() {
          return { improvementProgramGranted: false } as never;
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
        }
      })
    );

    await expect(service.getBootstrap()).resolves.toMatchObject({
      onboarding: { improvementProgram: "unset" }
    });
  });

  it("云端账号信息读取失败时改进计划对账 fail-open 保持 unset", async () => {
    const service = createBootstrapService(
      createAuthenticatedAccountOptions({
        async getAccountInfo() {
          throw new Error("cloud account info unavailable");
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
        }
      })
    );

    await expect(service.getBootstrap()).resolves.toMatchObject({
      onboarding: { improvementProgram: "unset" }
    });
  });

  it("把云端下发的法务协议外链并入 bootstrap.legal", async () => {
    const legal = {
      terms: {
        "zh-CN": "https://legal.memtensor.cn/terms?lang=zh-CN",
        "en-US": "https://legal.memtensor.cn/terms?lang=en-US"
      },
      data: {
        "zh-CN": "https://legal.memtensor.cn/data?lang=zh-CN",
        "en-US": "https://legal.memtensor.cn/data?lang=en-US"
      }
    };
    const service = createBootstrapService(createUnauthenticatedOptions({ getLegalUrls: async () => legal }));

    await expect(service.getBootstrap()).resolves.toMatchObject({ legal });
  });

  it("云端取不到法务协议外链时 bootstrap 不带 legal", async () => {
    const service = createBootstrapService(createUnauthenticatedOptions({ getLegalUrls: async () => undefined }));

    const bootstrap = await service.getBootstrap();

    expect(bootstrap.legal).toBeUndefined();
  });

  it("云端读取法务协议外链抛错时 bootstrap 不带 legal 且不报错", async () => {
    const service = createBootstrapService(
      createUnauthenticatedOptions({
        getLegalUrls: async () => {
          throw new Error("cloud legal endpoint down");
        }
      })
    );

    const bootstrap = await service.getBootstrap();

    expect(bootstrap.legal).toBeUndefined();
  });

  it("把云端下发的赠送活动开关并入 bootstrap.promotions", async () => {
    const promotions = { loginBanner: true, improvementGift: false, applyMore: true };
    const service = createBootstrapService(createUnauthenticatedOptions({ getPromotions: async () => promotions }));

    await expect(service.getBootstrap()).resolves.toMatchObject({ promotions });
  });

  it("云端取不到赠送活动开关时 bootstrap.promotions 回退全开", async () => {
    const service = createBootstrapService(createUnauthenticatedOptions({ getPromotions: async () => undefined }));

    const bootstrap = await service.getBootstrap();

    expect(bootstrap.promotions).toEqual({ loginBanner: true, improvementGift: true, applyMore: true });
  });

  it("云端读取赠送活动开关抛错时 bootstrap.promotions 回退全开且不报错", async () => {
    const service = createBootstrapService(
      createUnauthenticatedOptions({
        getPromotions: async () => {
          throw new Error("cloud promotions endpoint down");
        }
      })
    );

    const bootstrap = await service.getBootstrap();

    expect(bootstrap.promotions).toEqual({ loginBanner: true, improvementGift: true, applyMore: true });
  });
});

/** Creates authenticated account-mode options for improvement-program reconciliation tests. */
function createAuthenticatedAccountOptions(cloudOverrides: Record<string, unknown>) {
  return {
    appStateStore: {
      repositories: {
        bootstrap: createBootstrapRepositoryStub(),
        accountSession: {
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
        }
      }
    } as AppStateStore,
    memoryClient: {
      async health() {
        return {
          ok: true,
          version: "test",
          uptimeMs: 0,
          mode: "dev",
          storage: { backend: "sqlite", schemaVersion: "test", ready: true },
          capabilities: { routes: [], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: false },
          activeProfile: "byok",
          models: memoryModels(),
          serverTime: "2026-06-05T10:00:00.000Z"
        };
      }
    } as never,
    cloudClient: {
      async health() {
        return { status: "ok" as const, checkedAt: "2026-06-05T10:00:00.000Z" };
      },
      ...cloudOverrides
    } as never
  };
}

/** Creates create unauthenticated options. */
function createUnauthenticatedOptions(cloudOverrides: Record<string, unknown>) {
  return {
    appStateStore: {
      repositories: {
        bootstrap: createBootstrapRepositoryStub(),
        accountSession: {
          get() {
            return { authenticated: false as const };
          },
          getCloudUuid() {
            return null;
          }
        }
      }
    } as AppStateStore,
    memoryClient: {
      async health() {
        return {
          ok: true,
          version: "test",
          uptimeMs: 0,
          mode: "dev",
          storage: { backend: "sqlite", schemaVersion: "test", ready: true },
          capabilities: { routes: [], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: false },
          activeProfile: "byok",
          models: memoryModels(),
          serverTime: "2026-06-05T10:00:00.000Z"
        };
      }
    } as never,
    cloudClient: {
      async health() {
        return { status: "ok" as const, checkedAt: "2026-06-05T10:00:00.000Z" };
      },
      ...cloudOverrides
    } as never
  };
}

function createBootstrapRepositoryStub() {
  return {
    getAppSettings() {
      return {
        userMode: "account",
        language: "system",
        theme: "system",
        autoUpdateEnabled: true,
        defaultLaunchMode: "last",
        avatarId: "memmy-default",
        skinId: "default"
      };
    },
    getOnboardingState() {
      return {
        completed: false,
        currentStep: "scan_permission_required",
        hasAcceptedTerms: false,
        acceptedTermsVersion: null,
        scanPermission: "unset",
        improvementProgram: "unset",
        completedAt: null
      };
    },
    updateOnboarding(patch: Record<string, unknown>) {
      return {
        completed: false,
        currentStep: "scan_permission_required",
        hasAcceptedTerms: false,
        acceptedTermsVersion: null,
        scanPermission: "unset",
        improvementProgram: "unset",
        completedAt: null,
        ...patch
      };
    },
    getPrivacySettings() {
      return {
        telemetryOptIn: false,
        crashReportOptIn: false,
        allowMemoryImprovementUpload: false,
        localOnlyMode: false
      };
    },
    getScanPreferences() {
      return {
        autoScanKnownAgents: true,
        watchFileChanges: true,
        autoInjectSkill: false
      };
    },
    getTokenUsage() {
      return {
        planName: "体验 Token",
        totalTokens: 30000000,
        usedTokens: 0,
        remainingTokens: 30000000,
        expiresAt: null,
        lastSyncedAt: null
      };
    }
  };
}

function memoryModels() {
  return {
    summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
    evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
    embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
  };
}
