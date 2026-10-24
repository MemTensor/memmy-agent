import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class SyntheticRecorder extends EventEmitter {
  pid = 678901; stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  kill() { if (!state.holdExit) this.exit(); return true; }
  exit() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit("exit", 0); this.emit("close", 0); }
}
const state = vi.hoisted(() => ({ children: [] as SyntheticRecorder[], holdExit: false, url: "https://allowed.test/product", observedAt: 0 }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { const child = new SyntheticRecorder(); state.children.push(child); return child; },
}));
vi.mock("../../../../src/tools/computer-history/win/win11.js", () => ({
  isWindows11: () => true,
  windowsObserverCommand: () => ({ binary: "synthetic-no-desktop", args: [] }),
  listWindowsApplications: async () => [],
}));
vi.mock("../../../../src/core/agent-runtime/tools/external-browser-bridge.js", async (original) => ({
  ...await original<typeof import("../../../../src/core/agent-runtime/tools/external-browser-bridge.js")>(),
  externalBrowserBridge: {
    listConnected: () => ["chrome"],
    listHistoryFocusObservations: () => [{ connectionId: "synthetic-profile", browser: "chrome", focused: true,
      tabId: 7, windowId: 1, title: "PRIVATE_TITLE_SHOULD_NEVER_BE_STORED", url: state.url, mode: "normal",
      observedAt: state.observedAt, receivedAt: state.observedAt }],
  },
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

let root: string;
let service: ComputerHistoryDemoService;
let platform: string;
const policy = (rules: unknown[] = []) => ({ memory: { syncEnabled: true }, observation: {
  defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules,
} });
const settingsFile = () => path.join(root, "settings.json");
const authorityFile = () => path.join(root, "browser-authority.json");
const saved = () => fs.readFileSync(authorityFile(), "utf8");

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T03:01:00Z"));
  state.children.length = 0; state.holdExit = false; state.url = "https://allowed.test/product"; state.observedAt = Date.now();
  platform = process.platform; Object.defineProperty(process, "platform", { value: "win32" });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-authority-publisher-"));
  const recorderScript = path.join(root, "synthetic-recorder.js"); fs.writeFileSync(recorderScript, "// inert spawn fixture");
  fs.writeFileSync(settingsFile(), JSON.stringify(policy()));
  // A prior app run can leave a fresh URL: construction must clear it before any async initialization.
  fs.writeFileSync(authorityFile(), JSON.stringify({ priorURL: "https://previous-secret.test/" }));
  service = new ComputerHistoryDemoService({ recorderScript, historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"), workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: settingsFile(), weChatConsentFile: path.join(root, "consent.json"),
    permissionReader: async () => ({ supported: true, accessibility: true, inputMonitoring: true }),
  });
  await vi.waitFor(() => expect((service as any).publishBrowserAuthority).toBeTypeOf("function"));
});
afterEach(async () => {
  state.holdExit = false; for (const child of state.children) child.exit();
  await service.shutdown(); Object.defineProperty(process, "platform", { value: platform });
  vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true });
});

describe("browser authority recording intent and strict policy", () => {
  it("clears prior identity and never publishes URLs before explicit recording starts", async () => {
    expect(JSON.parse(saved()).browsers).toEqual({});
    expect(saved()).not.toMatch(/previous-secret|allowed\.test|PRIVATE_TITLE/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(saved()).browsers).toEqual({});
    service.startObservation();
    expect(saved()).toContain("allowed.test/product");
    expect(saved()).not.toContain("PRIVATE_TITLE");
  });

  it.each(["corrupt", "missing"])("revokes a stored URL when policy becomes %s instead of applying observe-all defaults", async (mode) => {
    service.startObservation(); expect(saved()).toContain("allowed.test");
    if (mode === "corrupt") fs.writeFileSync(settingsFile(), "{ incomplete policy"); else fs.rmSync(settingsFile());
    state.url = "https://company.test/finance";
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(saved()).browsers).toEqual({});
    expect(saved()).not.toMatch(/allowed\.test|company\.test|PRIVATE_TITLE/);
  });

  it("applies URL/application exclusions synchronously when settings change", () => {
    service.startObservation(); expect(saved()).toContain("allowed.test");
    service.updateObservationSettings(policy([{ scope: "url", urlDomain: "allowed.test", behavior: "do_not_observe" }]));
    expect(saved()).not.toMatch(/allowed\.test|PRIVATE_TITLE/);
    service.updateObservationSettings(policy()); expect(saved()).toContain("allowed.test");
    service.updateObservationSettings(policy([{ scope: "app", bundleID: "win32.chrome", behavior: "do_not_observe" }]));
    expect(saved()).not.toMatch(/allowed\.test|PRIVATE_TITLE/);
  });

  it.each(["pause", "stop"])("revokes identity at the start of %s while the native child is still draining", async (operation) => {
    service.startObservation(); expect(saved()).toContain("allowed.test");
    state.holdExit = true;
    const pending = operation === "pause" ? service.pauseObservation() : service.stopObservation();
    expect(state.children[0]?.exitCode).toBeNull();
    expect(JSON.parse(saved()).browsers).toEqual({});
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(saved()).browsers).toEqual({});
    state.children[0]!.exit(); await pending; state.holdExit = false;
    if (operation === "pause") {
      service.resumeObservation(); expect(saved()).toContain("allowed.test");
    }
  });

  it("clears identity immediately on shutdown and does not retain prior URL on disk", async () => {
    service.startObservation(); expect(saved()).toContain("allowed.test");
    const pending = service.shutdown();
    expect(JSON.parse(saved()).browsers).toEqual({}); await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(saved()).browsers).toEqual({});
  });
});
