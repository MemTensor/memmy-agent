import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CONNECTION_ANALYTICS_EVENTS,
  buildToolConnectionParams,
  createToolConnectionAnalytics,
} from "../tool-connection-analytics.js";

describe("tool-connection-analytics", () => {
  it("builds connected params with surface, toolkit, event, and occurred_at_ms", () => {
    expect(
      buildToolConnectionParams({
        surface: "channel",
        toolkit: "wechat",
        event: "connected",
        occurredAtMs: 1_700_000_000_000,
      }),
    ).toEqual({
      surface: "channel",
      toolkit: "wechat",
      event: "connected",
      occurred_at_ms: 1_700_000_000_000,
    });
  });

  it("omits blank toolkit and attaches error_code for failed events", () => {
    expect(
      buildToolConnectionParams({
        surface: "integration",
        toolkit: "  github  ",
        event: "failed",
        errorCode: "timeout",
        occurredAtMs: 42,
      }),
    ).toEqual({
      surface: "integration",
      toolkit: "github",
      event: "failed",
      occurred_at_ms: 42,
      error_code: "timeout",
    });

    expect(
      buildToolConnectionParams({
        surface: "integration",
        toolkit: "gmail",
        event: "failed",
        error: new Error("Connection timed out"),
        occurredAtMs: 7,
      }).error_code,
    ).toBe("Connection timed out");
  });

  it("tracks tool_connection events through the cloud transport", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const analytics = createToolConnectionAnalytics({
      getClientId: () => "client-1",
      getUserId: () => "user-1",
      getUserMode: () => "account",
      appEnv: "dev",
      appEdition: "cn",
      debugMode: false,
      baseUrl: "https://example.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    analytics.trackConnection({
      surface: "channel",
      toolkit: "wechat",
      event: "connected",
      occurredAtMs: 100,
    });
    analytics.trackConnection({
      surface: "integration",
      toolkit: "github",
      event: "disconnected",
      occurredAtMs: 200,
    });
    analytics.trackConnection({
      surface: "integration",
      toolkit: "",
      event: "failed",
    });
    await analytics.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.clientId).toBe("client-1");
    expect(body.userId).toBe("user-1");
    expect(body.events).toHaveLength(2);
    expect(body.events.map((event: { eventName: string }) => event.eventName)).toEqual([
      TOOL_CONNECTION_ANALYTICS_EVENTS.connection,
      TOOL_CONNECTION_ANALYTICS_EVENTS.connection,
    ]);
    expect(body.events[0]?.params).toMatchObject({
      source: "memmy-backend",
      surface: "channel",
      toolkit: "wechat",
      event: "connected",
      occurred_at_ms: 100,
    });
    expect(body.events[1]?.params).toMatchObject({
      surface: "integration",
      toolkit: "github",
      event: "disconnected",
    });
  });
});
