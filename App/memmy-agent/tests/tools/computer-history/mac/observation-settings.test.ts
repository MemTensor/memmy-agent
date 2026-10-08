import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  evaluateObservation,
  hostFromUrl,
  parseObservationSettings,
  type ObservationRule,
  type ObservationSettings,
} from "../../../../src/tools/computer-history/mac/observation-settings.js";

function settings(
  defaultApplicationBehavior: "observe" | "do_not_observe",
  defaultURLBehavior: "observe" | "do_not_observe",
  rules: ObservationRule[] = [],
): ObservationSettings {
  return { memory: { syncEnabled: false }, observation: { defaultApplicationBehavior, defaultURLBehavior, rules } };
}

describe("observation settings", () => {
  it("observes by default so the history is never silently empty", () => {
    expect(DEFAULT_OBSERVATION_SETTINGS.memory.syncEnabled).toBe(true);
    expect(DEFAULT_OBSERVATION_SETTINGS.observation.defaultApplicationBehavior).toBe("observe");
    expect(DEFAULT_OBSERVATION_SETTINGS.observation.rules).toEqual([]);
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, { bundleId: "com.apple.Notes" }))
      .toEqual({ observe: true, reason: "observed" });
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/a",
    })).toEqual({ observe: true, reason: "observed" });
  });

  it("keeps an explicit Memory sync opt-out when parsing settings", () => {
    expect(parseObservationSettings({ observation: {
      defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [],
    } }).memory.syncEnabled).toBe(true);
    expect(parseObservationSettings({ memory: { syncEnabled: false }, observation: {
      defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [],
    } }).memory.syncEnabled).toBe(false);
  });

  it("uses the same explicit WeChat consent for generic screen history", () => {
    const explicitlyAllowed = settings("observe", "observe", [
      { scope: "app", bundleID: "com.tencent.xinWeChat", behavior: "observe" },
    ]);
    expect(evaluateObservation(explicitlyAllowed, { bundleId: "com.tencent.xinWeChat" }))
      .toEqual({ observe: false, reason: "wechat_consent_required" });
    expect(evaluateObservation(explicitlyAllowed, {
      bundleId: "com.tencent.xinWeChat", weChatChatAccess: true,
    })).toEqual({ observe: true, reason: "observed" });
  });

  it("still excludes private browsing under the permissive default", () => {
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/a",
      privateBrowsing: true,
    })).toEqual({ observe: false, reason: "private_browsing" });
  });

  it("keeps personal WeChat outside broad screen consent even if an app rule allows it", () => {
    for (const bundleId of ["com.tencent.xinWeChat", "com.tencent.WeChat", "win32.wechat", "win32.weixin"]) {
      expect(evaluateObservation(settings("observe", "observe", [
        { scope: "app", bundleID: bundleId, behavior: "observe" }
      ]), { bundleId })).toEqual({ observe: false, reason: "wechat_consent_required" });
      expect(evaluateObservation(settings("observe", "observe", [
        { scope: "app", bundleID: bundleId, behavior: "observe" }
      ]), { bundleId, weChatChatAccess: true })).toEqual({ observe: true, reason: "observed" });
    }
  });

  it("excludes private browsing whatever the rules say", () => {
    const permissive = settings("observe", "observe");
    expect(evaluateObservation(permissive, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/page",
      privateBrowsing: true,
    })).toEqual({ observe: false, reason: "private_browsing" });
  });

  it("judges a record without a usable URL by its application alone", () => {
    const allowNotes = settings("do_not_observe", "do_not_observe", [
      { scope: "app", bundleID: "com.apple.Notes", behavior: "observe" },
    ]);
    // The URL axis would reject everything, but a Notes window has no URL.
    expect(evaluateObservation(allowNotes, { bundleId: "com.apple.Notes" }).observe).toBe(true);
  });

  it("requires a browser record to pass both axes", () => {
    const appAllowed = settings("observe", "do_not_observe", [
      { scope: "url", urlDomain: "example.com", behavior: "observe" },
    ]);
    expect(evaluateObservation(appAllowed, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/a",
    }).observe).toBe(true);
    expect(evaluateObservation(appAllowed, {
      bundleId: "com.google.Chrome",
      url: "https://other.com/a",
    })).toEqual({ observe: false, reason: "url_not_allowed" });
  });

  it("blocks an unreadable browser address only when websites are allowlisted", () => {
    const allowlist = settings("observe", "do_not_observe");
    for (const url of [undefined, "", "not a url", "chrome://newtab/"]) {
      expect(evaluateObservation(allowlist, { bundleId: "com.google.Chrome", url })).toEqual({
        observe: false, reason: "url_not_allowed",
      });
      expect(evaluateObservation(allowlist, { bundleId: "company.thebrowser.Browser", url }).observe).toBe(false);
      expect(evaluateObservation(allowlist, { bundleId: "com.example.NewBrowser", browser: true, url }).observe).toBe(false);
    }
    expect(evaluateObservation(allowlist, { bundleId: "com.apple.Notes" }).observe).toBe(true);

    const blocklist = settings("observe", "observe", [
      { scope: "url", urlDomain: "aws.com", behavior: "do_not_observe" },
      { scope: "url", urlDomain: "qq.com", behavior: "do_not_observe" },
    ]);
    for (const url of [undefined, "", "not a url", "chrome://newtab/"]) {
      expect(evaluateObservation(blocklist, { bundleId: "win32.chrome", browser: true, url })).toEqual({
        observe: true, reason: "observed",
      });
      expect(evaluateObservation(blocklist, { bundleId: "com.google.Chrome", url })).toEqual({
        observe: true, reason: "observed",
      });
    }
    expect(evaluateObservation(blocklist, {
      bundleId: "win32.chrome", browser: true, url: "https://map.baidu.com/search",
    })).toEqual({ observe: true, reason: "observed" });
    expect(evaluateObservation(blocklist, {
      bundleId: "win32.chrome", url: "https://www.qq.com/mail",
    })).toEqual({ observe: false, reason: "url_blocked" });
    expect(evaluateObservation(blocklist, {
      bundleId: "win32.chrome", url: "https://console.aws.com/home",
    })).toEqual({ observe: false, reason: "url_blocked" });
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, { bundleId: "com.google.Chrome" }).observe).toBe(true);
  });

  it("lets a block rule win over an allow rule inside the same axis", () => {
    const conflicting = settings("observe", "observe", [
      { scope: "url", urlDomain: "example.com", behavior: "observe" },
      { scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
    ]);
    expect(evaluateObservation(conflicting, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/a",
    })).toEqual({ observe: false, reason: "url_blocked" });
  });

  it("matches an excluded application even when only the case or a helper id differs", () => {
    const blocked = settings("observe", "observe", [
      { scope: "app", bundleID: "com.alibaba.DingTalkMac", behavior: "do_not_observe" },
    ]);
    expect(evaluateObservation(blocked, { bundleId: "COM.ALIBABA.DINGTALKMAC" }).observe).toBe(false);
    expect(evaluateObservation(blocked, { bundleId: "com.alibaba.DingTalkMac.ScreenShotHelper" }).observe).toBe(false);
    expect(evaluateObservation(blocked, { bundleId: "com.google.Chrome.canary" }).observe).toBe(true);
    expect(evaluateObservation(settings("observe", "observe", [
      { scope: "app", bundleID: "com.google.Chrome", behavior: "do_not_observe" },
    ]), { bundleId: "com.google.Chrome.canary" }).observe).toBe(true);
  });

  it("drops a matching website on macOS and Windows, and keeps a browser whose address is unreadable", () => {
    const blocked = settings("observe", "observe", [
      { scope: "url", urlDomain: "www.bank.com", behavior: "do_not_observe" },
    ]);
    expect(evaluateObservation(blocked, { bundleId: "com.google.Chrome", url: "https://bank.com/pay" }).observe)
      .toBe(false);
    expect(evaluateObservation(blocked, { bundleId: "win32.chrome", url: "https://secure.bank.com/pay" }).observe)
      .toBe(false);
    expect(evaluateObservation(blocked, { bundleId: "com.quark.desktop" })).toEqual({
      observe: true, reason: "observed",
    });
    expect(evaluateObservation(blocked, { bundleId: "win32.msedge", browser: true })).toEqual({
      observe: true, reason: "observed",
    });
    expect(evaluateObservation(blocked, { bundleId: "com.apple.Notes" }).observe).toBe(true);
    expect(evaluateObservation(blocked, {
      bundleId: "win32.chrome", url: "https://example.com/a",
    }).observe).toBe(true);
    expect(evaluateObservation(settings("observe", "observe", [
      { scope: "app", bundleID: "win32.excel", behavior: "do_not_observe" },
      { scope: "url", urlDomain: "qq.com", behavior: "do_not_observe" },
    ]), { bundleId: "win32.excel" })).toEqual({ observe: false, reason: "application_blocked" });
  });

  it("matches subdomains of a bare domain rule", () => {
    const blocked = settings("observe", "observe", [
      { scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" },
    ]);
    expect(evaluateObservation(blocked, { bundleId: "c", url: "https://secure.bank.com/x" }).observe)
      .toBe(false);
    // A domain that merely ends with the same letters must not match.
    expect(evaluateObservation(blocked, { bundleId: "c", url: "https://notbank.com/x" }).observe)
      .toBe(true);
  });

  it("keeps the two axes independent", () => {
    const appBlocked = settings("do_not_observe", "observe", [
      { scope: "url", urlDomain: "example.com", behavior: "observe" },
    ]);
    // Allowing the site cannot rescue a disallowed application.
    expect(evaluateObservation(appBlocked, {
      bundleId: "com.google.Chrome",
      url: "https://example.com/a",
    })).toEqual({ observe: false, reason: "application_not_allowed" });
  });

  it("reads the host from absolute http(s) URLs only", () => {
    expect(hostFromUrl("https://Example.COM/path?q=1")).toBe("example.com");
    expect(hostFromUrl("file:///etc/passwd")).toBeNull();
    expect(hostFromUrl("not a url")).toBeNull();
  });

  it("rejects a URL where a bare domain is required", () => {
    expect(() => parseObservationSettings({
      observation: {
        defaultApplicationBehavior: "observe",
        defaultURLBehavior: "observe",
        rules: [{ scope: "url", urlDomain: "https://example.com/a", behavior: "observe" }],
      },
    })).toThrow(ObservationSettingsError);
  });

  it("validates a complete document and normalizes domains", () => {
    const parsed = parseObservationSettings({
      observation: {
        defaultApplicationBehavior: "do_not_observe",
        defaultURLBehavior: "observe",
        rules: [
          { scope: "app", bundleID: " com.apple.Notes ", behavior: "observe" },
          { scope: "url", urlDomain: ".Example.COM.", behavior: "do_not_observe" },
        ],
      },
    });
    expect(parsed.observation.rules).toEqual([
      { scope: "app", bundleID: "com.apple.Notes", behavior: "observe" },
      { scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
    ]);
  });

  it("refuses a partial document, because updates replace rather than merge", () => {
    expect(() => parseObservationSettings({ observation: { defaultApplicationBehavior: "observe" } }))
      .toThrow(ObservationSettingsError);
    expect(() => parseObservationSettings({})).toThrow(ObservationSettingsError);
  });
});
