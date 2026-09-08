import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  evaluateObservation,
  hostFromUrl,
  parseObservationSettings,
  type ObservationRule,
  type ObservationSettings,
} from "../../../../src/core/agent-runtime/computer-history/observation-settings.js";

function settings(
  defaultApplicationBehavior: "observe" | "do_not_observe",
  defaultURLBehavior: "observe" | "do_not_observe",
  rules: ObservationRule[] = [],
): ObservationSettings {
  return { observation: { defaultApplicationBehavior, defaultURLBehavior, rules } };
}

describe("observation settings", () => {
  it("records nothing until the user allows something", () => {
    expect(DEFAULT_OBSERVATION_SETTINGS.observation.defaultApplicationBehavior).toBe("do_not_observe");
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, { bundleId: "com.apple.Notes" })).toEqual({
      observe: false,
      reason: "application_not_allowed",
    });
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
