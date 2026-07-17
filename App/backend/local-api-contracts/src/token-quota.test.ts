import { describe, expect, it } from "vitest";
import { RequestTokenQuotaInputSchema, TokenQuotaApplyResultSchema } from "./index.js";

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
