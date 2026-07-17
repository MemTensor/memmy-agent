import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "./http-cloud-client.js";

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
