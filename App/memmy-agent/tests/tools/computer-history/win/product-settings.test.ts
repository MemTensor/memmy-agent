import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationCatalog, parseWindowsSettings, WindowsSettingsStore } from "../../../../src/tools/computer-history/win/settings.js";
import { bindSettings, WindowsPolicySession } from "../../../../src/tools/computer-history/win/session-policy.js";
import * as settingsModule from "../../../../src/tools/computer-history/win/settings.js";
import type { WindowsHistoryRecorder } from "../../../../src/tools/computer-history/win/recorder.js";
import { authorizedRule } from "../../../../src/tools/computer-history/win/policy.js";
import { RecordingWriter } from "../../../../src/tools/computer-history/core/recording.js";
import { compactEventEvidence } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { context, executable, policyInput } from "./fixtures.js";

const roots: string[] = [];
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-product-test-")); roots.push(root); return root; }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Windows application consent", () => {
  it("uses the Mac-style application scope for new profiles and rejects invalid settings", () => {
    const store = new WindowsSettingsStore(path.join(directory(), "settings.json"));
    expect(store.read().applications).toEqual([]);
    expect(store.read().defaultApplicationBehavior).toBe("observe");
    expect(fs.existsSync(store.filePath)).toBe(false);
    for (const value of [
      { version: 1, applications: [{ executable }, { executable: executable.toUpperCase() }] },
      { version: 1, applications: [{ executable: "Fixture.exe" }] },
      { version: 1, applications: [], defaultApplicationBehavior: "invalid" },
    ]) expect(() => parseWindowsSettings(value)).toThrow();
  });
  it("preserves legacy selection and binds broad scopes without allowing excluded, browser or lock processes", () => {
    const store = new WindowsSettingsStore(path.join(directory(), "settings.json"));
    store.write({ version: 1, applications: [] });
    expect(authorizedRule(bindSettings(store, [context]), context)).toBeNull();
    store.write({ version: 1, defaultApplicationBehavior: "observe", applications: [], deny: { executables: [executable] } });
    expect(authorizedRule(bindSettings(store, [context]), context)).toBeNull();
    const other = { ...context, pid: 456, executable: "C:\\Apps\\Other.exe" };
    const browser = { ...context, pid: 457, executable: "C:\\Apps\\chrome.exe" };
    const locked = { ...context, pid: 458, executable: "C:\\Windows\\LockApp.exe" };
    const policy = bindSettings(store, [context, other, browser, locked]);
    expect(authorizedRule(policy, other)).not.toBeNull();
    for (const denied of [context, browser, locked, { ...other, processStart: "134000000000000003" }]) expect(authorizedRule(policy, denied)).toBeNull();
    expect(applicationCatalog([other, browser, locked], store.read()).find((app) => app.executable === other.executable)?.allowed).toBe(true);
    expect(applicationCatalog([], store.read()).find((app) => app.executable === executable)).toMatchObject({ running: false, allowed: false });
  });
  it("supports more than 32 discovered instances in broad mode and still rejects oversized scopes", () => {
    const store = new WindowsSettingsStore(path.join(directory(), "settings.json"));
    const bindings = Array.from({ length: 512 }, (_, index) => ({ ...context, pid: index + 1, executable: `C:\\Apps\\Tool${index}.exe` }));
    expect(bindSettings(store, bindings).applications).toHaveLength(512);
    expect(() => bindSettings(store, [...bindings, { ...context, pid: 600 }])).toThrow("windows_policy_invalid");
  });
  it("rebinds exact instances, keeps profiles and removes authorization when apps close or consent is revoked", () => {
    const store = new WindowsSettingsStore(path.join(directory(), "settings.json"));
    const { pid: _pid, hwnd: _hwnd, processStart: _start, ...rule } = policyInput.applications[0]!;
    void _pid; void _hwnd; void _start;
    store.write({ version: 1, applications: [rule] });
    const first = bindSettings(store, [context]);
    expect(authorizedRule(first, context)?.searchFields).toEqual(rule.searchFields);
    const restarted = { ...context, pid: 234, processStart: "134000000000000002" };
    const second = bindSettings(store, [restarted]);
    expect(authorizedRule(second, context)).toBeNull();
    expect(authorizedRule(second, restarted)).not.toBeNull();
    expect(authorizedRule(bindSettings(store, []), context)).toBeNull();
    store.write({ version: 1, applications: [] });
    expect(authorizedRule(bindSettings(store, [restarted]), restarted)).toBeNull();
    fs.writeFileSync(store.filePath, "broken");
    expect(() => bindSettings(store, [restarted])).toThrow("windows_settings_invalid");
  });
  it("catalog discovery does not authorize apps and preserves stored selector profiles across path aliases", () => {
    const rule = { executable, searchFields: [{ controlType: "Edit" as const, automationId: "search" }] };
    const settings = parseWindowsSettings({ version: 1, applications: [rule, { executable: "C:\\Apps\\Closed.exe" }] });
    const apps = applicationCatalog([{ ...context, executable: executable.toUpperCase() },
      { pid: 22, executable: "C:\\Apps\\chrome.exe", processStart: "134000000000000003" }], settings);
    expect(apps.find((app) => app.running && app.allowed)?.rule).toEqual(rule);
    expect(apps.find((app) => app.name === "Closed.exe")).toMatchObject({ running: false, allowed: true });
    expect(apps.find((app) => app.name === "chrome.exe")).toMatchObject({ supported: false, allowed: false });
  });
  it("refreshes instance bindings and stops safely on corrupted consent", async () => {
    vi.useFakeTimers();
    const store = new WindowsSettingsStore(path.join(directory(), "settings.json"));
    store.write({ version: 1, applications: [{ executable }] });
    const discovery = vi.spyOn(settingsModule, "discoverApplications").mockResolvedValue([context]);
    const session = await WindowsPolicySession.create(store.filePath, "C:\\collector.exe");
    const recorder = { state: "running", updatePolicy: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const error = vi.fn();
    try {
      session.monitor(recorder as unknown as WindowsHistoryRecorder, error);
      const restarted = { ...context, pid: 234, processStart: "134000000000000002" };
      discovery.mockResolvedValue([restarted]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(recorder.updatePolicy).toHaveBeenCalledOnce();
      expect(authorizedRule(recorder.updatePolicy.mock.calls[0]![0], restarted)).not.toBeNull();
      expect(authorizedRule(recorder.updatePolicy.mock.calls[0]![0], context)).toBeNull();
      discovery.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(authorizedRule(recorder.updatePolicy.mock.calls[1]![0], restarted)).toBeNull();
      fs.writeFileSync(store.filePath, "broken");
      await vi.advanceTimersByTimeAsync(2000);
      expect(error.mock.calls[0]![0].message).toBe("windows_policy_refresh_failed");
      expect(recorder.stop).toHaveBeenCalledOnce();
    } finally { await session.dispose(); }
    expect(fs.existsSync(session.file)).toBe(false);
  });
});

describe("closed recording continuation", () => {
  const metadata = { recordingId: "bucket", title: "Fixture", platform: "windows" as const };
  const event = { eventType: "recording_started", timestamp: "2026-10-02T01:00:00.000Z" };
  const stop = { ...event, eventType: "recording_stopped" };
  it("continues a closed bucket with one header and monotonic normalized sequence numbers", () => {
    const file = path.join(directory(), "events.jsonl");
    const first = new RecordingWriter(file, metadata); first.append(event); first.complete(stop);
    const second = new RecordingWriter(file, metadata, true); second.append(event); second.complete(stop);
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((item) => item.recordType === "human_history_metadata")).toHaveLength(1);
    expect(records.slice(1).map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(() => new RecordingWriter(file, metadata)).toThrow();
  });
  it("refuses interrupted, unfinished or cross-platform files without overwriting them", () => {
    const file = path.join(directory(), "events.jsonl");
    const first = new RecordingWriter(file, metadata); first.append(event); first.close();
    const interrupted = fs.readFileSync(file);
    expect(() => new RecordingWriter(file, metadata, true)).toThrow("recording_append_invalid");
    expect(fs.readFileSync(file)).toEqual(interrupted);
    fs.unlinkSync(file);
    const closed = new RecordingWriter(file, metadata); closed.complete(stop);
    expect(() => new RecordingWriter(file, { ...metadata, platform: "macOS" }, true)).toThrow();
    fs.appendFileSync(file, "{");
    expect(() => new RecordingWriter(file, metadata, true)).toThrow();
  });
  it("summarizes text-key counts without claiming resulting characters", () => {
    const raw = JSON.stringify({ recordType: "human_event", eventType: "text_input", timestamp: event.timestamp,
      application: { id: "windows:test", platform: "windows", name: "Fixture.exe" },
      details: { pressCount: 3, unit: "key_press", redacted: true } });
    const evidence = compactEventEvidence([raw]);
    expect(evidence).toContain("3 text-key press(es)");
    expect(evidence).toContain("resulting characters unknown");
    expect(evidence).not.toContain("3 chars");
  });
  it("keeps software-injected inputs and uncertain click effects visible to the model", () => {
    const evidence = compactEventEvidence(["mouse_click", "scroll"].map((eventType) => JSON.stringify({
      recordType: "human_event", eventType, timestamp: event.timestamp, application: { id: "windows:test", name: "Fixture.exe" },
      details: { source: "low_level_hook", injected: true } })));
    expect(evidence).toContain("observed click(s), target/effect unverified");
    expect(evidence).toContain("observed scroll(s), target/effect unverified");
    expect(evidence).toContain("2 input event(s) marked injected; software origin possible");
  });
});
