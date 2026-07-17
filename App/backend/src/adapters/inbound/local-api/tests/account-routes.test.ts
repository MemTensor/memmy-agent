/** Account routes tests. */
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

describe("account local api routes", () => {
  it("forwards account session routes through AccountService", async () => {
    const calls: string[] = [];
    app = createServer({
      account: {
        async sendCode(input) {
          calls.push(`send:${input.channel}:${input.email ?? input.phoneNumber}`);
          return { ok: true, resendAfterSec: 60 };
        },
        async verifyCode(input) {
          calls.push(`verify:${input.verificationCode}`);
          return accountSession();
        },
        async updateProfile(input) {
          calls.push(`profile:${input.nickname}`);
          return { ...accountSession().profile, nickname: input.nickname };
        },
        async markGuideFinished() {
          calls.push("guide-finished");
          return { ok: true };
        },
        async logout() {
          calls.push("logout");
          return { ok: true };
        },
        async getSession() {
          calls.push("session");
          return accountSession();
        }
      }
    });

    const sendCode = await injectJson("POST", "/api/account/send-code", {
      channel: "email",
      email: "hello@example.com",
      locale: "zh"
    });
    const verifyCode = await injectJson("POST", "/api/account/verify-code", {
      channel: "email",
      email: "hello@example.com",
      verificationCode: "123456",
      loginSource: "Memmy"
    });
    const profile = await injectJson("PATCH", "/api/account/profile", { nickname: "Memmy User" });
    const guideFinished = await injectJson("POST", "/api/account/guide-finished", {});
    const logout = await injectJson("POST", "/api/account/logout", {});
    const session = await app.inject({
      method: "GET",
      url: "/api/account/session",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(sendCode.json()).toEqual({ ok: true, resendAfterSec: 60 });
    expect(verifyCode.json()).toMatchObject({ authenticated: true, profile: { email: "hello@example.com" } });
    expect(JSON.stringify(verifyCode.json())).not.toContain("cloud.login.uuid");
    expect(profile.json()).toMatchObject({ nickname: "Memmy User" });
    expect(guideFinished.json()).toEqual({ ok: true });
    expect(logout.json()).toEqual({ ok: true });
    expect(session.json()).toMatchObject({ authenticated: true });
    expect(calls).toEqual([
      "send:email:hello@example.com",
      "verify:123456",
      "profile:Memmy User",
      "guide-finished",
      "logout",
      "session"
    ]);
  });

  it("lists avatars and stores the selected avatar behind the runtime token", async () => {
    const calls: string[] = [];
    app = createServer({
      appConfig: {
        async listAvatars() {
          calls.push("avatars");
          return [{ id: "memmy-default", displayName: "Memmy", assetKey: "avatar.memmy", kind: "image" }];
        },
        async setAvatar(input) {
          calls.push(`avatar:${input.avatarId}`);
          return { avatarId: input.avatarId };
        }
      }
    });

    const avatars = await app.inject({
      method: "GET",
      url: "/api/account/avatars",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const avatar = await app.inject({
      method: "PATCH",
      url: "/api/account/avatar",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { avatarId: "memmy-default" }
    });

    expect(avatars.statusCode).toBe(200);
    expect(avatars.json()).toEqual([
      { id: "memmy-default", displayName: "Memmy", assetKey: "avatar.memmy", kind: "image" }
    ]);
    expect(avatar.statusCode).toBe(200);
    expect(avatar.json()).toEqual({ avatarId: "memmy-default" });
    expect(calls).toEqual(["avatars", "avatar:memmy-default"]);
  });

  it("rejects avatar routes without a valid runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/account/avatars"
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns invalid_argument for invalid account payloads", async () => {
    app = createServer();

    const response = await injectJson("POST", "/api/account/send-code", {
      channel: "email",
      locale: "zh"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_argument"
      }
    });
  });
});

async function injectJson(method: string, url: string, payload: unknown) {
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
      async listAvatars() {
        return [];
      },
      async setAvatar() {
        return { avatarId: "memmy-default" };
      }
    },
    account: {
      async sendCode() {
        return { ok: true, resendAfterSec: 60 };
      },
      async verifyCode() {
        return accountSession();
      },
      async updateProfile() {
        return accountSession().profile;
      },
      async markGuideFinished() {
        return { ok: true };
      },
      async logout() {
        return { ok: true };
      },
      async getSession() {
        return { authenticated: false };
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

function accountSession() {
  return {
    authenticated: true,
    isNewUser: true,
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
