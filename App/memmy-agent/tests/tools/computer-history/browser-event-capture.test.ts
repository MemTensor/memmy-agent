import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCaptureProvider, type BrowserCaptureTransport } from "../../../src/tools/computer-history/browser-event-capture.js";
import { PluginEventSessions } from "../../../src/tools/plugin-host/event-sessions.js";
import { DEFAULT_OBSERVATION_SETTINGS } from "../../../src/tools/computer-history/core/observation-settings.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(platform: NodeJS.Platform = "win32") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-teach-source-")); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.now(), sequence = 0, listener: (message: Record<string, unknown>) => void = () => undefined;
  let subscribed = true, complete = true, coverage = true;
  const docs = new Map<string, {tabId: number; windowId: number; sequence: number}>();
  const profiles = [{ connectionId: "personal", browser: "chrome" as const, supported: true, windows: [] as Array<{ tabId: number; title: string; url: string }> }];
  const calls: Array<{ action: string; input?: Record<string, unknown> }> = [];
  let onPrepare: (() => Promise<unknown>) | undefined, onStop: (() => void) | undefined;
  const transport: BrowserCaptureTransport = {
    listTeachingProfiles: () => profiles,
    subscribeTeaching(_connectionId, _sessionId, value) { listener = value; return () => { subscribed = false; }; },
    async teachingCommand(_connectionId, _sessionId, action, input) {
      calls.push({ action, input });
      if (action === "prepare") { await onPrepare?.(); return { protocolVersion: 2, windowId: 20, incognito: false }; }
      if (action === "start") return { protocolVersion: 2, recording: true };
      if (action === "stop") {
        onStop?.();
        for (const [documentId, doc] of docs) emit({kind: "document-closed", documentId, tabId: doc.tabId, documentSequence: doc.sequence, confirmed: true});
      }
      return { protocolVersion: 2, boundaryConfirmed: complete, coverageComplete: coverage, complete: complete && coverage, lastSequence: sequence };
    },
  };
  const provider = createBrowserCaptureProvider(transport, { settingsFile: path.join(root, "settings.json"), platform, now: () => time });
  const desktop = { acquireEventCapture: vi.fn(async () => { throw Error("Desktop capture must not run during browser teaching"); }) };
  const service = new PluginEventSessions({ dataRoot: path.join(root, "data"), source: desktop, browser: provider, now: () => time });
  cleanups.push(() => service.close());
  function emit(value: Record<string, unknown>) { if (subscribed) listener({ sequence: ++sequence, ...value }); }
  const document = (tabId = 8, windowId = 20, documentId = "doc-a", url = "https://example.test/search") => {
    if (!docs.has(documentId)) docs.set(documentId, {tabId, windowId, sequence: 0});
    emit({ kind: "document", tabId, windowId, documentId, url, incognito: false });
  };
  const event = (details: Record<string, unknown> = { label: "Search", text: "research topic" }, extra: Record<string, unknown> = {}) => {
    const doc = docs.get(String(extra.documentId ?? "doc-a"));
    const valid = doc && doc.tabId === (extra.tabId ?? 8) && doc.windowId === (extra.windowId ?? 20);
    const localSequence = valid ? ++doc.sequence : 1;
    emit({ kind: "event", tabId: 8, windowId: 20, documentId: "doc-a", eventType: "text_input", observedAt: time,
      url: "https://example.test/search?private=value#secret", documentSequence: localSequence, details, ...extra });
  };
  const start = () => service.start("teach-mode", "chat-a", "Search and save", true, { name: "chrome" });
  return { root, service, provider, transport, profiles, desktop, calls, document, event, emit, start,
    advance: (ms = 10) => { time += ms; }, setIncomplete: () => { complete = false; }, setCoverageGap: () => { coverage = false; },
    preparing: (fn: () => Promise<unknown>) => { onPrepare = fn; }, stopping: (fn: () => void) => { onStop = fn; } };
}
describe("teaching-window browser source", () => {
  it.each(["darwin", "win32"] as const)("starts with a URL allowlist on %s while retaining per-page exclusions", async platform => {
    const f = fixture(platform), policy = structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    policy.observation.defaultApplicationBehavior = "do_not_observe";
    policy.observation.defaultURLBehavior = "do_not_observe";
    policy.observation.rules = [
      { scope: "app", bundleID: platform === "darwin" ? "com.google.Chrome" : "win32.chrome", behavior: "observe" },
      { scope: "url", urlDomain: "example.test", behavior: "observe" },
      { scope: "url", urlDomain: "private.example.test", behavior: "do_not_observe" },
    ];
    fs.writeFileSync(path.join(f.root, "settings.json"), JSON.stringify(policy));
    const session = await f.start(); f.document(); f.event({ text: "allowed-publication" });
    f.document(9, 20, "private", "https://private.example.test/");
    f.event({ text: "excluded-site-secret" }, { tabId: 9, documentId: "private", url: "https://private.example.test/" });
    f.document(10, 20, "other", "https://other.test/");
    f.event({ text: "outside-allowlist-secret" }, { tabId: 10, documentId: "other", url: "https://other.test/" });
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result).toMatchObject({ state: "ready", eventCount: 1, availability: "partial" });
    const source = fs.readFileSync(path.join(f.root, "data", "teach-mode", "event-sessions", session.id, "browser-source.jsonl"), "utf8");
    expect(source).toContain("allowed-publication");
    expect(source).not.toMatch(/excluded-site-secret|outside-allowlist-secret/);
    expect(f.calls.find(call => call.action === "prepare")?.input?.settings).toEqual(policy);
    expect(f.desktop.acquireEventCapture).not.toHaveBeenCalled();
  });
  it.each(["darwin", "win32"] as const)("still rejects an excluded browser before opening a window on %s", async platform => {
    const f = fixture(platform), policy = structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    policy.observation.defaultURLBehavior = "do_not_observe";
    policy.observation.rules = [{ scope: "app", bundleID: platform === "darwin" ? "com.google.Chrome" : "win32.chrome", behavior: "do_not_observe" }];
    fs.writeFileSync(path.join(f.root, "settings.json"), JSON.stringify(policy));
    await expect(f.start()).rejects.toThrow("application_excluded");
    expect(f.calls).toHaveLength(0);
  });
  it("separates historical coverage from a confirmed and saved stop", async () => {
    const f = fixture(), session = await f.start(); f.document(); f.event(); f.setCoverageGap();
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result).toMatchObject({availability: "partial", captureIntegrity: {coverageComplete: false, boundaryConfirmed: true, snapshotSaved: true}});
    expect(result.limitations.join(" ")).not.toContain("Native-to-disk");
    expect(result.captureIntegrity?.proofSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps the old document's authorized tail after a new document registers", async () => {
    const f = fixture(), session = await f.start(); f.document(); f.document(8, 20, "doc-b");
    f.event({text: "old-document-tail"});
    f.event({text: "new-document-input"}, {documentId: "doc-b"});
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result).toMatchObject({availability: "available", eventCount: 2});
    expect(JSON.stringify(f.service.readEvents("teach-mode", "chat-a", session.id))).toContain("old-document-tail");
  });
  it("rejects a final document sequence with a missing event and seals proof against later mutation", async () => {
    const f = fixture(), session = await f.start(); f.document(); f.event();
    f.emit({kind: "document-closed", tabId: 8, documentId: "doc-a", documentSequence: 2, confirmed: true});
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result.availability).toBe("partial");
    const proof = path.join(f.root, "data", "teach-mode", "event-sessions", session.id, "capture-proof.jsonl");
    fs.appendFileSync(proof, "{}\n");
    expect(() => f.service.readEvents("teach-mode", "chat-a", session.id)).toThrow("capture_proof_hash_mismatch");
  });
  it("opens a closed ordinary browser and waits for its extension without creating or copying a profile", async () => {
    const f = fixture(), saved = f.profiles.splice(0);
    const launch = vi.fn(async () => { f.profiles.push(saved[0]!); });
    const provider = createBrowserCaptureProvider(f.transport, { settingsFile: path.join(f.root, "settings.json"), launch });
    const subscription = await provider.acquire({ sessionId: "00000000-0000-4000-8000-000000000001", directory: path.join(f.root, "direct"), request: { name: "chrome" }, signal: new AbortController().signal });
    expect(launch).toHaveBeenCalledWith("chrome"); expect(subscription.browserCapture.windowId).toBe(20);
    await subscription.release();
  });
  it("uses only its private stream and freezes an immutable, hashed fragment without touching desktop History", async () => {
    const f = fixture(), session = await f.start();
    expect(session.browserCapture).toEqual({ browser: "chrome", windowId: 20, scope: "teaching-window-and-popups" });
    f.advance(); f.document(); f.event();
    f.stopping(() => { f.advance(); f.event({ text: "after accepted cutoff" }); });
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result).toMatchObject({ state: "ready", availability: "available", eventCount: 1 });
    const evidence = f.service.readEvents("teach-mode", "chat-a", session.id);
    expect(evidence.events).toMatchObject([{ source: { stream: `browser:${session.id}` }, event: { details: { text: "research topic" }, window: { url: "https://example.test/search" } } }]);
    expect(f.desktop.acquireEventCapture).not.toHaveBeenCalled();
    const saved = JSON.stringify(evidence);
    f.event({ text: "after release" });
    expect(JSON.stringify(f.service.readEvents("teach-mode", "chat-a", session.id))).toBe(saved);
    expect(f.calls.map(call => call.action)).toEqual(["prepare", "start", "stop", "cancel"]);
  });
  it("refuses cross-window, unannounced document and other-tab events before writing page values", async () => {
    const f = fixture(), session = await f.start();
    f.advance(); f.document();
    f.event({ text: "daily-window-secret" }, { windowId: 1 });
    f.event({ text: "other-tab-secret" }, { tabId: 7 });
    f.event({ text: "stale-document-secret" }, { documentId: "old-doc" });
    f.event({ text: "inside" });
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result).toMatchObject({ eventCount: 1, availability: "partial" });
    const source = fs.readFileSync(path.join(f.root, "data", "teach-mode", "event-sessions", session.id, "browser-source.jsonl"), "utf8");
    expect(source).not.toMatch(/daily-window-secret|other-tab-secret|stale-document-secret/);
  });
  it("requires a specific profile when several same-brand extension connections exist", async () => {
    const f = fixture(); f.profiles.push({ ...f.profiles[0]!, connectionId: "work" });
    await expect(f.start()).rejects.toThrow("profile_selection_required");
    expect(f.calls).toHaveLength(0);
    const selected = await f.service.start("teach-mode", "chat-b", "Goal", true, { name: "chrome", connection_id: "work" });
    expect(selected.state).toBe("recording");
  });
  it("exposes preparation without starting the clock and cancels a pending window startup", async () => {
    const f = fixture(); let finish!: () => void;
    f.preparing(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    const pending = f.start();
    await vi.waitFor(() => expect(f.calls[0]?.action).toBe("prepare"));
    const preparation = f.service.list("teach-mode", "chat-a")[0]!;
    expect(preparation).toMatchObject({ state: "starting", browserCapture: { browser: "chrome" } });
    expect(f.service.isBusy("teach-mode")).toBe(true);
    const cancelled = await f.service.stop("teach-mode", "chat-a", preparation.id, true);
    expect(cancelled.state).toBe("cancelled"); finish();
    expect((await pending).state).toBe("cancelled");
    expect(f.calls.some(call => call.action === "start")).toBe(false);
  });
  it("requires browser-proven popup ancestry and revokes a tab on removal", async () => {
    const f = fixture(), session = await f.start(); f.advance(); f.document();
    f.emit({ kind: "window", windowId: 30, sourceTabId: 8, sourceWindowId: 20 });
    f.document(9, 30, "popup");
    f.event({ label: "Confirm" }, { windowId: 30, tabId: 9, documentId: "popup" });
    f.emit({ kind: "tab-left", tabId: 9 });
    f.event({ text: "dragged-out" }, { windowId: 30, tabId: 9, documentId: "popup" });
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result.eventCount).toBe(1);
  });
  it("keeps a missing browser boundary partial instead of inferring completion from fsync", async () => {
    const f = fixture(), session = await f.start(); f.advance(); f.document(); f.event(); f.setIncomplete();
    expect(await f.service.stop("teach-mode", "chat-a", session.id)).toMatchObject({ state: "ready", availability: "partial", eventCount: 1 });
  });
  it("enforces URL exclusions at the Host too and redacts password-shaped payloads", async () => {
    const f = fixture(), session = await f.start(); f.advance(); f.document();
    f.event({ text: "never-keep-password", inputType: "password" });
    const policy = structuredClone(DEFAULT_OBSERVATION_SETTINGS);
    policy.observation.rules.push({ scope: "url", urlDomain: "example.test", behavior: "do_not_observe" });
    fs.writeFileSync(path.join(f.root, "settings.json"), JSON.stringify(policy));
    f.event({ text: "excluded-page-body" });
    const result = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(result.eventCount).toBe(1);
    const source = fs.readFileSync(path.join(f.root, "data", "teach-mode", "event-sessions", session.id, "browser-source.jsonl"), "utf8");
    expect(source).not.toMatch(/never-keep-password|excluded-page-body/);
  });
  it("respects Windows executable exclusions before opening a teaching window", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "windows-settings.json"), JSON.stringify({ version: 1, applications: [], defaultApplicationBehavior: "observe", deny: { executables: ["C:\\Browser\\chrome.exe"] } }));
    await expect(f.start()).rejects.toThrow("application_excluded"); expect(f.calls).toHaveLength(0);
  });
  it("does not recover recording authority after extension disconnect or plugin disable", async () => {
    const f = fixture(), session = await f.start(); f.advance(); f.document(); f.event(); f.emit({ kind: "disconnected" });
    const failed = await f.service.stop("teach-mode", "chat-a", session.id);
    expect(failed).toMatchObject({ state: "failed", availability: "partial", eventCount: 1,
      captureIntegrity: {coverageComplete: false, boundaryConfirmed: false, snapshotSaved: false} });
    expect(f.service.isBusy("teach-mode")).toBe(false);
    expect(f.calls.at(-1)?.action).toBe("cancel");
  });
});
