import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "../../adapters/outbound/cloud-client/http-cloud-client.js";
import { createAccountService } from "../account-service.js";
import { withErrorEnvelope } from "../error-envelope.js";
import type { AccountSessionRepository } from "../../infrastructure/app-state-store/repositories/account-session-repo.js";

describe("verification retry HTTP flow", () => {
  it.each(["phone", "email"] as const)("preserves %s timeout and enforces the remaining wait across requests", async channel => {
    let time = Date.parse("2026-10-29T00:00:00Z");
    const sent = new Map<string, string>();
    const markCodeSent = vi.fn((key: string, at: string) => { sent.set(key, at); });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("cloud timeout"), { name: "TimeoutError" }))
      .mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: true })));
    const service = createAccountService({
      now: () => new Date(time),
      cloudClient: createHttpCloudClient({ baseUrl: "https://cloud.test.invalid", fetchImpl }),
      accountSessionRepository: {
        getLastCodeSentAt: (key: string) => sent.get(key) ?? null, markCodeSent
      } as AccountSessionRepository,
      bootstrapRepository: { preserveCompletedOnboardingForLocalByok: () => false }
    });
    const app = Fastify();
    app.post("/send", withErrorEnvelope(async () => service.sendCode(channel === "phone"
      ? { channel, phoneNumber: "13800138000", locale: "zh" }
      : { channel, email: "test@example.com", locale: "en" })));
    try {
      const first = await app.inject({ method: "POST", url: "/send" });
      expect(first.statusCode).toBe(504);
      expect(first.headers["retry-after"]).toBe("60");
      // Browser exposure is owned/tested by the local API's CORS entry layer.
      expect(first.headers["access-control-expose-headers"]).toBeUndefined();
      expect(first.json()).toMatchObject({ error: { code: "internal" } });
      expect(markCodeSent).not.toHaveBeenCalled();
      time += 43_000;
      const retry = await app.inject({ method: "POST", url: "/send" });
      expect(retry.statusCode).toBe(429);
      expect(retry.headers["retry-after"]).toBe("17");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(markCodeSent).not.toHaveBeenCalled();
      time += 17_000;
      const recovered = await app.inject({ method: "POST", url: "/send" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({ ok: true, resendAfterSec: 60 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(markCodeSent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
