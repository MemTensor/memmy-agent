import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { createHttpCreditsClient } from "../credits-client.js";
const config = { baseUrl: "http://127.0.0.1:19001", localToken: "local-test-token", timeZone: "Asia/Shanghai" } as RuntimeConfig;
afterEach(() => vi.unstubAllGlobals());
it("only downloads the signed relative export route and passes cancellation/local authentication", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ csv: "local-test-csv" })));
  vi.stubGlobal("fetch", fetcher);
  const client = createHttpCreditsClient(config); const controller = new AbortController();
  await expect(client.usageDownload("/api/credits/v1/usage/download?token=a%2Bb", controller.signal)).resolves.toEqual({ csv: "local-test-csv" });
  expect(fetcher).toHaveBeenCalledWith(new URL("http://127.0.0.1:19001/api/credits/usage/download?token=a%2Bb"), expect.objectContaining({ signal: controller.signal, headers: expect.objectContaining({ "x-memmy-local-token": "local-test-token" }) }));
  for (const url of ["https://other.test/api/credits/v1/usage/download?token=x", "/api/agentUser/info", "//other.test/download"]) expect(() => client.usageDownload(url)).toThrow("Invalid export URL");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("validates confirmed usage payloads and does not accept pending bills", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [{ callId: "test", status: "RUNNING" }], nextCursor: null, hasMore: false })));
  vi.stubGlobal("fetch", fetcher);
  await expect(createHttpCreditsClient(config).usage({ domain: "memory", cursor: "a+b" })).rejects.toThrow();
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("domain=memory&cursor=a%2Bb");
});
it("preserves detailed pricing and checkpoints while accepting older cloud responses", async () => {
  const detail = { callId: "call-test", requestId: "request-test", domain: "agent", operation: "CHAT", model: "test-model",
    inputTokens: 10, outputTokens: 20, cachedTokens: 0, chargedCredits: "1.25", chargeCredits: "1.25", absorbedCredits: "0.00",
    status: "SETTLED", settlementStatus: "SETTLED", businessDate: "2026-11-09", callCount: 1,
    startedAt: "2026-11-09T00:00:00Z", settledAt: "2026-11-09T00:01:00Z", requestContent: "fixture input", requestContentStatus: "AVAILABLE",
    pricingVersion: "pricing-v1", audioSeconds: null, remainingCredits: "100.00" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(detail)).mockResolvedValueOnce(Response.json({ ...detail,
    inputCredits: "0.25", outputCredits: "1.00", settlementVersion: 2, checkpoints: [{ sequence: 1, usageTokens: 30, chargedCredits: "1.25" }] }));
  vi.stubGlobal("fetch", fetcher);
  const client = createHttpCreditsClient(config);
  await expect(client.usageDetail("call-test")).resolves.toMatchObject({ inputCredits: null, outputCredits: null, settlementVersion: null, checkpoints: [] });
  await expect(client.usageDetail("call-test")).resolves.toMatchObject({ pricingVersion: "pricing-v1", inputCredits: "0.25", outputCredits: "1.00", settlementVersion: 2,
    checkpoints: [{ sequence: 1, usageTokens: 30, chargedCredits: "1.25" }] });
});
