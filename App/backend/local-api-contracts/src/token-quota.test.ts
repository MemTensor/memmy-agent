import { describe, expect, it } from "vitest";
import {
  RequestTokenQuotaInputSchema,
  TokenQuotaApplyResultSchema,
  TokenQuotaEligibilitySchema
} from "./index.js";

describe("RequestTokenQuotaInputSchema", () => {
  it("接受 ≥20 字 reason", () => {
    expect(RequestTokenQuotaInputSchema.parse({ reason: "一".repeat(20) })).toEqual({ reason: "一".repeat(20) });
  });
  it("拒绝 <20 字 reason", () => {
    expect(() => RequestTokenQuotaInputSchema.parse({ reason: "太短" })).toThrow();
  });
});

describe("TokenQuotaApplyResultSchema", () => {
  it("校验 requestId + status", () => {
    const v = TokenQuotaApplyResultSchema.parse({ requestId: "r1", status: "pending" });
    expect(v).toEqual({ requestId: "r1", status: "pending" });
  });
});

describe("TokenQuotaEligibilitySchema", () => {
  it("接受审批中的完整资格状态", () => {
    const value = TokenQuotaEligibilitySchema.parse({
      state: "pending",
      requestCount: 2,
      maxRequestCount: 5,
      nextAllowedAtEpochMs: null,
      latestRequestStatus: "pending",
      latestReviewNote: null
    });

    expect(value).toMatchObject({ state: "pending", requestCount: 2 });
  });

  it("拒绝超过 5 次的非法响应", () => {
    expect(() => TokenQuotaEligibilitySchema.parse({
      state: "limit_reached",
      requestCount: 6,
      maxRequestCount: 5,
      nextAllowedAtEpochMs: null,
      latestRequestStatus: "rejected",
      latestReviewNote: "申请场景说明不够具体"
    })).toThrow();
  });
});

const upgrade = {
  accepted: true, deprecated: true, formType: "CN_ZH",
  formUrl: "https://alidocs.dingtalk.com/notable/share/form/official",
  latestApplicationApi: "/api/credits/v1/plan-applications/latest"
} as const;

it("accepts plan upgrade redirects without inventing a submitted review", () => {
  expect(RequestTokenQuotaInputSchema.parse({ requestId: "upgrade:1", region: "CN", language: "zh-CN" })).toMatchObject({ requestId: "upgrade:1" });
  expect(TokenQuotaApplyResultSchema.parse(upgrade)).toEqual(upgrade);
  expect(TokenQuotaApplyResultSchema.safeParse({ requestId: "old-without-status" }).success).toBe(false);
  expect(TokenQuotaApplyResultSchema.safeParse({ ...upgrade, formUrl: "javascript:alert(1)" }).success).toBe(false);
});

it("accepts credits eligibility independently of legacy review counters", () => {
  const eligibility = {
    eligible: false, deprecated: true, plansApi: "/api/credits/v1/plans",
    latestApplicationApi: upgrade.latestApplicationApi, compatibilityEndAt: "2027-01-31T23:59:59+08:00"
  };
  expect(TokenQuotaEligibilitySchema.parse(eligibility)).toEqual(eligibility);
});
