import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memmy-browser");
const script = fs.readFileSync(path.join(extension, "browser-history-background.js"), "utf8");
const sender = (overrides: any = {}) => ({ id: "extension-id", tab: { id: 7 }, frameId: 0,
  documentId: "document-1", documentLifecycle: "active", url: "https://work.test/form", ...overrides });

function harness() {
  let handler: (message: any, sender: any, respond: (value: any) => void) => any = () => undefined;
  const handlers: Record<string, (...args: any[]) => void> = {}, sent: any[] = [], revocations: any[] = [], wakeups: any[] = [];
  const tab: any = { id: 7, windowId: 1, active: true, incognito: false, status: "complete", url: "https://work.test/form" };
  const window: any = { id: 1, focused: true, incognito: false, type: "normal" };
  const documents = new Set(["document-1", "iframe-1"]);
  let connected = true, protectedPage = false, allowed = true, missingReceiver = false, command: any, authorizations = 0;
  const injections: any[] = [];
  const chrome: any = { runtime: { id: "extension-id", onMessage: { addListener: (fn: typeof handler) => { handler = fn; }, removeListener: vi.fn() } },
    tabs: { get: async () => ({ ...tab }), query: async () => tab.active ? [{ ...tab }] : [],
      sendMessage: async (_tabId: number, message: any, options: any) => {
        if (message.type === "memmy_history_revoke") { revocations.push({ message, options }); return; }
        if (message.type === "memmy_history_refresh") {
          if (missingReceiver) throw new Error("Could not establish connection. Receiving end does not exist.");
          wakeups.push(message); return;
        }
        if (!documents.has(options.documentId)) throw new Error("Document no longer exists");
        return { active: true };
      },
      onActivated: { addListener: (fn: any) => { handlers.activate = fn; } },
      onUpdated: { addListener: (fn: any) => { handlers.update = fn; } },
      onRemoved: { addListener: (fn: any) => { handlers.remove = fn; } } },
    windows: { get: async () => ({ ...window }), getLastFocused: async () => ({ ...window }),
      onFocusChanged: { addListener: (fn: any) => { handlers.focus = fn; } } },
    debugger: { attach: vi.fn(() => { throw new Error("History must never attach the debugger"); }), sendCommand: vi.fn() },
    scripting: { executeScript: async (details: any) => { injections.push(details); missingReceiver = false; return []; } },
  };
  let sequence = 0;
  const sandbox = vm.createContext({ chrome, URL, crypto: { randomUUID: () => `lease-${++sequence}` }, Date, setTimeout, clearTimeout });
  vm.runInContext(script, sandbox);
  const dependencies: any = { chrome, isConnected: () => connected, send: (message: any) => sent.push(message),
    isProtected: async () => protectedPage, browserName: () => "chrome", activeCommand: () => command,
    authorize: async () => { authorizations++; return { enabled: allowed, generation: "recording-1", expiresAt: Date.now() + 1500, captureText: true }; } };
  const background = (sandbox as any).installMemmyBrowserHistoryBackground(dependencies);
  const permit = (generation = "recording-1") => background.receive({ type: "browser_history_intent", enabled: true, generation, expiresAt: Date.now() + 1500 });
  const invoke = (message: any, source = sender()) => new Promise<any>(resolve => { if (handler(message, source, resolve) !== true) resolve(null); });
  const configure = (source = sender(), ancestorOrigins: unknown = []) => invoke({ type: "memmy_history_config", ancestorOrigins }, source);
  const payload = (generation = "recording-1", documentId = "document-1") => ({ version: 1, eventId: "event-1",
    observedAt: Date.now(), generation, documentId, action: "change", target: { role: "checkbox", name: "Selected", checked: true } });
  const emit = (configuration: any, source = sender(), extra: any = {}) => invoke({ type: "memmy_history_event",
    leaseId: configuration.leaseId, payload: { ...payload(configuration.generation, source.documentId), ...extra } }, source);
  return { chrome, tab, window, documents, sent, revocations, wakeups, injections, handlers, background, dependencies, configure, emit, permit, payload, invoke,
    setConnected: (value: boolean) => { connected = value; }, setProtected: (value: boolean) => { protectedPage = value; },
    setMissingReceiver: (value: boolean) => { missingReceiver = value; },
    setAllowed: (value: boolean) => { allowed = value; }, setCommand: (value: any) => { command = value; }, authorizations: () => authorizations };
}
afterEach(() => vi.useRealTimers());

