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
