import { describe, expect, it } from "vitest";
import { compileWindowsPolicy, isUnsupportedBrowser, authorizedRule } from "../../../../src/tools/computer-history/win/policy.js";
import { parseNativeEvent, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { context } from "./fixtures.js";
import { chromeSnapshot } from "./chrome-capture.test.js";

describe("generic Edge and other browser capture", () => {
  it.each(["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "msedgewebview2.exe"])("does not deny %s based on its family", name => {
    const executable = `C:\\Apps\\${name}`;
    const binding = { ...context, executable };
    const policy = compileWindowsPolicy([], [binding], { defaultApplicationBehavior: "observe" });
    expect(isUnsupportedBrowser(executable)).toBe(false);
    expect(authorizedRule(policy, binding)?.captureText).toBe(true);
  });
  it.each(["normal", "private", "unknown"] as const)("accepts Edge mode %s without avatar proof", mode => {
    const executable = "C:\\Apps\\msedge.exe";
    const binding = { ...context, executable };
    const policy = compileWindowsPolicy([], [binding], { defaultApplicationBehavior: "observe" });
    const raw = chromeSnapshot();
    const event = parseNativeEvent({ ...raw, context: { ...binding, browser: { ...raw.context.browser, kind: "edge", mode } } }) as NativeSnapshotEvent;
    const result = new SnapshotNormalizer().normalize(event, policy, "r");
    expect(result?.details).toMatchObject({ browserKind: "edge", browserMode: mode, url: "https://www.gutenberg.org/ebooks/11" });
    expect(JSON.stringify(result)).toContain("Lewis Carroll");
  });
});
