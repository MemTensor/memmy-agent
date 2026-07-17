/** Account service tests. */
import { describe, expect, it } from "vitest";
import { createAccountService } from "../account-service.js";

describe("AccountService", () => {
  it("sends verification codes through cloud-client and rate-limits by channel address", async () => {
    const calls: string[] = [];
    let lastCodeSentAt: string | null = null;
    const service = createAccountService({
      now: () => new Date("2026-06-02T10:00:00.000Z"),
      cloudClient: {
        ...createCloudClientStub(),
        async sendEmailCode(input) {
          calls.push(`email:${input.email}:${input.zhEnv}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        getLastCodeSentAt() {
          return lastCodeSentAt;
        },
        markCodeSent(_key, at) {
          lastCodeSentAt = at;
          calls.push(`mark:${at}`);
        }
      }
    });

    await expect(service.sendCode({ channel: "email", email: "hello@example.com", locale: "zh" })).resolves.toEqual({
      ok: true,
      resendAfterSec: 60
    });

    lastCodeSentAt = "2026-06-02T09:59:45.000Z";
    await expect(service.sendCode({ channel: "email", email: "hello@example.com", locale: "zh" })).resolves.toEqual({
      ok: true,
      resendAfterSec: 45
    });

    expect(calls).toEqual(["email:hello@example.com:true", "mark:2026-06-02T10:00:00.000Z"]);
  });

  it("passes locale as zhEnv for email and phone verification templates", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      now: () => new Date("2026-06-02T10:00:00.000Z"),
      cloudClient: {
        ...createCloudClientStub(),
        async sendEmailCode(input) {
          calls.push(`email:${input.email}:${input.zhEnv}`);
        },
        async sendPhoneCode(input) {
          calls.push(`phone:${input.phoneNumber}:${input.zhEnv}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        getLastCodeSentAt() {
          return null;
        },
        markCodeSent(_key, at) {
          calls.push(`mark:${at}`);
        }
      }
    });

    await expect(service.sendCode({ channel: "email", email: "hello@example.com", locale: "en" })).resolves.toEqual({
      ok: true,
      resendAfterSec: 60
    });
    await expect(service.sendCode({ channel: "phone", phoneNumber: "13800138000", locale: "zh" })).resolves.toEqual({
      ok: true,
      resendAfterSec: 60
    });

    expect(calls).toEqual([
      "email:hello@example.com:false",
      "mark:2026-06-02T10:00:00.000Z",
      "phone:13800138000:true",
      "mark:2026-06-02T10:00:00.000Z"
    ]);
  });

  it("logs in through cloud-client and stores uuid through account session repository", async () => {
    const calls: unknown[] = [];
    const service = createAccountService({
      now: () => new Date("2026-06-02T10:00:00.000Z"),
      cloudClient: {
        ...createCloudClientStub(),
        async login(input) {
          calls.push({ login: input });
          return {
            uuid: "cloud.login.uuid",
            accountUuid: "cloud-account-user-1",
            isNewUser: true,
            profile: cloudProfile()
          };
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        upsert(input) {
          calls.push({ upsert: input });
          return {
            authenticated: true,
            isNewUser: true,
            profile: {
              userId: input.profile.userId,
              email: input.profile.email,
              phoneNumber: input.profile.phoneNumber,
              nickname: input.profile.nickname,
              avatarUrl: input.profile.avatarUrl,
              planType: input.profile.planType,
              hasFinishedGuide: input.profile.hasFinishedGuide,
              region: input.profile.region,
              registeredAt: input.profile.registeredAt
            }
          };
        }
      }
    });

    const result = await service.verifyCode({
      channel: "email",
      email: "hello@example.com",
      verificationCode: "123456",
      loginSource: "Memmy"
    });

    expect(result).toMatchObject({
      authenticated: true,
      isNewUser: true,
      profile: {
        email: "hello@example.com",
        nickname: "hello"
      }
    });
    expect(JSON.stringify(result)).not.toContain("cloud.login.uuid");
    expect(calls).toEqual([
      {
        login: {
          email: "hello@example.com",
          verificationCode: "123456",
          loginSource: "Memmy"
        }
      },
      {
        upsert: {
          profile: cloudProfile(),
          isNewUser: true,
          uuid: "cloud-account-user-1",
          cloudUuid: "cloud.login.uuid"
        }
      },
      {
        upsert: {
          profile: cloudProfile(),
          isNewUser: true
        }
      }
    ]);
  });

  it("persists cloud login uuid into Memmy config before storing the local account session", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async login() {
          calls.push("login");
          return {
            uuid: "cloud.login.uuid",
            accountUuid: "cloud-account-user-1",
            isNewUser: true,
            profile: cloudProfile()
          };
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        upsert(input) {
          calls.push(`upsert:${input.uuid ?? "no-uuid"}:${input.cloudUuid ?? "no-cloud-uuid"}`);
          return {
            authenticated: true,
            isNewUser: input.isNewUser ?? null,
            profile: input.profile
          };
        }
      },
      memmyConfigWriter: {
        async writeAccountModelProjection(input) {
          calls.push(`write:${input.cloudUuid ?? "no-cloud"}:${input.userId ?? "no-user"}`);
        },
        async writeByokModelProjection() {
          calls.push("write-byok");
        }
      }
    });

    await expect(
      service.verifyCode({
        channel: "email",
        email: "hello@example.com",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).resolves.toMatchObject({
      authenticated: true,
      profile: {
        email: "hello@example.com"
      }
    });
    expect(calls).toEqual([
      "login",
      "write:cloud.login.uuid:user-1",
      "upsert:cloud-account-user-1:cloud.login.uuid",
      "upsert:no-uuid:no-cloud-uuid"
    ]);
  });

  it("keeps cloud new-user judgment when the same registered account is first seen locally", async () => {
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async login() {
          return {
            uuid: "cloud.login.uuid",
            accountUuid: "cloud-account-user-1",
            isNewUser: false,
            profile: cloudProfile()
          };
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        upsert(input) {
          return {
            authenticated: true,
            isNewUser: input.isNewUser ?? true,
            profile: input.profile
          };
        }
      }
    });

    await expect(
      service.verifyCode({
        channel: "email",
        email: "hello@example.com",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).resolves.toMatchObject({
      authenticated: true,
      isNewUser: false,
      profile: {
        email: "hello@example.com"
      }
    });
  });

  it("uses agentUser info after login to decide whether the current machine should show guide", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async login() {
          calls.push("cloud-login");
          return {
            uuid: "cloud.login.uuid",
            accountUuid: "cloud-account-user-1",
            isNewUser: false,
            profile: { ...cloudProfile(), hasFinishedGuide: true }
          };
        },
        async getAccountInfo(input) {
          calls.push(`cloud-info:${input.uuid}`);
          return { ...cloudProfile(), hasFinishedGuide: false };
        },
        async updateAccountGuide(input) {
          calls.push(`cloud-update:${input.uuid}:${input.hasFinishedGuide}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        upsert(input) {
          calls.push(`local-upsert:${input.profile.hasFinishedGuide}:${input.cloudUuid ?? "no-cloud-uuid"}`);
          return {
            authenticated: true,
            isNewUser: input.isNewUser ?? false,
            profile: input.profile
          };
        }
      }
    });

    await expect(
      service.verifyCode({
        channel: "email",
        email: "hello@example.com",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).resolves.toMatchObject({
      authenticated: true,
      profile: {
        hasFinishedGuide: false
      }
    });
    expect(calls).toEqual([
      "cloud-login",
      "local-upsert:true:cloud.login.uuid",
      "cloud-info:cloud.login.uuid",
      "local-upsert:false:no-cloud-uuid"
    ]);
  });

  it("updates local profile, reads session, and logs out locally", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      now: () => new Date("2026-06-02T10:00:00.000Z"),
      cloudClient: createCloudClientStub(),
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        get() {
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
        },
        upsert(input) {
          calls.push(`upsert:${input.profile.nickname}:${input.uuid ?? "no-uuid"}`);
          return {
            authenticated: true,
            isNewUser: false,
            profile: {
              userId: input.profile.userId,
              email: input.profile.email,
              phoneNumber: input.profile.phoneNumber,
              nickname: input.profile.nickname,
              avatarUrl: input.profile.avatarUrl,
              planType: input.profile.planType,
              hasFinishedGuide: input.profile.hasFinishedGuide,
              region: input.profile.region,
              registeredAt: input.profile.registeredAt
            }
          };
        },
        clear() {
          calls.push("clear");
        }
      }
    });

    await expect(service.getSession()).resolves.toMatchObject({ authenticated: true });
    await expect(service.updateProfile({ nickname: "Memmy User" })).resolves.toMatchObject({
      nickname: "Memmy User"
    });
    await expect(service.logout()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["upsert:Memmy User:no-uuid", "clear"]);
  });

  it("updates cloud profile before storing the nickname locally", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async updateAccountProfile(input) {
          calls.push(`cloud-profile:${input.uuid}:${input.userName ?? "no-user-name"}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        get() {
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
        },
        getCloudUuid() {
          return "cloud.login.uuid";
        },
        upsert(input) {
          calls.push(`local-upsert:${input.profile.nickname}`);
          return {
            authenticated: true,
            isNewUser: false,
            profile: input.profile
          };
        }
      }
    });

    await expect(service.updateProfile({ nickname: "Memmy User" })).resolves.toMatchObject({
      nickname: "Memmy User"
    });
    expect(calls).toEqual(["cloud-profile:cloud.login.uuid:Memmy User", "local-upsert:Memmy User"]);
  });

  it("refreshes guide completion from cloud info without marking it finished before entering guide", async () => {
    const calls: string[] = [];
    const localSession = {
      authenticated: true as const,
      isNewUser: false,
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "hello",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: true,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    };
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async getAccountInfo(input) {
          calls.push(`cloud-info:${input.uuid}`);
          return { ...cloudProfile(), hasFinishedGuide: false };
        },
        async updateAccountGuide(input) {
          calls.push(`cloud-update:${input.uuid}:${input.hasFinishedGuide}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        get() {
          calls.push("local-get");
          return localSession;
        },
        getCloudUuid() {
          calls.push("local-cloud-uuid");
          return "cloud.login.uuid";
        },
        upsert(input) {
          calls.push(`local-upsert:${input.profile.hasFinishedGuide}`);
          return {
            authenticated: true,
            isNewUser: false,
            profile: input.profile
          };
        }
      }
    });

    await expect(service.getSession()).resolves.toMatchObject({
      authenticated: true,
      profile: {
        hasFinishedGuide: false
      }
    });
    expect(calls).toEqual([
      "local-get",
      "local-cloud-uuid",
      "cloud-info:cloud.login.uuid",
      "local-upsert:false"
    ]);
  });

  it("marks cloud guide finished only when the guide is actually entered", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async updateAccountGuide(input) {
          calls.push(`cloud-update:${input.uuid}:${input.hasFinishedGuide}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        getCloudUuid() {
          calls.push("local-cloud-uuid");
          return "cloud.login.uuid";
        }
      }
    });

    await expect(service.markGuideFinished()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["local-cloud-uuid", "cloud-update:cloud.login.uuid:true"]);
  });

  it("notifies cloud logout with stored uuid, then clears local session", async () => {
    const calls: string[] = [];
    const service = createAccountService({
      cloudClient: {
        ...createCloudClientStub(),
        async logout(input) {
          calls.push(`cloud-logout:${input.uuid}`);
        }
      },
      accountSessionRepository: {
        ...createAccountSessionRepositoryStub(),
        getCloudUuid() {
          return "cloud.login.uuid";
        },
        clear() {
          calls.push("clear");
        }
      },
      memmyConfigWriter: {
        async writeAccountModelProjection() {
          calls.push("write-account");
          return projectionResult();
        },
        async clearAccountModelProjection() {
          calls.push("clear-account-config");
          return projectionResult();
        },
        async writeByokModelProjection() {
          calls.push("write-byok");
          return projectionResult();
        },
        async writeActiveMemoryProfile() {
          calls.push("write-active-profile");
          return projectionResult();
        },
        async patchChannelConfig() {
          calls.push("patch-channel");
        }
      }
    });

    await expect(service.logout()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["cloud-logout:cloud.login.uuid", "clear-account-config", "clear"]);
  });
});

