import { describe, expect, it, vi } from "vitest";
import { createHttpTokenQuotaClient } from "./token-quota-client.js";

describe("token-quota-client", () => {
  it("POST /api/token-quota/request 带 reason", async () => {
    const requestJson = vi.fn(async () => ({ requestId: "r1", status: "pending" }));
    const client = createHttpTokenQuotaClient({} as never, requestJson as never);
    const r = await client.requestQuota("x".repeat(20));
    expect(r.requestId).toBe("r1");
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/token-quota/request", body: { reason: "x".repeat(20) } })
    );
  });
});
