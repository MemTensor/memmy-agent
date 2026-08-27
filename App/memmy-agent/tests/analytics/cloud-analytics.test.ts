import { describe, expect, it, vi } from "vitest";
import {
  postAnalyticsEvents,
  resolveAnalyticsUserModeFromConfig,
} from "../../src/analytics/cloud-analytics.js";

describe("cloud analytics event contract", () => {
  it("derives account_byok when account identity and BYOK assignments coexist", () => {
    expect(resolveAnalyticsUserModeFromConfig({
      app: { cloudUuid: "cloud-1", userId: "user-1" },
      modelAssignments: {
        account: { ownerAccountId: "user-1" },
        byok: { embedding: "openai:model-1" },
      },
    })).toBe("account_byok");
  });

  it("posts the installation id alongside the existing GA-style event contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await postAnalyticsEvents({
      events: [{
        eventName: "memory_turn_completed",
        eventTimeMillis: 1_700_000_000_000,
        params: { duration_ms: 42 },
      }],
      installationId: "install-1",
      clientId: "ga-client-1",
      userId: "user-1",
      userMode: "account_byok",
      appEnv: "prod",
      appEdition: "cn",
      baseUrl: "https://cloud.example.com",
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      clientId: "ga-client-1",
      userId: "user-1",
      installationId: "install-1",
    });
    expect(body.events).toEqual([
      expect.objectContaining({
        eventName: "memory_turn_completed",
        params: expect.objectContaining({
          engagement_time_msec: 100,
          duration_ms: 42,
          user_id: "user-1",
          user_mode: "account_byok",
          source: "memmy-agent",
          app_env: "prod",
          app_edition: "cn",
          app_version: expect.any(String),
          timestamp_micros: 1_700_000_000_000_000,
        }),
      }),
    ]);
    expect(body.events[0]).not.toHaveProperty("event_id");
  });
});