describe("isolated passive browser History transport", () => {
  it("is dormant until live History consent and never uses the debugger even with no Agent claim", async () => {
    const test = harness();
    expect(await test.configure()).toMatchObject({ enabled: false }); expect(test.authorizations()).toBe(0);
    test.permit();
    const configuration = await test.configure(); expect(configuration.enabled).toBe(true);
    expect(await test.emit(configuration)).toEqual({ accepted: true });
    expect(test.sent.at(-1)).toMatchObject({ type: "browser_history", tabId: 7, windowId: 1,
      documentId: "document-1", actor: "unknown", engine: "content_script" });
    expect(test.chrome.debugger.attach).not.toHaveBeenCalled(); expect(test.chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("requires extension-owned active document and current focused normal non-private browser identity", async () => {
    const test = harness(); test.permit();
    for (const overrides of [{ id: "another-extension" }, { tab: undefined }, { frameId: -1 }, { documentId: "" },
      { documentLifecycle: "cached" }, { url: "chrome://settings" }, { url: "https://different.test/" }]) {
      expect(await test.configure(sender(overrides))).toMatchObject({ enabled: false });
    }
    for (const overrides of [{ incognito: true }, { incognito: undefined }, { active: false }, { pendingUrl: "https://next.test/" }, { status: "loading" }]) {
      const original = { ...test.tab }; Object.assign(test.tab, overrides);
      expect(await test.configure()).toMatchObject({ enabled: false }); Object.assign(test.tab, original);
    }
    test.window.focused = false; expect(await test.configure()).toMatchObject({ enabled: false });
    test.window.focused = true; test.setProtected(true); expect(await test.configure()).toMatchObject({ enabled: false });
    test.setProtected(false); test.setAllowed(false); expect(await test.configure()).toMatchObject({ enabled: false });
  });

  it("rejects old iframe documents, stale URL/focus and config replies completing after navigation", async () => {
    const test = harness(); test.permit();
    const frame = sender({ frameId: 2, documentId: "iframe-1", url: "https://frame.test/form" });
    const configuration = await test.configure(frame, ["https://work.test"]); expect(configuration.enabled).toBe(true);
    test.documents.delete("iframe-1"); expect(await test.emit(configuration, frame)).toEqual({ accepted: false });
    const fresh = await test.configure(); expect(fresh.enabled).toBe(true);
    test.handlers.focus(); expect(await test.emit(fresh)).toEqual({ accepted: false });
    expect(test.revocations.length).toBeGreaterThan(0);
    let resolveAuthorization: (value: any) => void = () => undefined;
    let authorizationStarted = false;
    test.dependencies.authorize = () => new Promise(resolve => { authorizationStarted = true; resolveAuthorization = resolve; });
    const work = test.configure();
    await vi.waitFor(() => expect(authorizationStarted).toBe(true));
    test.handlers.update(7, { status: "loading" });
    resolveAuthorization({ enabled: true, generation: "recording-1", expiresAt: Date.now() + 1500, captureText: true });
    expect(await work).toMatchObject({ enabled: false });
  });

  it("gives no lease to a frame whose reported ancestry is missing, opaque, non-web or not rooted at its tab", async () => {
    const test = harness(); test.permit();
    const nested = sender({ frameId: 3, documentId: "iframe-1", url: "https://widget.test/embed" });
    for (const ancestorOrigins of [undefined, [], "https://work.test", ["https://bank.test"], ["https://work.test", "https://bank.test"],
      ["null", "https://work.test"], ["chrome-extension://bank", "https://work.test"], ["https://bank.test/", "https://work.test"],
      [7, "https://work.test"], Array(33).fill("https://work.test")]) {
      expect(await test.invoke({ type: "memmy_history_config", ancestorOrigins }, nested)).toEqual({ enabled: false, idle: true });
    }
    expect(await test.configure(sender(), ["https://work.test"])).toEqual({ enabled: false, idle: true });
    expect(test.authorizations()).toBe(0);
    expect(await test.configure(nested, ["https://bank.test", "https://work.test"])).toMatchObject({ enabled: true });
  });

  it("sends a nested frame's leased ancestry with its config request and every event, not a later page-supplied list", async () => {
    const test = harness(); delete test.dependencies.authorize; test.permit();
    const nested = sender({ frameId: 3, documentId: "iframe-1", url: "https://widget.test/embed" });
    const ancestorOrigins = ["https://bank.test", "https://work.test"];
    const work = test.configure(nested, ancestorOrigins);
    await vi.waitFor(() => expect(test.sent.at(-1)?.type).toBe("browser_history_config_request"));
    const request = test.sent.at(-1);
    expect(request).toMatchObject({ frameId: 3, topUrl: "https://work.test/form", frameUrl: "https://widget.test/embed", ancestorOrigins });
    test.background.receive({ type: "browser_history_config", id: request.id, enabled: true,
      generation: "recording-1", expiresAt: Date.now() + 1500, captureText: true });
    const configuration = await work; expect(configuration.enabled).toBe(true);
    expect(await test.invoke({ type: "memmy_history_event", leaseId: configuration.leaseId, ancestorOrigins: ["https://work.test"],
      payload: test.payload("recording-1", "iframe-1") }, nested)).toEqual({ accepted: true });
    expect(test.sent.at(-1)).toMatchObject({ type: "browser_history", frameId: 3, ancestorOrigins });
  });

  it("ignores page actor/identity and labels only worker-owned input evidence as agent", async () => {
    const test = harness(); test.permit(); const configuration = await test.configure();
    expect(await test.emit(configuration, sender(), { actor: "human", browser: "edge", tabId: 999, isTrusted: true })).toEqual({ accepted: true });
    expect(test.sent.at(-1)).toMatchObject({ actor: "unknown", tabId: 7, browser: "chrome" });
    expect(test.sent.at(-1).actorEvidence).toBeUndefined();
    test.setCommand({ commandId: "input-1", taskId: "task-1" });
    expect(await test.emit(configuration)).toEqual({ accepted: true });
    expect(test.sent.at(-1)).toMatchObject({ actor: "agent", actorEvidence: { kind: "memmy_command", commandId: "input-1", taskId: "task-1" } });
  });

  it("keeps a page's lease across a same-site route change and ends it for another site or a reload", async () => {
    const test = harness(); test.permit(); const configuration = await test.configure();
    test.tab.url = "https://work.test/form?query=fixture";
    test.handlers.update(7, { url: test.tab.url }, { ...test.tab });
    expect(test.revocations).toHaveLength(0);
    expect(await test.emit(configuration, sender({ url: test.tab.url }))).toEqual({ accepted: true });
    test.handlers.update(7, { status: "loading" }, { ...test.tab });
    expect(test.revocations).toHaveLength(1);
    const renewed = await test.configure(sender({ url: test.tab.url }));
    test.tab.url = "https://other.test/";
    test.handlers.update(7, { url: test.tab.url, status: "loading" }, { ...test.tab });
    expect(test.revocations).toHaveLength(2);
    expect(await test.emit(renewed, sender({ url: test.tab.url }))).toEqual({ accepted: false });
    test.background.close();
  });

  it("does not interrupt the focused page's lease when an unrelated background tab navigates", async () => {
    const test = harness(); test.permit(); const configuration = await test.configure();
    test.handlers.update(99, { status: "loading" });
    expect(await test.emit(configuration)).toEqual({ accepted: true });
    expect(test.revocations).toHaveLength(0); test.background.close();
  });

  it("revokes on intent change/disconnect and bounds payloads and timestamps without persisting events", async () => {
    const test = harness(); test.permit(); const configuration = await test.configure();
    expect(await test.emit(configuration, sender(), { observedAt: Date.now() - 2000 })).toEqual({ accepted: false });
    expect(await test.emit(configuration, sender(), { extra: "x".repeat(24001) })).toEqual({ accepted: false });
    test.background.receive({ type: "browser_history_intent", enabled: false });
    expect(await test.emit(configuration)).toEqual({ accepted: false }); expect(test.sent).toHaveLength(0);
    test.permit(); const next = await test.configure();
    test.setConnected(false); test.background.disconnected();
    expect(await test.emit(next)).toEqual({ accepted: false }); expect(await test.configure()).toMatchObject({ enabled: false });
  });

  it("uses a request/response bridge policy when no direct authorizer is supplied", async () => {
    const test = harness(); delete test.dependencies.authorize; test.permit();
    const work = test.configure();
    await vi.waitFor(() => expect(test.sent.at(-1)?.type).toBe("browser_history_config_request"));
    const request = test.sent.at(-1);
    expect(request).toMatchObject({ browser: "chrome", tabId: 7, windowId: 1, topUrl: "https://work.test/form",
      frameUrl: "https://work.test/form", documentId: "document-1", privateBrowsing: false, protected: false });
    test.background.receive({ type: "browser_history_config", id: request.id, enabled: true,
      generation: "recording-1", expiresAt: Date.now() + 1500, captureText: false });
    expect(await work).toMatchObject({ enabled: true, captureText: false });
  });

  it("wakes only the focused normal active tab after enable/focus, without waking it on every unchanged intent refresh", async () => {
    vi.useFakeTimers(); const test = harness(); test.permit();
    await vi.advanceTimersByTimeAsync(25); expect(test.wakeups).toHaveLength(1);
    test.permit(); await vi.advanceTimersByTimeAsync(25); expect(test.wakeups).toHaveLength(1);
    test.handlers.activate(); await vi.advanceTimersByTimeAsync(25); expect(test.wakeups).toHaveLength(2);
    test.window.focused = false; test.handlers.focus();
    await vi.advanceTimersByTimeAsync(25); expect(test.wakeups).toHaveLength(2);
    test.background.close();
  });

  it("upgrades already-open pages with the same dormant isolated scripts only after current normal metadata checks", async () => {
    vi.useFakeTimers(); const test = harness(); test.setMissingReceiver(true); test.permit();
    await vi.advanceTimersByTimeAsync(25);
    expect(test.injections).toEqual([{ target: { tabId: 7, allFrames: true }, world: "ISOLATED", files: ["history-sensor.js", "history-content.js"] }]);
    test.setMissingReceiver(true); test.setProtected(true); test.handlers.activate();
    await vi.advanceTimersByTimeAsync(25); expect(test.injections).toHaveLength(1);
    test.setProtected(false); test.window.incognito = true; test.handlers.focus();
    await vi.advanceTimersByTimeAsync(25); expect(test.injections).toHaveLength(1);
    test.background.close();
  });

  it("does not inject an upgrade when the tab navigates during its asynchronous metadata check", async () => {
    vi.useFakeTimers(); const test = harness(); test.setMissingReceiver(true);
    const original = test.chrome.tabs.get;
    test.chrome.tabs.get = async () => {
      test.handlers.update(7, { status: "loading" });
      return original();
    };
    test.permit(); await vi.advanceTimersByTimeAsync(25);
    expect(test.injections).toHaveLength(0); test.background.close();
  });

  it("ships only isolated http(s) frame scripts and obtains no grant from web page messages", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
    expect(manifest.content_scripts).toEqual([{ matches: ["http://*/*", "https://*/*"], js: ["history-sensor.js", "history-content.js"],
      all_frames: true, match_about_blank: false, world: "ISOLATED", run_at: "document_start" },
      { matches: ["http://*/*", "https://*/*"], js: ["teaching-page.js"], run_at: "document_start", all_frames: false }]);
    const content = fs.readFileSync(path.join(extension, "history-content.js"), "utf8");
    expect(content).not.toMatch(/(?:addEventListener\(["']message|postMessage\(|\beval\(|new Function)/u);
  });

  it("reads no DOM without authorization, expires a disconnected sensor and clears it on explicit revoke", async () => {
    vi.useFakeTimers();
    let reply: any = { enabled: false }, listener: any;
    const install = vi.fn(), stop = vi.fn();
    const domRead = vi.fn(() => { throw new Error("Unauthorized DOM read"); });
    const document = new Proxy({}, { get: domRead });
    const request = vi.fn(() => Promise.resolve(reply));
    const chrome = { runtime: { id: "extension-id", sendMessage: request,
      onMessage: { addListener: (value: any) => { listener = value; } } } };
    const sandbox = vm.createContext({ chrome, document, Date, setTimeout, clearTimeout, addEventListener: vi.fn(),
      __memmyInstallBrowserHistorySensor: install, __memmyBrowserHistorySensor: { stop } });
    vm.runInContext(fs.readFileSync(path.join(extension, "history-content.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(extension, "history-content.js"), "utf8"), sandbox);
    await Promise.resolve(); await Promise.resolve();
    expect(install).not.toHaveBeenCalled(); expect(domRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2999); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
    reply = { enabled: true, generation: "recording-1", documentId: "document-1", leaseId: "lease-1", captureText: false, expiresAt: Date.now() + 1500 };
    listener({ type: "memmy_history_refresh" }, { id: "extension-id" }, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(install).toHaveBeenCalledTimes(1); expect(domRead).not.toHaveBeenCalled();
    // Simulate a worker/network loss: requests never complete, so the short lease expires independently.
    chrome.runtime.sendMessage = vi.fn(() => new Promise(() => undefined));
    const beforeExpiry = stop.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(stop.mock.calls.length).toBeGreaterThan(beforeExpiry);
    listener({ type: "memmy_history_revoke" }, { id: "extension-id" }, vi.fn());
    expect(stop.mock.calls.length).toBeGreaterThan(beforeExpiry + 1);
  });

  it("reports the browser's ancestor frame origins with its lease request without reading the DOM", () => {
    const request = vi.fn(() => Promise.resolve({ enabled: false, idle: true }));
    const domRead = vi.fn(() => { throw new Error("Unauthorized DOM read"); });
    const chrome = { runtime: { id: "extension-id", sendMessage: request, onMessage: { addListener: vi.fn() } } };
    const sandbox = vm.createContext({ chrome, document: new Proxy({}, { get: domRead }), Date, setTimeout, clearTimeout,
      location: { ancestorOrigins: { length: 2, 0: "https://bank.test", 1: "https://work.test" } }, addEventListener: vi.fn(),
      __memmyInstallBrowserHistorySensor: vi.fn(), __memmyBrowserHistorySensor: { stop: vi.fn() } });
    vm.runInContext(fs.readFileSync(path.join(extension, "history-content.js"), "utf8"), sandbox);
    expect(request).toHaveBeenCalledWith({ type: "memmy_history_config", ancestorOrigins: ["https://bank.test", "https://work.test"] });
    expect(domRead).not.toHaveBeenCalled();
  });

  it("stops rechecking while the worker reports History idle and resumes when woken", async () => {
    vi.useFakeTimers();
    let reply: any = { enabled: false, idle: true }, listener: any;
    const request = vi.fn(() => Promise.resolve(reply));
    const chrome = { runtime: { id: "extension-id", sendMessage: request,
      onMessage: { addListener: (value: any) => { listener = value; } } } };
    const sandbox = vm.createContext({ chrome, Date, setTimeout, clearTimeout, addEventListener: vi.fn(),
      __memmyInstallBrowserHistorySensor: vi.fn(), __memmyBrowserHistorySensor: { stop: vi.fn() } });
    vm.runInContext(fs.readFileSync(path.join(extension, "history-content.js"), "utf8"), sandbox);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    reply = { enabled: false };
    listener({ type: "memmy_history_refresh" }, { id: "extension-id" }, vi.fn());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("tells frames to wait while History is off or their tab is in the background", async () => {
    const test = harness();
    expect(await test.configure()).toEqual({ enabled: false, idle: true });
    test.permit();
    expect(await test.configure(sender({ tab: { id: 8, active: false, windowId: 1 } }))).toEqual({ enabled: false, idle: true });
  });
});
