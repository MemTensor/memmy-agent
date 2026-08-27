import { describe, expect, it, vi } from "vitest";
import { createTokenQuotaService } from "./token-quota-service.js";

function repo(uuid: string | undefined) {
  return { getCloudUuid: () => uuid } as never;
}

describe("token-quota-service", () => {
  it("未登录（无 cloudUuid）抛 unauthorized", async () => {
    const svc = createTokenQuotaService({
      cloudClient: {} as never,
      accountSessionRepository: repo(undefined)
    });
    await expect(svc.requestQuota({ reason: "x".repeat(20) })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("已登录则带 uuid 转发 cloudClient", async () => {
    const requestTokenQuota = vi.fn(async () => ({ requestId: "r1", status: "pending" as const }));
    const svc = createTokenQuotaService({
      cloudClient: { requestTokenQuota } as never,
      accountSessionRepository: repo("uuid-1")
    });
    const r = await svc.requestQuota({ reason: "x".repeat(20) });
    expect(r.requestId).toBe("r1");
    expect(requestTokenQuota).toHaveBeenCalledWith({ uuid: "uuid-1", reason: "x".repeat(20) });
  });

  it("每次提交都交给云端做并发与资格校验", async () => {
    const requestTokenQuota = vi.fn(async () => ({ requestId: "r1", status: "pending" as const }));
    const svc = createTokenQuotaService({
      cloudClient: { requestTokenQuota } as never,
      accountSessionRepository: repo("uuid-1")
    });

    const first = await svc.requestQuota({ reason: "第一次申请".repeat(5) });
    const second = await svc.requestQuota({ reason: "第二次申请".repeat(5) });

    expect(first).toEqual({ requestId: "r1", status: "pending" });
    expect(second).toEqual({ requestId: "r1", status: "pending" });
    expect(requestTokenQuota).toHaveBeenCalledTimes(2);
  });

  it("查询资格时带当前账号 uuid 转发 cloudClient", async () => {
    const eligibility = {
      state: "available" as const,
      requestCount: 0,
      maxRequestCount: 5 as const,
      nextAllowedAtEpochMs: null,
      latestRequestStatus: null,
      latestReviewNote: null
    };
    const getTokenQuotaEligibility = vi.fn(async () => eligibility);
    const svc = createTokenQuotaService({
      cloudClient: { getTokenQuotaEligibility } as never,
      accountSessionRepository: repo("uuid-1")
    });

    await expect(svc.getEligibility()).resolves.toEqual(eligibility);
    expect(getTokenQuotaEligibility).toHaveBeenCalledWith({ uuid: "uuid-1" });
  });

  it("未登录查询资格时抛 unauthorized", async () => {
    const svc = createTokenQuotaService({
      cloudClient: {} as never,
      accountSessionRepository: repo(undefined)
    });

    await expect(svc.getEligibility()).rejects.toMatchObject({ code: "unauthorized" });
  });
});
