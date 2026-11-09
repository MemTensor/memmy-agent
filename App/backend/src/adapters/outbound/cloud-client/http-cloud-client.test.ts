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

describe("credits cloud APIs", () => {
  it("uses authenticated GET and preserves cursor encoding", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: { items: [], nextCursor: null, hasMore: false } })));
    const client = createHttpCloudClient({ baseUrl: "http://127.0.0.1:18101", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getCredits({ uuid: "cloud-token", resource: "grants", query: { cursor: "a+b/=", limit: 20 } })).resolves.toMatchObject({ items: [] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:18101/api/credits/v1/grants?cursor=a%2Bb%2F%3D&limit=20");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ authorization: "Bearer cloud-token" });
  });
  it("maps expired cloud sessions to unauthorized", async () => {
    const client = createHttpCloudClient({ baseUrl: "http://127.0.0.1:18101", fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: "AUTH_REQUIRED", message: "Please log in" }), { status: 401 })) as typeof fetch });
    await expect(client.getCredits({ uuid: "expired", resource: "summary" })).rejects.toMatchObject({ code: "unauthorized" });
  });
});

it("downloads signed CSV only from the authenticated cloud route", async () => {
  const fetchImpl = vi.fn(async () => new Response("RequestID,积分消耗\r\nlocal-test,1.01", { headers: { "content-type": "text/csv;charset=UTF-8" } }));
  const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch });
  expect(await client.getCredits({ uuid: "test-credential", resource: "usage/download", query: { token: "signed+token" } })).toEqual({ csv: "RequestID,积分消耗\r\nlocal-test,1.01" });
  expect(fetchImpl).toHaveBeenCalledWith("https://cloud.test/api/credits/v1/usage/download?token=signed%2Btoken", expect.objectContaining({ headers: { authorization: "Bearer test-credential" }, redirect: "error" }));
});
it.each([5_000, 300_000])("allows bounded CSV preflight/streaming without changing ordinary request timeouts (%i ms)", async timeoutMs => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes("usage/download")
      ? new Response("RequestID,积分消耗\r\nlocal-test,1.01", { headers: { "content-type": "text/csv;charset=UTF-8" } })
      : new Response(JSON.stringify({ code: 0, data: {} })));
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", timeoutMs, fetchImpl: fetchImpl as typeof fetch });
    await client.getCredits({ uuid: "test-credential", resource: "usage/download", query: { token: "signed" } });
    expect(timeout).toHaveBeenLastCalledWith(Math.max(timeoutMs, 120_000));
    await client.getCredits({ uuid: "test-credential", resource: "summary" });
    expect(timeout).toHaveBeenLastCalledWith(timeoutMs);
  } finally { timeout.mockRestore(); }
});
it("posts reward idempotency keys and exposes the business rejection reason", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "VOUCHER_EXPIRED", message: "兑换码已过期", retryable: false }), { status: 422 }));
  const client = createHttpCloudClient({ baseUrl: "https://example.invalid", fetchImpl: fetchImpl as typeof fetch });
  await expect(client.postCredits({ uuid: "test-account", resource: "redemptions", body: { requestId: "retry-1", code: "TEST-123" } })).rejects.toMatchObject({ code: "VOUCHER_EXPIRED", message: "兑换码已过期" });
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://example.invalid/api/credits/v1/redemptions");
  const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(init.method).toBe("POST"); expect(JSON.parse(init.body as string)).toEqual({ requestId: "retry-1", code: "TEST-123" });
  expect(init.headers).toMatchObject({ authorization: "Bearer test-account" });
});

describe("ASR credit admission errors", () => {
  it.each([["CREDIT_BALANCE_RESERVED",409],["CREDIT_INSUFFICIENT",422]] as const)("preserves %s for the local API", async (code,status) => {
    const fetchImpl=vi.fn(async () => Response.json({code,message:"admission denied"},{status}));
    const client=createHttpCloudClient({baseUrl:"https://cloud.test",fetchImpl:fetchImpl as typeof fetch});
    await expect(client.transcribeAudio({uuid:"uuid-1",audioBase64:"AA==",mimeType:"audio/wav"})).rejects.toMatchObject({code});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});


describe("legacy quota upgrade compatibility", () => {
  it("preserves questionnaire redirects and forwards idempotency and locale fields", async () => {
    const redirect = { accepted: true, deprecated: true, formType: "INTL_EN",
      formUrl: "https://alidocs.dingtalk.com/notable/share/form/official",
      latestApplicationApi: "/api/credits/v1/plan-applications/latest" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: redirect })));
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch });
    const body = { requestId: "upgrade:1", region: "INTL" as const, language: "en-US" as const };
    await expect(client.requestTokenQuota({ uuid: "uuid-1", ...body })).resolves.toEqual(redirect);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual(body);
  });

  it("does not turn malformed approval responses into pending", async () => {
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: (async () =>
      new Response(JSON.stringify({ data: { requestId: "missing-status" } }))) as typeof fetch });
    await expect(client.requestTokenQuota({ uuid: "uuid-1", reason: "x".repeat(20) })).rejects.toThrow();
  });

  it("reads new credits eligibility without requiring obsolete quota counters", async () => {
    const eligibility = { eligible: true, deprecated: true, plansApi: "/api/credits/v1/plans",
      latestApplicationApi: "/api/credits/v1/plan-applications/latest", compatibilityEndAt: null };
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: (async () =>
      new Response(JSON.stringify({ data: eligibility }))) as typeof fetch });
    await expect(client.getTokenQuotaEligibility({ uuid: "uuid-1" })).resolves.toEqual(eligibility);
  });
});

it("exposes the cloud credit account version without requiring retired token fields", async () => {
  const creditState = { currentPlan: "PRO", creditAccountInitialized: true, creditAccountVersion: 20 };
  const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: (async () =>
    new Response(JSON.stringify({ data: { id: "7", userName: "Member", planType: "pro", ...creditState } }))) as typeof fetch });
  await expect(client.getAccountInfo({ uuid: "uuid-1" })).resolves.toMatchObject(creditState);
  await expect(client.getTokenUsage({ uuid: "uuid-1" })).resolves.toMatchObject({ totalTokens: 0, remainingTokens: 0 });
});

it("reports unconfigured improvement rewards without fetching account info or reporting success", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "REWARD_NOT_CONFIGURED", message: "configure first" }), { status: 503 }));
  const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch });
  await expect(client.grantImprovementProgramTokens({ uuid: "uuid-1" })).rejects.toMatchObject({ code: "REWARD_NOT_CONFIGURED" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
