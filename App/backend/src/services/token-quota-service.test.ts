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

  it("同一账号已有待审批申请时返回原 pending 结果,不重复打 cloud", async () => {
    const requestTokenQuota = vi.fn(async () => ({ requestId: "r1", status: "pending" as const }));
    const svc = createTokenQuotaService({
      cloudClient: { requestTokenQuota } as never,
      accountSessionRepository: repo("uuid-1")
    });

    const first = await svc.requestQuota({ reason: "第一次申请".repeat(5) });
    const second = await svc.requestQuota({ reason: "第二次申请".repeat(5) });

    expect(first).toEqual({ requestId: "r1", status: "pending" });
    expect(second).toEqual({ requestId: "r1", status: "pending" });
    expect(requestTokenQuota).toHaveBeenCalledTimes(1);
  });

  it("pending 申请按账号隔离", async () => {
    let currentUuid = "uuid-1";
    const requestTokenQuota = vi.fn(async ({ uuid }: { uuid: string }) => ({ requestId: `${uuid}-request`, status: "pending" as const }));
    const svc = createTokenQuotaService({
      cloudClient: { requestTokenQuota } as never,
      accountSessionRepository: { getCloudUuid: () => currentUuid } as never
    });

    const first = await svc.requestQuota({ reason: "第一次申请".repeat(5) });
    currentUuid = "uuid-2";
    const second = await svc.requestQuota({ reason: "第二次申请".repeat(5) });

    expect(first.requestId).toBe("uuid-1-request");
    expect(second.requestId).toBe("uuid-2-request");
    expect(requestTokenQuota).toHaveBeenCalledTimes(2);
  });

  it("pending 缓存过期后允许重新提交到 cloud", async () => {
    const requestTokenQuota = vi.fn()
      .mockResolvedValueOnce({ requestId: "r1", status: "pending" as const })
      .mockResolvedValueOnce({ requestId: "r2", status: "pending" as const });
    const svc = createTokenQuotaService({
      cloudClient: { requestTokenQuota } as never,
      accountSessionRepository: repo("uuid-1"),
      pendingRequestTtlMs: 0
    });

    await expect(svc.requestQuota({ reason: "第一次申请".repeat(5) })).resolves.toMatchObject({ requestId: "r1" });
    await expect(svc.requestQuota({ reason: "第二次申请".repeat(5) })).resolves.toMatchObject({ requestId: "r2" });
    expect(requestTokenQuota).toHaveBeenCalledTimes(2);
  });
});
