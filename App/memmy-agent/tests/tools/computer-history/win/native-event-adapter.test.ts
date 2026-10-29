import { describe, expect, it } from "vitest";
import { applyWindowsBrowserPrivacy, normalizeWindowsKeyboardAction, previousControlsAtPoint } from "../../../../src/tools/computer-history/win/native-event-adapter.js";
import { evaluateObservation, type ObservationSettings } from "../../../../src/tools/computer-history/mac/observation-settings.js";
import { buildBrowserAuthoritySnapshot } from "../../../../src/tools/computer-history/browser-privacy.js";
import { filterHistoryAuthorityObservations } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

const policy: ObservationSettings = { memory: { syncEnabled: true }, observation: {
  defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [
    { scope: "url", urlDomain: "company.test", behavior: "do_not_observe" },
  ],
} };
function browser(url = "https://company.test/finance", mode = "normal", complete = true) {
  return { kind: "sampling.changed", app: { name: "chrome", bundleIdentifier: "win32.chrome", pid: 41 },
    window: { browser: true, windowId: "17", url: "https://stale.test/", browserContext: {
      url, documentUrl: url, mode, complete, windowId: "17", processId: 41,
    } }, ax: { mode: "fullTree", text: "ControlType.Text||COMPANY_CONTENT|||" } } as any;
}
describe("Windows native recording boundary", () => {
  it("keeps earlier control context separate, bounded, and free of values or sensitive fields", () => {
    const before = { observedAt: "2026-10-15T12:00:00Z", interpretation: "previously_observed_not_confirmed_target",
      controls: [{ role: "AXButton", title: "Finish", value: "PRIVATE_VALUE", x: 12 },
        { role: "AXSecureTextField", name: "PRIVATE_PASSWORD" }] };
    expect(previousControlsAtPoint(before, "2026-10-15T12:00:01Z")).toEqual({
      observedAt: "2026-10-15T12:00:00.000Z", interpretation: "previously_observed_not_confirmed_target",
      controls: [{ role: "AXButton", title: "Finish" }],
    });
    expect(previousControlsAtPoint(before, "2026-10-15T11:59:59Z")).toBeNull();
    expect(previousControlsAtPoint(before, "2026-10-15T12:00:06Z")).toBeNull();
    expect(previousControlsAtPoint({ ...before, interpretation: "confirmed" }, "2026-10-15T12:00:01Z")).toBeNull();
    expect(previousControlsAtPoint({ ...before, controls: Array(4).fill(before.controls[0]) }, "2026-10-15T12:00:01Z")).toBeNull();
  });
  it("uses this native window URL and honors an explicit website exclusion", () => {
    const event = browser();
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.url).toBe("https://company.test/finance");
    expect(evaluateObservation(policy, { bundleId: "win32.chrome", browser: true, url: event.window.url }).observe).toBe(false);
  });
  it.each(["private", "unknown", "normal"])("keeps an allowed %s browser window even with incomplete chrome evidence", (mode) => {
    const event = browser("https://allowed.test/page", mode, false);
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.url).toBe("https://allowed.test/page");
    expect(event.window).not.toHaveProperty("privateBrowsing");
    expect(event.window).not.toHaveProperty("privateBrowsingUnknown");
    expect(evaluateObservation(policy, { bundleId: "win32.chrome", browser: true, url: event.window.url }).observe).toBe(true);
  });
  it.each(["missing", "wrong-window", "wrong-process", "uncommitted"])("cannot rescue %s native address with a stale sidecar URL", (kind) => {
    const event = browser("https://company.test/finance");
    if (kind === "missing") delete event.window.browserContext;
    if (kind === "wrong-window") event.window.browserContext.windowId = "18";
    if (kind === "wrong-process") event.window.browserContext.processId = 42;
    if (kind === "uncommitted") event.window.browserContext.documentUrl = "https://other.test/";
    applyWindowsBrowserPrivacy(event, { version: 2, updatedAt: Date.now(), browsers: { chrome: { connected: true, activeUrl: "https://allowed.test/" } } });
    expect(event.window.url).toBeUndefined();
    expect(evaluateObservation(policy, { bundleId: "win32.chrome", browser: true, url: null }).observe).toBe(false);
  });
  it("recognizes a browser process even when the helper omitted its browser flag and address", () => {
    const event = browser();
    delete event.window.browser; delete event.window.browserContext;
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.browser).toBe(true);
    expect(event.window.url).toBeUndefined();
  });
  it("retains the authority sidecar and never stores excluded URL or title there", () => {
    const now = Date.now();
    const observations = filterHistoryAuthorityObservations(policy, [{
      connectionId: "profile-1", browser: "chrome", focused: true, tabId: 5, windowId: 8,
      title: "PRIVATE_COMPANY_TITLE", url: "https://company.test/finance", mode: "normal", observedAt: now, receivedAt: now,
    }]);
    const snapshot = buildBrowserAuthoritySnapshot(["chrome"], observations, now);
    expect(JSON.stringify(snapshot)).not.toMatch(/company\.test|PRIVATE_COMPANY_TITLE/);
    expect(snapshot.browsers.chrome?.focusedTab?.mode).toBe("unknown");
    const event = browser("https://allowed.test/");
    applyWindowsBrowserPrivacy(event, snapshot, now);
    expect(event.window.url).toBe("https://allowed.test/");
  });
  it("keeps a native private window even when extension focus reports private mode", () => {
    const now = Date.now();
    const snapshot = buildBrowserAuthoritySnapshot(["chrome"], [{
      connectionId: "profile-1", browser: "chrome", focused: true, tabId: 5, windowId: 8,
      title: "Private", url: "https://allowed.test/private", mode: "private", observedAt: now, receivedAt: now,
    }], now);
    const event = browser("https://allowed.test/private", "private");
    applyWindowsBrowserPrivacy(event, snapshot, now);
    expect(event.window.url).toBe("https://allowed.test/private");
    expect(snapshot.browsers.chrome?.focusedTab?.url).toBe("");
  });
  it("withholds a contradictory extension URL without discarding the native window", () => {
    const now = Date.now();
    const snapshot = buildBrowserAuthoritySnapshot(["chrome"], [{
      connectionId: "profile-1", browser: "chrome", focused: true, tabId: 5, windowId: 8,
      title: "Other page", url: "https://other.test/page", mode: "normal", observedAt: now, receivedAt: now,
    }], now);
    const event = browser("https://allowed.test/page");
    applyWindowsBrowserPrivacy(event, snapshot, now);
    expect(event.window.browser).toBe(true);
    expect(event.window.url).toBeUndefined();
    expect(event.window).not.toHaveProperty("privateBrowsingUnknown");
  });
  it("removes credentials, query and fragment from a native page address", () => {
    const event = browser("https://user:secret@example.com/path?token=secret#fragment", "unknown");
    applyWindowsBrowserPrivacy(event, null);
    expect(event.window.url).toBe("https://example.com/path");
    expect(JSON.stringify(event.window.url)).not.toMatch(/secret|token/);
  });
});
describe("Windows action metadata", () => {
  function key(category: string, target: Record<string, unknown> = {}) {
    return { kind: "keyboard.keydown", app: { secureInput: false }, keyboard: {
      category, count: 2, text: "RAW_HOOK_SECRET", target: { role: "AXTextField", ...target },
    } };
  }
  it.each(["submit", "shortcut", "delete", "navigation"])("does not copy raw hook or target values for %s", (category) => {
    const action = normalizeWindowsKeyboardAction(key(category, { value: "PRIVATE_DRAFT", secret: "EXTRA_SECRET" }), null, false);
    expect(action).not.toBeNull();
    expect(JSON.stringify(action)).not.toMatch(/RAW_HOOK_SECRET|PRIVATE_DRAFT|EXTRA_SECRET/);
  });
  it("retains an ordinary focused field's current value without copying hook text or arbitrary fields", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", {
      identifier: "qt_chat...textEditWidget", value: "发给同事的钉钉消息", secret: "EXTRA_SECRET",
    }), null, false, true);
    expect(action?.details).toMatchObject({
      text: "发给同事的钉钉消息", textSource: "focused_field_value", redacted: false,
      actionCount: 2, characterCount: 0,
    });
    expect(action?.details).not.toHaveProperty("textPurpose");
    expect(JSON.stringify(action)).not.toMatch(/RAW_HOOK_SECRET|EXTRA_SECRET/);
  });
  it("keeps an unreadable field redacted instead of falling back to hook characters", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", { identifier: "qt_chat...textEditWidget" }), null, false, true);
    expect(action?.details).toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(action?.details).not.toHaveProperty("textSource");
    expect(JSON.stringify(action)).not.toContain("RAW_HOOK_SECRET");
  });
  it("retains search metadata when enabled without making search a condition for ordinary text", () => {
    const context = { purpose: "search_query", role: "AXTextField", label: "Search" };
    const event = key("typing", { value: "录音卡", description: "Search" });
    expect(normalizeWindowsKeyboardAction(event, context, true)?.details).toMatchObject({
      text: "录音卡", textSource: "focused_field_value", textPurpose: "search_query", input: context, redacted: false,
    });
    expect(normalizeWindowsKeyboardAction(event, context, false, true)?.details).toMatchObject({
      text: "录音卡", textSource: "focused_field_value", redacted: false,
    });
    expect(normalizeWindowsKeyboardAction(event, context, false, true)?.details).not.toHaveProperty("textPurpose");
  });
  it("honors disabled ordinary text capture and fields with no readable value", () => {
    const draft = key("typing", { value: "私人草稿" });
    expect(normalizeWindowsKeyboardAction(draft, null, false, false)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(draft, null, true, false)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(key("typing", { value: "" }), null, false, true)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(normalizeWindowsKeyboardAction(key("typing", { value: "[REDACTED]" }), null, false, true)?.details)
      .toMatchObject({ text: "[REDACTED]", redacted: true });
  });
  it("redacts credential patterns inside a readable field value", () => {
    const action = normalizeWindowsKeyboardAction(key("typing", {
      value: "账号文档 api_key=sample-secret-value 已打开",
    }), null, false, true);
    expect(action?.details).toMatchObject({
      text: "账号文档 api_key=[REDACTED] 已打开", textSource: "focused_field_value", redacted: false,
    });
    expect(JSON.stringify(action)).not.toContain("sample-secret-value");
  });
  it("excludes password targets, secure input and unbounded categories/counts", () => {
    expect(normalizeWindowsKeyboardAction(key("typing", { subrole: "AXSecureTextField", value: "PASSWORD" }), null, true, true)).toBeNull();
    expect(normalizeWindowsKeyboardAction(key("typing", { IsPassword: true, value: "PASSWORD" }), null, true, true)).toBeNull();
    const event = key("typing"); event.app.secureInput = true;
    expect(normalizeWindowsKeyboardAction(event, null, true)).toBeNull();
    expect(normalizeWindowsKeyboardAction(key("RAW_HOOK_SECRET"), null, true)).toBeNull();
    const excess = key("typing"); excess.keyboard.count = 10001;
    expect(normalizeWindowsKeyboardAction(excess, null, true)).toBeNull();
  });
});
