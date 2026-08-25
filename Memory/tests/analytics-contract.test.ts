import { describe, expect, it, vi } from "vitest";
import { postAnalyticsEvents } from "../src/cli/analytics.js";

describe("CLI analytics event contract", () => {
  it("posts the installation id alongside the existing GA-style event contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await postAnalyticsEvents({
      events: [{
        eventName: "memmy_cli_completed",
        eventTimeMillis: 1_700_000_000_000,
        params: { success: true },
      }],
      installationId: "install-1",
      clientId: "ga-client-1",
      userId: null,
      userMode: "byok",
      appEnv: "prod",
      baseUrl: "https://cloud.example.com",
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      clientId: "ga-client-1",
      installationId: "install-1",
    });
    expect(body.userId).toBeUndefined();
    expect(body.events).toEqual([
      expect.objectContaining({
        eventName: "memmy_cli_completed",
        params: expect.objectContaining({
          engagement_time_msec: 100,
          success: true,
          user_mode: "byok",
          source: "memmy-memory",
          app_env: "prod",
          app_version: expect.any(String),
          timestamp_micros: 1_700_000_000_000_000,
        }),
      }),
    ]);
    expect(body.events[0]?.params).not.toHaveProperty("user_id");
  });
});