function createCloudClientStub() {
  return {
    async health() {
      return { status: "mock" as const, checkedAt: "2026-06-02T10:00:00.000Z" };
    },
    async sendEmailCode() {
      return undefined;
    },
    async sendPhoneCode() {
      return undefined;
    },
    async login() {
      return { uuid: "cloud.login.uuid", accountUuid: "cloud-account-user-1", isNewUser: true, profile: cloudProfile() };
    },
    async logout() {
      return undefined;
    },
    async getAccountInfo() {
      return cloudProfile();
    },
    async updateAccountGuide() {
      return undefined;
    },
    async updateAccountProfile() {
      return undefined;
    },
    async getTokenUsage() {
      return {
        planName: "mock",
        totalTokens: 1,
        usedTokens: 0,
        remainingTokens: 1,
        expiresAt: null,
        lastSyncedAt: null
      };
    },
    async grantImprovementProgramTokens() {
      return this.getTokenUsage({});
    },
    async sendTelemetry() {
      return undefined;
    },
    async checkRelease() {
      return { updateAvailable: false };
    }
  };
}

function createAccountSessionRepositoryStub() {
  return {
    get() {
      return { authenticated: false as const };
    },
    getCloudUuid() {
      return null;
    },
    upsert() {
      return { authenticated: false as const };
    },
    clear() {
      return undefined;
    },
    getLastCodeSentAt() {
      return null;
    },
    markCodeSent() {
      return undefined;
    }
  };
}

function projectionResult() {
  return {
    changed: true,
    activeProfile: "account" as const,
    activeProfileChanged: false,
    activeProfileAffected: true
  };
}

function cloudProfile() {
  return {
    userId: "user-1",
    email: "hello@example.com",
    phoneNumber: null,
    nickname: "hello",
    avatarUrl: null,
    planType: "free",
    hasFinishedGuide: false,
    region: null,
    registeredAt: "2026-06-02T10:00:00.000Z",
    rawProfile: {
      id: "user-1",
      email: "hello@example.com",
      userName: "hello",
      createdAt: "2026-06-02T10:00:00.000Z"
    }
  };
}
