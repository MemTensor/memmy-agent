import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "./http-cloud-client.js";

describe("verification request resilience", () => {
  it("gives code delivery and login 20 seconds without changing ordinary cloud requests", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({
      code: 0,
      data: String(url).endsWith("/login")
        ? { id: "test-user", uuid: "test-credential", phoneNumber: "13800138000" }
        : true
    })));
    try {
      const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl });
      await client.sendPhoneCode({ phoneNumber: "13800138000", zhEnv: true });
      await client.sendEmailCode({ email: "test@example.com", zhEnv: false });
      await client.login({ phoneNumber: "13800138000", verificationCode: "123456", loginSource: "Memmy" });
      await client.logout({ uuid: "test-credential" });

      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([20_000, 20_000, 20_000, 5_000]);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps a longer configured authentication timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const client = createHttpCloudClient({
        baseUrl: "https://cloud.test", timeoutMs: 30_000,
        fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: true }))
      });
      await client.sendPhoneCode({ phoneNumber: "13800138000", zhEnv: true });
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([429, 200])("preserves phone verification throttling for HTTP %s", async (status) => {
    const client = createHttpCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl: async () => new Response(JSON.stringify({ code: 40301, message: "请求过于频繁，请稍后重试", data: null }), { status })
    });
    await expect(client.sendPhoneCode({ phoneNumber: "13800138000", zhEnv: true })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("does not automatically resend after the connection is lost", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl });
    await expect(client.sendPhoneCode({ phoneNumber: "13800138000", zhEnv: true })).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("invitation cloud APIs", () => {
  it("login 透传邀请码并解析一次性邀请结果", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: "invitee@example.com",
        verificationCode: "123456",
        loginSource: "memmy",
        invitationCode: "MEMMY-A1B2C3"
      });
      return new Response(
        JSON.stringify({
          data: {
            id: 202,
            email: "invitee@example.com",
            userName: "invitee",
            uuid: "uuid-202",
            userType: "NEW_USER",
            invitationResult: {
              status: "success",
              inviteeRewardTokens: 500_000
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createHttpCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deviceId: "device-1"
    });

    await expect(
      client.login({
        email: "invitee@example.com",
        verificationCode: "123456",
        loginSource: "Memmy",
        invitationCode: "MEMMY-A1B2C3"
      })
    ).resolves.toMatchObject({
      isNewUser: true,
      invitationResult: {
        status: "success",
        inviteeRewardTokens: 500_000
      }
    });
  });

  it("PUT 本人邀请码接口使用 cloud uuid", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            enabled: true,
            invitationCode: "MEMMY-A1B2C3",
            usedInviteSlotsToday: 3,
            dailySuccessLimit: 5,
            remainingInvitesToday: 2,
            dailyLimitReached: false
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createHttpCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.ensureInvitationCode({ uuid: "uuid-1" })).resolves.toMatchObject({
      invitationCode: "MEMMY-A1B2C3",
      remainingInvitesToday: 2
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.test/api/agentUser/invitation/me/code");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer uuid-1"
    });
  });
});

describe("requestTokenQuota", () => {
  it("POST /api/agentUser/quota/apply 带 Bearer uuid 与 reason", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { requestId: "r1", status: "pending" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createHttpCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const result = await client.requestTokenQuota({ uuid: "uuid-1", reason: "x".repeat(20) });
    expect(result.status).toBe("pending");
    expect(result.requestId).toBe("r1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.test/api/agentUser/quota/apply");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer uuid-1" });
  });
});

describe("getTokenQuotaEligibility", () => {
  it("GET /api/agentUser/quota/apply/eligibility 带 Bearer uuid", async () => {
    const eligibility = {
      state: "cooldown",
      requestCount: 1,
      maxRequestCount: 5,
      nextAllowedAtEpochMs: 1_785_312_000_000,
      latestRequestStatus: "rejected",
      latestReviewNote: "额度用途不明确"
    } as const;
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: eligibility }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createHttpCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.getTokenQuotaEligibility({ uuid: "uuid-1" })).resolves.toEqual(eligibility);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.test/api/agentUser/quota/apply/eligibility");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer uuid-1" });
  });
});
