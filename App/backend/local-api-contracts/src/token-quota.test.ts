import { describe, expect, it } from "vitest";
import {
  RequestTokenQuotaInputSchema,
  TokenQuotaApplyResultSchema,
  TokenQuotaEligibilitySchema
} from "./index.js";

describe("RequestTokenQuotaInputSchema", () => {
  it("接受 ≥20 字 reason", () => {
    expect(RequestTokenQuotaInputSchema.parse({ reason: "一".repeat(20) }).reason.length).toBe(20);
  });
  it("拒绝 <20 字 reason", () => {
    expect(() => RequestTokenQuotaInputSchema.parse({ reason: "太短" })).toThrow();
  });
});

describe("TokenQuotaApplyResultSchema", () => {
  it("校验 requestId + status", () => {
    const v = TokenQuotaApplyResultSchema.parse({ requestId: "r1", status: "pending" });
    expect(v.status).toBe("pending");
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

    expect(value.state).toBe("pending");
    expect(value.requestCount).toBe(2);
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
