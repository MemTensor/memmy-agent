import { afterEach, describe, expect, it, vi } from "vitest";
import { browserHistoryConfiguration, connectBrowserHistoryBridge } from "../../../src/tools/computer-history/browser-history-bridge.js";
import type { BrowserHistoryCaptureIntent, BrowserHistoryTrustedContext } from "../../../src/tools/computer-history/browser-semantic-history.js";
import { DEFAULT_OBSERVATION_SETTINGS } from "../../../src/tools/computer-history/mac/observation-settings.js";

const context: BrowserHistoryTrustedContext = { connectionId: "connection-1", browser: "chrome", tabId: 2, windowId: 1,
  url: "https://work.test/form", frameUrl: "https://frame.test/form", documentId: "document-1", privateBrowsing: false, protected: false };
const capture = (): BrowserHistoryCaptureIntent => ({ enabled: true, generation: "recording-1", captureText: true,
  settings: structuredClone(DEFAULT_OBSERVATION_SETTINGS) });
afterEach(() => vi.useRealTimers());

describe("passive browser History bridge authorization", () => {
  it.each(["darwin", "win32"] as const)("applies the existing %s app and frame/site policy before issuing a short lease", platform => {
    const intent = capture(), now = Date.now();
    expect(browserHistoryConfiguration(intent, context, now, platform)).toEqual({ enabled: true, generation: "recording-1", captureText: true, expiresAt: now + 1500 });
    intent.settings!.observation.rules.push({ scope: "url", urlDomain: "frame.test", behavior: "do_not_observe" });
    expect(browserHistoryConfiguration(intent, context, now, platform).enabled).toBe(false);
    intent.settings!.observation.rules = [{ scope: "app", bundleID: platform === "win32" ? "win32.chrome" : "com.google.Chrome", behavior: "do_not_observe" }];
    expect(browserHistoryConfiguration(intent, context, now, platform).enabled).toBe(false);
  });

  it("applies website exclusions to every ancestor of a nested frame", () => {
    const intent = capture();
    const nested = { ...context, frameUrl: "https://widget.test/embed", ancestorOrigins: ["https://bank.test", "https://work.test"] };
    expect(browserHistoryConfiguration(intent, nested).enabled).toBe(true);
    expect(browserHistoryConfiguration(intent, { ...nested, ancestorOrigins: ["null", "https://work.test"] }).enabled).toBe(false);
    intent.settings!.observation.rules.push({ scope: "url", urlDomain: "bank.test", behavior: "do_not_observe" });
    expect(browserHistoryConfiguration(intent, nested).enabled).toBe(false);
  });

  it("fails closed on default deny, missing policy, private/unknown, protected or non-web identity", () => {
    const intent = capture();
    for (const change of [{ enabled: false }, { settings: null }, { generation: null }])
      expect(browserHistoryConfiguration({ ...intent, ...change }, context).enabled).toBe(false);
    for (const change of [{ privateBrowsing: true }, { privateBrowsing: null }, { protected: true }, { url: "chrome://extensions" },
      { frameUrl: "about:blank" }, { documentId: "" }, { tabId: -1 }, { windowId: -1 }])
      expect(browserHistoryConfiguration(intent, { ...context, ...change }).enabled).toBe(false);
    intent.settings!.observation.defaultURLBehavior = "do_not_observe";
    intent.settings!.observation.rules = [{ scope: "url", urlDomain: "work.test", behavior: "observe" }];
    expect(browserHistoryConfiguration(intent, context).enabled).toBe(false);
  });

  it("refreshes live recording intent without an Agent session and tears down subscription and timer", () => {
    vi.useFakeTimers();
    let intent = capture(), provider: (() => BrowserHistoryCaptureIntent) | null = null;
    let listener: ((payload: unknown, context: BrowserHistoryTrustedContext) => void) | null = null;
    const refresh = vi.fn(), ingest = vi.fn(() => true), unsubscribe = vi.fn();
    const connection = connectBrowserHistoryBridge({ getBrowserCaptureIntent: () => intent, ingestBrowserSemanticEvent: ingest }, {
      setBrowserHistoryIntentProvider(value) { provider = value; return () => { provider = null; }; },
      subscribeBrowserHistory(value) { listener = value; return unsubscribe; },
      refreshBrowserHistoryIntent: refresh,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    (listener! as (payload: unknown, context: BrowserHistoryTrustedContext) => void)({}, context);
    expect(ingest).toHaveBeenCalledTimes(1);
    intent = { ...intent, enabled: false };
    expect(provider!().enabled).toBe(false);
    (listener! as (payload: unknown, context: BrowserHistoryTrustedContext) => void)({}, context);
    expect(ingest).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(2);
    connection.close();
    expect(provider).toBeNull(); expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(3);
    connection.close(); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
