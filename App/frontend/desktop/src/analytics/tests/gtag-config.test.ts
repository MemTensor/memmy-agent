import { describe, expect, it } from "vitest";
import {
  resolveAnalyticsAppEnv,
  resolveGtagConfigOptions,
  resolveGtagDebugMode
} from "../gtag-config.js";

describe("gtag config", () => {
  it("maps build mode to app_env", () => {
    expect(resolveAnalyticsAppEnv(true)).toBe("prod");
    expect(resolveAnalyticsAppEnv(false)).toBe("dev");
  });

  it("enables debug_mode in dev or when explicitly requested", () => {
    expect(resolveGtagDebugMode(true, false)).toBe(true);
    expect(resolveGtagDebugMode(false, true)).toBe(true);
    expect(resolveGtagDebugMode(false, false)).toBe(false);
  });

  it("includes app_env and debug_mode in gtag config options", () => {
    expect(
      resolveGtagConfigOptions({ isProd: false, isDev: true, explicitDebug: false })
    ).toEqual({
      send_page_view: false,
      app_env: "dev",
      debug_mode: true
    });

    expect(
      resolveGtagConfigOptions({ isProd: true, isDev: false, explicitDebug: false })
    ).toEqual({
      send_page_view: false,
      app_env: "prod"
    });

    expect(
      resolveGtagConfigOptions({ isProd: true, isDev: false, explicitDebug: true })
    ).toEqual({
      send_page_view: false,
      app_env: "prod",
      debug_mode: true
    });
  });
});
