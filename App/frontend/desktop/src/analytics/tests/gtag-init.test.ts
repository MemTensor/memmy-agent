// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyticsMocks = vi.hoisted(() => ({
  setDesktopAnalyticsClientId: vi.fn(),
  setDesktopAnalyticsContext: vi.fn(),
  trackCloudAnalyticsEvent: vi.fn(),
}));

vi.mock("../cloud-analytics.js", () => analyticsMocks);

describe("gtag initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.head.innerHTML = "";
    window.dataLayer = [];
    Reflect.deleteProperty(window, "gtag");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses app_init to open the GA session and sends app_launch through cloud without a session id", async () => {
    const { initGtag } = await import("../gtag-init.js");
    const appendChild = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node) => node);

    initGtag("G-TEST");

    const injectedScript = appendChild.mock.calls[0]?.[0] as HTMLScriptElement | undefined;
    expect(injectedScript?.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-TEST");

    injectedScript?.dispatchEvent(new Event("load"));

    const commands = window.dataLayer.map((entry) => Array.from(entry));
    expect(commands).toContainEqual(["event", "app_init"]);
    expect(commands).not.toContainEqual(["event", "app_launch"]);

    const clientIdCommand = commands.find(
      ([command, , field]) => command === "get" && field === "client_id"
    );
    const sessionIdCommand = commands.find(
      ([command, , field]) => command === "get" && field === "session_id"
    );
    expect(clientIdCommand).toBeDefined();
    expect(sessionIdCommand).toBeUndefined();

    const clientIdCallback = clientIdCommand?.[3] as ((value: unknown) => void) | undefined;
    clientIdCallback?.("client-123");

    expect(analyticsMocks.setDesktopAnalyticsClientId).toHaveBeenCalledWith("client-123");
    expect(analyticsMocks.trackCloudAnalyticsEvent).toHaveBeenCalledWith("app_launch");
  });
});
