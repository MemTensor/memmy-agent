import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAnalyticsContextForTests,
  setAnalyticsModelSource,
  setAnalyticsUserId,
  setAnalyticsUserMode
} from "../analytics-context.js";
import {
  flushDesktopCloudAnalytics,
  getDesktopAnalyticsClientId,
  resetDesktopCloudAnalyticsForTests,
  resolveDesktopAnalyticsBaseUrl,
  setDesktopAnalyticsContext,
  setDesktopAnalyticsClientId,
  trackCloudAnalyticsEvent
} from "../cloud-analytics.js";

describe("cloud-analytics", () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://cloud.example.com/");
    vi.stubEnv("MEMMY_APP_EDITION", "cn");
    resetAnalyticsContextForTests();
    resetDesktopCloudAnalyticsForTests({ fetchImpl: fetchMock });
    setDesktopAnalyticsContext({
      installationId: "install-1",
      appVersion: "1.0.5",
      platform: "macos"
    });
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAnalyticsContextForTests();
    resetDesktopCloudAnalyticsForTests();
  });

  it("strips trailing slashes from MEMMY_CLOUD_SERVICE", () => {
    expect(resolveDesktopAnalyticsBaseUrl("https://cloud.example.com///")).toBe(
      "https://cloud.example.com"
    );
    expect(resolveDesktopAnalyticsBaseUrl("")).toBeNull();
  });

  it("queues events until session client_id is set, then posts once", async () => {
    setAnalyticsUserMode("account");
    setAnalyticsUserId("user-1");
    trackCloudAnalyticsEvent("welcome_viewed", { step: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDesktopAnalyticsClientId()).toBeNull();

    setDesktopAnalyticsClientId("cid-from-gtag");
    await flushDesktopCloudAnalytics();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.com/api/analytics/events");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      clientId?: string;
      userId?: string;
      installationId: string;
      events: Array<{ eventName: string; params: Record<string, unknown> }>;
    };
    expect(body).toMatchObject({
      clientId: "cid-from-gtag",
      userId: "user-1",
      installationId: "install-1"
    });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventName).toBe("welcome_viewed");
    expect(body.events[0]?.params).toMatchObject({
      engagement_time_msec: 100,
      step: 1,
      user_mode: "account",
      source: "memmy-desktop",
      user_id: "user-1",
      app_env: "dev",
      app_edition: "cn",
      app_version: "1.0.5",
      debug_mode: 1,
      timestamp_micros: expect.any(Number)
    });
  });

  it("always supplies the required byok mode for a signed-out event", async () => {
    setDesktopAnalyticsClientId("cid-1");
    trackCloudAnalyticsEvent("welcome_viewed");
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: { user_mode?: string; user_id?: string } }>;
    };
    expect(body.userId).toBeUndefined();
    expect(body.events[0]?.params).toMatchObject({ user_mode: "byok" });
    expect(body.events[0]?.params.user_id).toBeUndefined();
  });

  it("waits for both the GA client id and installation id before sending", async () => {
    trackCloudAnalyticsEvent("page_view", { page_path: "/welcome" });
    await flushDesktopCloudAnalytics();
    expect(fetchMock).not.toHaveBeenCalled();

    setDesktopAnalyticsClientId("  fresh-id  ");
    await flushDesktopCloudAnalytics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      clientId?: string;
    };
    expect(body.clientId).toBe("fresh-id");
  });

  it("drops queued events when cloud base URL is unset", async () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "");
    trackCloudAnalyticsEvent("page_view", { page_path: "/main" });
    setDesktopAnalyticsClientId("cid-1");
    await flushDesktopCloudAnalytics();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the original account id on the event row", async () => {
    setAnalyticsUserId("cloud-uuid-1");
    trackCloudAnalyticsEvent("memory_desktop_search_succeeded", { page_path: "/memory" });
    setDesktopAnalyticsClientId("cid-1");
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: Record<string, unknown> }>;
    };
    expect(body.userId).toBe("cloud-uuid-1");
    expect(body.events[0]?.params.user_id).toBe("cloud-uuid-1");
  });

  it("reports account_byok when a signed-in user is using BYOK", async () => {
    setAnalyticsUserId("user-1");
    setAnalyticsUserMode("account");
    setAnalyticsModelSource("byok");
    setDesktopAnalyticsClientId("cid-1");
    trackCloudAnalyticsEvent("provider_selected", { provider: "openai" });
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: { user_mode: string; user_id?: string } }>;
    };
    expect(body.userId).toBe("user-1");
    expect(body.events[0]?.params).toMatchObject({
      user_mode: "account_byok",
      user_id: "user-1",
    });
  });

  it("reports account again after a signed-in user switches back to a platform model", async () => {
    setAnalyticsUserId("user-1");
    setAnalyticsUserMode("account");
    setAnalyticsModelSource("byok");
    setAnalyticsModelSource("platform");
    setDesktopAnalyticsClientId("cid-1");
    trackCloudAnalyticsEvent("agent_send_message", { page_path: "/main" });
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      events: Array<{ params: { user_mode: string } }>;
    };
    expect(body.events[0]?.params.user_mode).toBe("account");
  });

  it("reports byok after logout even when the selected model source is byok", async () => {
    setAnalyticsUserId("user-1");
    setAnalyticsUserMode("account");
    setAnalyticsModelSource("byok");
    setAnalyticsUserId(null);
    setDesktopAnalyticsClientId("cid-1");
    trackCloudAnalyticsEvent("page_view", { page_path: "/welcome" });
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: { user_mode: string; user_id?: string } }>;
    };
    expect(body.userId).toBeUndefined();
    expect(body.events[0]?.params).toMatchObject({ user_mode: "byok" });
    expect(body.events[0]?.params.user_id).toBeUndefined();
  });

  it("omits the user id in BYOK / signed-out mode", async () => {
    setAnalyticsUserMode("byok");
    trackCloudAnalyticsEvent("memory_desktop_search_succeeded", { page_path: "/memory" });
    setDesktopAnalyticsClientId("cid-1");
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: Record<string, unknown> }>;
    };
    expect(body.userId).toBeUndefined();
    expect(body.events[0]?.params).not.toHaveProperty("user_id");
  });

  it("treats the local-user placeholder as no cloud identity", async () => {
    setAnalyticsUserId("  local-user  ");
    trackCloudAnalyticsEvent("page_view", { page_path: "/main" });
    setDesktopAnalyticsClientId("cid-1");
    await flushDesktopCloudAnalytics();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      userId?: string;
      events: Array<{ params: Record<string, unknown> }>;
    };
    expect(body.userId).toBeUndefined();
    expect(body.events[0]?.params).not.toHaveProperty("user_id");
  });

  it("stops sending the user id after logout clears it", async () => {
    setAnalyticsUserId("cloud-uuid-1");
    setDesktopAnalyticsClientId("cid-1");
    trackCloudAnalyticsEvent("account_logout", { page_path: "/settings" });
    await flushDesktopCloudAnalytics();

    setAnalyticsUserId(null);
    trackCloudAnalyticsEvent("page_view", { page_path: "/welcome" });
    await flushDesktopCloudAnalytics();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logoutBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { userId?: string };
    const afterBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { userId?: string };
    expect(logoutBody.userId).toBe("cloud-uuid-1");
    expect(afterBody.userId).toBeUndefined();
  });
});
