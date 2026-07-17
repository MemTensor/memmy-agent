import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAccountClient, resolveAccountIdentifier, validateAccountCodeInput } from "../account-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account-client", () => {
  it("把邮箱或手机号解析为账号验证码输入标识", () => {
    expect(resolveAccountIdentifier(" grace@example.com ")).toEqual({
      channel: "email",
      email: "grace@example.com"
    });
    expect(resolveAccountIdentifier(" 13800138000 ")).toEqual({
      channel: "phone",
      phoneNumber: "13800138000"
    });
    expect(resolveAccountIdentifier(" ")).toBeNull();
  });

  it("登录表单提交前返回可展示的账号与验证码校验结果", () => {
    expect(validateAccountCodeInput({ identifier: "1", code: "1", requireCode: true })).toEqual({
      ok: false,
      reason: "identifier"
    });
    expect(validateAccountCodeInput({ identifier: "13800138000", code: "", requireCode: true })).toEqual({
      ok: false,
      reason: "code"
    });
    expect(validateAccountCodeInput({ identifier: " grace@example.com ", code: "123456", requireCode: true })).toEqual({
      ok: true,
      identifier: {
        channel: "email",
        email: "grace@example.com"
      }
    });
  });

  it("读取本地账号会话真实路由", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("http://127.0.0.1:18100/api/account/session");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      return new Response(
        JSON.stringify({
          authenticated: true,
          isNewUser: false,
          profile: {
            userId: "user-1",
            email: "grace@example.com",
            phoneNumber: null,
            nickname: "Grace",
            avatarUrl: null,
            planType: "trial",
            hasFinishedGuide: true,
            region: "cn",
            registeredAt: "2026-06-02T10:00:00.000Z"
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createHttpAccountClient(config).getSession()).resolves.toMatchObject({
      authenticated: true,
      profile: {
        email: "grace@example.com",
        nickname: "Grace",
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("通过真实本地 API 完成验证码发送、校验和昵称更新", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      if (url.endsWith("/api/account/send-code")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({
          channel: "email",
          email: "grace@example.com",
          locale: "zh"
        });
        return jsonResponse({ ok: true, resendAfterSec: 60 });
      }

      if (url.endsWith("/api/account/verify-code")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({
          channel: "email",
          email: "grace@example.com",
          verificationCode: "123456",
          loginSource: "Memmy"
        });
        return jsonResponse({
          authenticated: true,
          isNewUser: true,
          profile: profilePayload({ nickname: "Grace" })
        });
      }

      if (url.endsWith("/api/account/profile")) {
        expect(init?.method).toBe("PATCH");
        expect(body).toEqual({ nickname: "Memmy User" });
        return jsonResponse(profilePayload({ nickname: "Memmy User" }));
      }

      if (url.endsWith("/api/account/guide-finished")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({});
        return jsonResponse({ ok: true });
      }

      if (url.endsWith("/api/account/logout")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({});
        return jsonResponse({ ok: true });
      }

      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpAccountClient(config);

    await expect(client.sendCode({ channel: "email", email: "grace@example.com", locale: "zh" })).resolves.toEqual({
      ok: true,
      resendAfterSec: 60
    });
    await expect(
      client.verifyCode({
        channel: "email",
        email: "grace@example.com",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).resolves.toMatchObject({
      authenticated: true,
      isNewUser: true,
      profile: { email: "grace@example.com", nickname: "Grace" }
    });
    await expect(client.updateProfile({ nickname: "Memmy User" })).resolves.toMatchObject({
      email: "grace@example.com",
      nickname: "Memmy User",
      registeredAt: "2026-06-02T10:00:00.000Z"
    });
    await expect(client.markGuideFinished()).resolves.toEqual({ ok: true });
    await expect(client.logout()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

/**
 * Builds a JSON response.
 *
 * @param payload The response body object.
 * @returns A Response that fetch can consume.
 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Builds an account profile response.
 *
 * @param input Overridable account fields.
 * @returns An account profile that conforms to the local API contract.
 */
function profilePayload(input: { nickname: string }) {
  return {
    userId: "user-1",
    email: "grace@example.com",
    phoneNumber: null,
    nickname: input.nickname,
    avatarUrl: null,
    planType: "trial",
    hasFinishedGuide: false,
    region: "cn",
    registeredAt: "2026-06-02T10:00:00.000Z"
  };
}
