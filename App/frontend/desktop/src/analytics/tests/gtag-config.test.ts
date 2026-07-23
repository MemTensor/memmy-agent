import { describe, expect, it } from "vitest";
import {
  resolveAnalyticsAppEdition,
  resolveAnalyticsAppEnv,
  resolveGtagConfigOptions,
  resolveGtagDebugMode
} from "../gtag-config.js";

describe("gtag config", () => {
  it("maps build mode to app_env", () => {
    expect(resolveAnalyticsAppEnv(true)).toBe("prod");
    expect(resolveAnalyticsAppEnv(false)).toBe("dev");
  });

  it("maps MEMMY_APP_EDITION to app_edition and defaults to cn", () => {
    expect(resolveAnalyticsAppEdition("intl")).toBe("intl");
    expect(resolveAnalyticsAppEdition("INTL")).toBe("intl");
    expect(resolveAnalyticsAppEdition("cn")).toBe("cn");
    expect(resolveAnalyticsAppEdition("")).toBe("cn");
    expect(resolveAnalyticsAppEdition(undefined)).toBe("cn");
  });

  it("enables debug_mode in dev or when explicitly requested", () => {
    expect(resolveGtagDebugMode(true, false)).toBe(true);
    expect(resolveGtagDebugMode(false, true)).toBe(true);
    expect(resolveGtagDebugMode(false, false)).toBe(false);
  });

  it("includes app_env, app_edition, and debug_mode in gtag config options", () => {
    expect(
      resolveGtagConfigOptions({
        isProd: false,
        isDev: true,
        explicitDebug: false,
        appEdition: "cn"
      })
    ).toEqual({
      send_page_view: false,
      app_env: "dev",
      app_edition: "cn",
      debug_mode: 1
    });

    expect(
      resolveGtagConfigOptions({
        isProd: true,
        isDev: false,
        explicitDebug: false,
        appEdition: "intl"
      })
    ).toEqual({
      send_page_view: false,
      app_env: "prod",
      app_edition: "intl"
    });

    expect(
      resolveGtagConfigOptions({
        isProd: true,
        isDev: false,
        explicitDebug: true,
        appEdition: "cn"
      })
    ).toEqual({
      send_page_view: false,
      app_env: "prod",
      app_edition: "cn",
      debug_mode: 1
    });
  });
});
