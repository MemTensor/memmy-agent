import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "./http-cloud-client.js";

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
