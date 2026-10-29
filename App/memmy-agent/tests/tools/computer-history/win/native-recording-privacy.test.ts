import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

class SyntheticNative extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
  killed = false;
  stopInput = "";
  constructor() {
    super();
    this.stdin.on("data", (chunk) => { this.stopInput += chunk.toString(); });
    this.stdin.on("finish", () => { this.emit("close", 0); });
  }
  kill() { this.killed = true; this.emit("close", 0); return true; }
}
const native = vi.hoisted(() => ({ child: null as SyntheticNative | null }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { native.child = new SyntheticNative(); return native.child; },
}));
vi.mock("../../../../src/tools/computer-history/win/win11.js", () => ({
  isWindows11: () => true,
  windowsObserverCommand: () => ({ binary: "synthetic-native-no-desktop", args: [] }),
}));
import { run, WINDOWS_HISTORY_STREAM_DISCONNECT } from "../../../../src/tools/computer-history/mac/record-human-history.js";
import { compactEventEvidence, writeSegmentNarrative } from "../../../../src/tools/computer-history/mac/summary-writer.js";

it("keeps excluded websites out of raw records and model input, whatever the browsing mode, through the real Windows recorder pipeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-history-private-fixture-"));
  const settings = path.join(root, "settings.json"); const output = path.join(root, "events.jsonl");
  fs.writeFileSync(settings, JSON.stringify({ memory: { syncEnabled: true }, observation: {
    defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [
      { scope: "url", urlDomain: "company.test", behavior: "do_not_observe" },
    ],
  } }));
  const platform = process.platform;
  const signalListeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, new Set(process.listeners(signal))]));
  vi.stubEnv("MEMMY_HOME", root);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const pending = run(["node", "synthetic-recorder", "--out", output, "--no-screenshots", "--capture-search-text", "--observation-settings", settings]);
    await Promise.resolve();
    const child = native.child!;
    const observation = (url: string, marker: string, mode: string = "normal", complete = true) => ({
      kind: "sampling.changed", timestamp: "2026-10-13T03:00:00.000Z",
      app: { name: "chrome", bundleIdentifier: "win32.chrome", pid: 45, secureInput: false },
      window: { browser: true, windowId: "33", title: marker, browserContext: { url, documentUrl: url, mode, complete, windowId: "33", processId: 45 } },
      ax: { mode: "fullTree", windowKey: `45:33:${url}`, text: `ControlType.Text||${marker}|||` },
    });
    for (const event of [
      observation("https://company.test/finance", "EXCLUDED_COMPANY_FINANCE"),
      observation("https://company.test/private", "EXCLUDED_PRIVATE_COMPANY", "private"),
      observation("https://allowed.test/", "PRIVATE_INCOGNITO_CONTENT", "private"),
      observation("https://allowed.test/", "UNKNOWN_MODE_CONTENT", "unknown"),
      observation("https://allowed.test/", "PARTIAL_CHROME_CONTENT", "normal", false),
      observation("https://allowed.test/", "ALLOWED_PRODUCT_COMPARISON"),
    ]) child.stdout.write(`${JSON.stringify(event)}\n`);
    for (const listener of process.listeners("SIGTERM")) {
      if (!signalListeners.get("SIGTERM")!.has(listener)) listener("SIGTERM");
    }
    await pending;
    expect(child.stopInput).toBe('{"kind":"stop"}\n');
    expect(child.killed).toBe(false);
    const raw = fs.readFileSync(output, "utf8");
    for (const marker of ["ALLOWED_PRODUCT_COMPARISON", "PRIVATE_INCOGNITO_CONTENT", "UNKNOWN_MODE_CONTENT", "PARTIAL_CHROME_CONTENT"]) {
      expect(raw).toContain(marker);
    }
    expect(raw).not.toMatch(/EXCLUDED_COMPANY_FINANCE|EXCLUDED_PRIVATE_COMPANY|company\.test/);
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    const evidence = compactEventEvidence(raw.trim().split("\n"));
    const retainedEvidence = compactEventEvidence(raw.trim().split("\n"), { purpose: "retention" });
    expect(retainedEvidence).not.toMatch(/EXCLUDED_COMPANY_FINANCE|EXCLUDED_PRIVATE_COMPANY|company\.test/);
    const chat = vi.fn(async () => ({ content: JSON.stringify({ title: "Product comparison", description: "You compared a product." }) }));
    await writeSegmentNarrative((() => ({ model: "synthetic", provider: { chatWithRetry: chat } })) as any,
      { applications: ["chrome"], evidence, window: "10min" });
    expect(chat).toHaveBeenCalledTimes(1);
    const modelInput = JSON.stringify(chat.mock.calls);
    expect(modelInput).toContain("ALLOWED_PRODUCT_COMPARISON");
    expect(modelInput).not.toMatch(/EXCLUDED_COMPANY_FINANCE|EXCLUDED_PRIVATE_COMPANY|company\.test|image_url/);
    expect(records.some((record) => record.screenshot)).toBe(false);
  } finally {
    native.child?.kill();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) if (!signalListeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([0, 1, null])("reports unexpected native exit %s as a retryable disconnect, including a silent clean exit", async (code) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-history-disconnect-fixture-"));
  const platform = process.platform;
  const listeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, new Set(process.listeners(signal))]));
  vi.stubEnv("MEMMY_HOME", root);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const pending = run(["node", "synthetic-recorder", "--out", path.join(root, "events.jsonl"), "--no-screenshots"]);
    const assertion = expect(pending).rejects.toThrow(WINDOWS_HISTORY_STREAM_DISCONNECT);
    await Promise.resolve();
    native.child!.emit("exit", code, code === null ? "SIGKILL" : null);
    await assertion;
    expect(native.child!.stopInput).toBe('{"kind":"stop"}\n');
  } finally {
    native.child?.kill();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) if (!listeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  }
});
