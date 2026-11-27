import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extensions", "memmy-browser");

function observerCommandResult(method: string, params: Record<string, unknown>, target: Record<string, unknown>) {
  if (method === 'Page.getFrameTree') return { frameTree: { frame: {
    id: target.sessionId ? 'child-frame' : 'main-frame',
  } } };
  if (method === 'Page.createIsolatedWorld') return { executionContextId: target.sessionId ? 22 : 11 };
  if (method === 'Runtime.evaluate' && params.contextId !== undefined
    && String(params.expression).includes('__memmyInputObserverReady')) return { result: { value: true } };
  return {};
}

// These unit fixtures call run() directly, after a successful debugger attachment.
// Attachment and observer readiness failures are exercised through the real lifecycle elsewhere.
function markObserverReady(context: vm.Context) {
  vm.runInContext(`{
    const claim = claims.get(7);
    claim.attached = true;
    claim.inputObserverToken ||= 'fixture-observer-token';
    claim.inputObservers = new Map(['', ...(claim.cdpSessions?.keys() || [])]
      .map(sessionId => [sessionId, {...newInputObserver(), ready: true}]));
  }`, context);
}

function discoveryHarness(options: { browser?: "chrome" | "edge"; boot?: boolean; attach?: (tabId: number) => Promise<void>;
  command?: (method: string, params: Record<string, unknown>, target: Record<string, unknown>) => Promise<unknown>;
  targets?: Array<{ tabId: number; attached: boolean }> } = {}) {
  const tabs = new Map<number, Record<string, unknown>>([
    [7, { id: 7, title: "百度", url: "https://www.baidu.com/", active: true, windowId: 1 }],
  ]);
  const sent: Array<Record<string, unknown>> = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  const updates: Array<[number, Record<string, unknown>]> = [];
  const created: Array<Record<string, unknown>> = [];
  const saved: Record<string, unknown> = {};
  let detached: (source: { tabId: number }, reason: string) => void = () => undefined;
  let message: (value: any, sender: any, respond: (result: any) => void) => unknown = () => undefined;
  let debuggerEvent: (source: { tabId: number; sessionId?: string }, method: string, data: Record<string, unknown>) => void = () => undefined;
  let tabCreated: (tab: Record<string, unknown>) => void = () => undefined;
  const chrome: any = {
    runtime: { id: "extension-id", onMessage: { addListener(listener: typeof message) { message = listener; } } },
    storage: { session: { get: async () => saved, set: async (value: Record<string, unknown>) => Object.assign(saved, value) } },
    tabs: { get: async (id: number) => { if (!tabs.has(id)) throw Error("Tab closed"); return tabs.get(id); },
      update: async (id: number, properties: Record<string, unknown>) => { updates.push([id, properties]); },
      create: async (properties: Record<string, unknown>) => {
        created.push(properties);
        const tab = { id: 20 + created.length, title: "", url: properties.url, windowId: properties.windowId ?? 1,
          ...(properties.openerTabId === undefined ? {} : { openerTabId: properties.openerTabId }) };
        tabs.set(tab.id, tab);
        return tab;
      },
      onCreated: { addListener(listener: typeof tabCreated) { tabCreated = listener; } },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
    windows: { get: async () => ({ focused: false }) },
    action: { setBadgeText: async () => undefined },
    debugger: { attach: async ({ tabId }: { tabId: number }) => { attaches.push(tabId); await options.attach?.(tabId); },
      detach: async ({ tabId }: { tabId: number }) => { detaches.push(tabId); },
      sendCommand: async (target: Record<string, unknown>, method: string, params: Record<string, unknown>) => {
        const result = await options.command?.(method, params, target);
        return result && Object.keys(result).length ? result : observerCommandResult(method, params, target);
      },
      onDetach: { addListener(listener: typeof detached) { detached = listener; } },
      onEvent: { addListener(listener: typeof debuggerEvent) { debuggerEvent = listener; } },
      ...(options.targets ? { getTargets: async () => options.targets } : {}) },
  };
  class MockSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    listeners = new Map<string, (event?: unknown) => void>();
    constructor() { queueMicrotask(() => { this.readyState = 1; this.listeners.get("open")?.(); }); }
    addEventListener(name: string, listener: (event?: unknown) => void) { this.listeners.set(name, listener); }
    send(value: string) {
      const message = JSON.parse(value); sent.push(message);
      if (message.type === "hello") queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "ready" }) }));
    }
    close() { this.readyState = 3; this.listeners.get("close")?.(); }
  }
  if (options.boot) chrome.tabs.query = async () => [...tabs.values()];
  // Every API is in memory; the optional startup path includes the actual handshake.
  const context = vm.createContext({ chrome, WebSocket: options.boot ? MockSocket : class { static OPEN = 1; },
    navigator: { userAgent: options.browser === "edge" ? "Edg/154" : "Chrome/154" },
    URL, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
  chrome.tabs.query = async () => [...tabs.values()];
  if (!options.boot) {
    (context as any).mockSocket = { readyState: 1, send: (value: string) => sent.push(JSON.parse(value)) };
    vm.runInContext("connect = async () => undefined; socket = mockSocket", context);
  }
  let commandCount = 0;
  return { context, tabs, sent, attaches, detaches, updates, created, saved,
    detach: (tabId: number, reason: string) => detached({ tabId }, reason),
    debuggerEvent: (tabId: number, method: string, data: Record<string, unknown>, sessionId?: string) =>
      debuggerEvent({ tabId, ...(sessionId ? { sessionId } : {}) }, method, data),
    createTab: (tab: Record<string, unknown>) => tabCreated(tab),
    message: (value: any) => new Promise<any>(resolve => message(value, { id: "extension-id" }, resolve)),
    command: async (name: string, args: Record<string, unknown> = {}) => {
      const id = `command-${++commandCount}`;
      (context as any).pendingCommand = { type: "command", id, tabId: 7, command: name, args };
      await vm.runInContext("handleCommand(pendingCommand)", context);
      return sent.filter(item => item.type === "response" && item.id === id).at(-1);
    },
  };
}

function reconnectHarness(options: { alarms?: Map<string, Record<string, unknown>>; storage?: Record<string, unknown>;
  connectDelay?: number; onSave?: () => void; alarmFailures?: number; reloadFailures?: number;
  historyImportFailure?: boolean; browser?: "chrome" | "edge";
  historyInitializeFailure?: boolean; storageReadFailure?: boolean; heartbeatSupported?: boolean;
  sendCommand?: (target: unknown, method: string) => Promise<unknown> } = {}) {
  let memmyRunning = false;
  let connectDelay = options.connectDelay ?? 0;
  let readyDelay = 0;
  let installedVersion = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8")).version;
  let onAlarm: (alarm: { name: string }) => void = () => undefined;
  let onStartup = () => undefined, onInstalled = () => undefined;
  const focusListeners: Array<() => void> = [];
  let alarmFailures = options.alarmFailures ?? 0, reloadFailures = options.reloadFailures ?? 0;
  let respondToPing = true;
  const alarms = options.alarms ?? new Map<string, Record<string, unknown>>();
  const saved = options.storage ?? {};
  const sent: Array<Record<string, unknown>> = [];
  const sockets: BridgeSocket[] = [];
  class BridgeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    listeners = new Map<string, (event?: unknown) => void>();
    constructor(readonly url: string) {
      sockets.push(this);
      setTimeout(() => {
        if (this.readyState === 3) return;
        if (!memmyRunning) { this.listeners.get("error")?.(); this.close(); return; }
        this.readyState = 1; this.listeners.get("open")?.();
      }, connectDelay);
    }
    addEventListener(name: string, listener: (event?: unknown) => void) { this.listeners.set(name, listener); }
    send(value: string) {
      const message = JSON.parse(value); sent.push(message);
      if (message.type === "hello") {
        const acknowledge = () => {
          if (this.readyState === 1) this.listeners.get("message")?.({ data: JSON.stringify({ type: "ready", heartbeat: options.heartbeatSupported !== false }) });
        };
        if (readyDelay) setTimeout(acknowledge, readyDelay);
        else queueMicrotask(acknowledge);
      } else if (message.type === "ping" && respondToPing) {
        queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "pong" }) }));
      }
    }
    close(code = 1000) { this.readyState = 3; this.listeners.get("close")?.({ code }); }
  }
  const events = { addListener() {} };
  const reload = vi.fn(() => { if (reloadFailures-- > 0) throw new Error("Simulated reload failure"); });
  const createAlarm = vi.fn(async (name: string, value: Record<string, unknown>) => {
    if (alarmFailures-- > 0) throw new Error("Simulated alarm API failure");
    alarms.set(name, value);
  });
  const save = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(saved, value); options.onSave?.();
  });
  const chrome = {
    runtime: { id: "extension-id", onMessage: events, reload, getURL: (file: string) => `chrome-extension://id/${file}`,
      onStartup: { addListener(listener: typeof onStartup) { onStartup = listener; } },
      onInstalled: { addListener(listener: typeof onInstalled) { onInstalled = listener; } } },
    storage: { local: { get: async () => {
      if (options.storageReadFailure) throw new Error("Simulated storage read failure");
      return saved;
    }, set: save } },
    alarms: { get: async (name: string) => alarms.get(name), create: createAlarm,
      onAlarm: { addListener(listener: typeof onAlarm) { onAlarm = listener; } } },
    webNavigation: { onCommitted: events, onCreatedNavigationTarget: events },
    tabs: { query: async () => [], onRemoved: events, onUpdated: events, onActivated: events, onCreated: events,
      get: async () => ({ id: 7, active: false, windowId: 1, url: "https://example.test/page" }) },
    windows: { onRemoved: events, onFocusChanged: { addListener(listener: () => void) { focusListeners.push(listener); } }, get: async () => ({ focused: false }) },
    debugger: { onDetach: events, onEvent: events, attach: async () => undefined, detach: async () => undefined,
      sendCommand: options.sendCommand ?? (async () => ({})) },
  };
  const fetch = async (url: string, init: { cache: string }) => {
    expect(url).toBe("chrome-extension://id/manifest.json");
    expect(init.cache).toBe("no-store");
    return { json: async () => ({ version: installedVersion }) };
  };
  const context = vm.createContext({ chrome, fetch, WebSocket: BridgeSocket,
    navigator: { userAgent: options.browser === "edge" ? "Edg/154" : "Chrome/154" },
    URL, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    importScripts: (file: string) => {
      if (options.historyImportFailure && file === "browser-history-background.js") throw new Error("Simulated History script failure");
      vm.runInContext(fs.readFileSync(path.join(extension, file), "utf8"), context);
      if (options.historyInitializeFailure && file === "browser-history-background.js") vm.runInContext("installMemmyBrowserHistoryBackground = () => { throw new Error('Simulated History init failure'); }", context);
    } });
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
  return { context, alarms, saved, save, reload, createAlarm, sockets, sent,
    fireAlarm: (name = "memmy-reconnect") => onAlarm({ name }),
    fireStartup: () => onStartup(), fireInstalled: () => onInstalled(),
    fireFocus: () => focusListeners.forEach(listener => listener()),
    setAlarmFailures: (count: number) => { alarmFailures = count; },
    setHeartbeat: (enabled: boolean) => { respondToPing = enabled; },
    setBridge: (running: boolean, connectionDelay = 0, handshakeDelay = 0) => {
      memmyRunning = running; connectDelay = connectionDelay; readyDelay = handshakeDelay;
    },
    setInstalledVersion: (version: string) => { installedVersion = version; },
  };
}

describe("external browser connection recovery", () => {
  it.each(["chrome", "edge"] as const)("wakes %s on profile startup and repairs a missing alarm", async browser => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ browser });
      await vi.advanceTimersByTimeAsync(60_000);
      test.alarms.clear();
      test.setBridge(true);
      test.fireStartup();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.alarms.get("memmy-reconnect")).toEqual({ periodInMinutes: 0.5 });
      expect(test.sent).toContainEqual(expect.objectContaining({ type: "hello", browser }));
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("repairs an abnormal alarm on installation without resetting a healthy alarm", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ alarms: new Map([["memmy-reconnect", { periodInMinutes: 5 }]]) });
      await vi.advanceTimersByTimeAsync(0);
      expect(test.alarms.get("memmy-reconnect")).toEqual({ periodInMinutes: 0.5 });
      test.createAlarm.mockClear();
      test.fireInstalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.createAlarm).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("retries failed alarm setup within a bound and retries again on a later lifecycle event", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ alarmFailures: 100 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(test.createAlarm.mock.calls.length).toBeGreaterThan(1);
      expect(test.createAlarm.mock.calls.length).toBeLessThanOrEqual(4);
      test.setAlarmFailures(0); test.setBridge(true); test.fireFocus();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.alarms.has("memmy-reconnect")).toBe(true);
      test.fireAlarm(); await vi.advanceTimersByTimeAsync(0);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(["historyImportFailure", "historyInitializeFailure"] as const)("keeps execution recovery available after %s", async failure => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ [failure]: true });
      test.setBridge(true); await vi.advanceTimersByTimeAsync(0);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
      expect(test.alarms.has("memmy-reconnect")).toBe(true);
      expect(vm.runInContext("browserHistory", test.context)).toBeNull();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("accepts a bounded slow ready handshake and recovers a half-open socket", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness(); test.setBridge(true, 0, 1_200);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
      expect(test.sockets).toHaveLength(1);
      test.setHeartbeat(false); const original = test.sockets[0];
      await vi.advanceTimersByTimeAsync(85_000);
      expect(original.readyState).toBe(3);
      test.setHeartbeat(true); await vi.advanceTimersByTimeAsync(6_000);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
      expect(JSON.stringify(test.saved.memmyConnectionDiagnostics)).toContain('"failure":"heartbeat_timeout"');
      expect(JSON.stringify(test.saved.memmyConnectionDiagnostics)).toContain('"closeCode":4000');
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("probes a healthy connection after sleep before deciding to reconnect", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness(); test.setBridge(true); await vi.advanceTimersByTimeAsync(0);
      const original = test.sockets[0];
      vi.setSystemTime(Date.now() + 120_000); test.fireAlarm();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(test.sockets).toHaveLength(1);
      expect(original.readyState).toBe(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps older gateways that do not advertise heartbeat support connected", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ heartbeatSupported: false }); test.setBridge(true); test.setHeartbeat(false);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(test.sockets).toHaveLength(1);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("persists bounded metadata diagnostics in batches and discards stored content fields", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ storage: { memmyConnectionDiagnostics: { version: 1, events: [
        { stage: "failed", at: 1, extensionVersion: "1.0.11", url: "https://private.test", title: "secret", error: "personal path", failure: "socket_error" },
        { stage: "secret page text", at: 2, extensionVersion: "1.0.11" },
      ] } } });
      test.setBridge(true); await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 40; index++) test.fireStartup();
      await vi.advanceTimersByTimeAsync(10_000);
      const diagnostics = test.saved.memmyConnectionDiagnostics as { version: number; events: Array<Record<string, unknown>> };
      expect(diagnostics.version).toBe(1);
      expect(diagnostics.events.length).toBeLessThanOrEqual(24);
      for (const event of diagnostics.events) {
        expect(Object.keys(event).every(key => ["stage", "at", "extensionVersion", "port", "failure", "closeCode"].includes(key))).toBe(true);
      }
      expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret|personal/);
      const writes = test.save.mock.calls.length;
      for (let index = 0; index < 40; index++) test.fireStartup();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(test.save.mock.calls.length).toBe(writes);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(test.save.mock.calls.length).toBe(writes + 1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("does not make connection recovery depend on diagnostic storage availability", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ storageReadFailure: true }); test.setBridge(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
      expect(test.alarms.has("memmy-reconnect")).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("leaves an automatic reload retryable after runtime.reload throws", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ reloadFailures: 1 }); await vi.advanceTimersByTimeAsync(0);
      test.setInstalledVersion("99.0.0"); test.fireAlarm(); await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
      expect(test.saved.reloadedForVersion).not.toBe("99.0.0");
      test.fireAlarm(); await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledTimes(2);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("bounds failed quick retries and accepts a browser-delayed connection when Memmy returns", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(test.sockets).toHaveLength(15); // Startup plus four retries, across three ports.
      expect(test.sent).toEqual([]);
      expect(test.alarms.get("memmy-reconnect")).toEqual({ periodInMinutes: 0.5 });
      test.setBridge(true, 3_000);
      test.fireAlarm("unrelated");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.sockets).toHaveLength(15);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(test.sent).toContainEqual(expect.objectContaining({ type: "hello", browser: "chrome" }));
      expect(test.sockets).toHaveLength(16);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("preserves an existing alarm through worker restart and replaces a missing alarm", async () => {
    vi.useFakeTimers();
    try {
      const first = reconnectHarness();
      await vi.advanceTimersByTimeAsync(0);
      expect(first.createAlarm).toHaveBeenCalledOnce();
      // Worker suspension discards its ordinary timers but leaves browser-owned alarms.
      vi.clearAllTimers();
      const resumed = reconnectHarness({ alarms: first.alarms });
      resumed.setBridge(true);
      resumed.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(resumed.createAlarm).not.toHaveBeenCalled();
      expect(resumed.sockets).toHaveLength(1);
      expect(vm.runInContext("sessionLive", resumed.context)).toBe(true);
      vi.clearAllTimers();
      const lost = reconnectHarness();
      await vi.advanceTimersByTimeAsync(0);
      expect(lost.createAlarm).toHaveBeenCalledOnce();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("restarts short retries after a recovered connection closes", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness();
      await vi.advanceTimersByTimeAsync(60_000);
      test.setBridge(true);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(vm.runInContext("sessionLive", test.context)).toBe(true);
      const connected = test.sockets.at(-1)!;
      test.setBridge(false);
      connected.close();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(test.sockets).toHaveLength(16);
      await vi.advanceTimersByTimeAsync(1);
      expect(test.sockets).toHaveLength(17);
      await vi.advanceTimersByTimeAsync(3);
      expect(test.sockets).toHaveLength(19);
      expect(vm.runInContext("sessionLive", test.context)).toBe(false);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps the handshake timeout separate and ignores a late open from an abandoned socket", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness({ connectDelay: 3_000 });
      test.setBridge(true, 3_000, 6_000);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(test.sockets).toHaveLength(2);
      expect(vm.runInContext("sessionLive", test.context)).toBe(false);
      const abandoned = test.sockets[0];
      abandoned.readyState = 1;
      abandoned.listeners.get("open")?.();
      expect(test.sent.filter(value => value.type === "hello")).toHaveLength(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("defers an updated copy during a running command and reloads once after it finishes", async () => {
    vi.useFakeTimers();
    try {
      const test = reconnectHarness();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).not.toHaveBeenCalled();
      test.setInstalledVersion("99.0.0");
      vm.runInContext("runningCommands.add('active-command')", test.context);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.saved).toEqual({});
      vm.runInContext("runningCommands.clear()", test.context);
      test.fireAlarm();
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
      expect(test.saved).toEqual({ reloadedForVersion: "99.0.0" });
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
      vi.clearAllTimers();
      const restarted = reconnectHarness({ storage: test.saved });
      restarted.setInstalledVersion("99.0.0");
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted.reload).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("leaves a reload retryable when a command starts during the storage write", async () => {
    vi.useFakeTimers();
    try {
      let startCommand = false;
      const test = reconnectHarness({ onSave: () => {
        if (startCommand) vm.runInContext("runningCommands.add('new-command')", test.context);
      } });
      await vi.advanceTimersByTimeAsync(0);
      test.setInstalledVersion("99.0.0");
      startCommand = true;
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.saved.reloadedForVersion).not.toBe("99.0.0");
      startCommand = false;
      vm.runInContext("runningCommands.clear()", test.context);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(["cdpCall", "cdpWrite"] as const)("waits for the browser to settle after a %s command has timed out", async command => {
    vi.useFakeTimers();
    let release!: () => void;
    try {
      const pending = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const test = reconnectHarness({ sendCommand: async (_target, method) => {
        if (method === "Runtime.evaluate") { entered(); await pending; }
        return {};
      } });
      test.setBridge(true);
      await vi.advanceTimersByTimeAsync(0);
      vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0})", test.context);
      markObserverReady(test.context);
      (test.context as Record<string, unknown>).testCommand = command;
      const operation = vm.runInContext("handleCommand({ tabId: 7, id: 'timed-out-command', command: testCommand, args: {approvedOrigin: 'https://example.test', method: 'Runtime.evaluate', params: {expression: 'document.title'}, timeoutMs: 10} })", test.context) as Promise<unknown>;
      await started;
      await vi.advanceTimersByTimeAsync(10);
      await operation;
      expect(vm.runInContext("runningCommands.size", test.context)).toBe(0);
      expect(test.sent).toContainEqual(expect.objectContaining({ type: "response", id: "timed-out-command", ok: false,
        error: "Browser CDP command timed out" }));
      const depth = command === "cdpCall" ? "cdpReadDepth" : "cdpWriteDepth";
      expect(vm.runInContext(`claims.get(7).${depth}`, test.context)).toBe(1);
      test.setInstalledVersion("99.0.0");
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.saved.reloadedForVersion).toBeUndefined();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(vm.runInContext(`claims.get(7).${depth}`, test.context)).toBe(0);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
    } finally { release?.(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("defers reload when protected browser activity starts during the version-marker write", async () => {
    vi.useFakeTimers();
    try {
      let startActivity = false;
      const test = reconnectHarness({ onSave: () => {
        if (startActivity) vm.runInContext("claims.set(7, {protectedActivity: 1})", test.context);
      } });
      test.setBridge(true);
      await vi.advanceTimersByTimeAsync(0);
      test.setInstalledVersion("99.0.0");
      startActivity = true;
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.saved.reloadedForVersion).not.toBe("99.0.0");
      startActivity = false;
      vm.runInContext("claims.get(7).protectedActivity = 0", test.context);
      test.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(test.reload).toHaveBeenCalledOnce();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

describe("external browser page discovery", () => {
  it.each(["chrome", "edge"] as const)("publishes existing pages after the %s startup handshake without attaching the debugger", async browser => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness({ browser, boot: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(test.sent).toContainEqual({ type: "hello", browser, extensionVersion: "1.2.2", capabilities: ["openTab", "playwright", "browserHistory"] });
      expect(test.attaches).toEqual([]);
      expect(test.sent).toContainEqual(expect.objectContaining({ type: "claim", browser, tabId: 7 }));
      expect((await test.message({ action: "status" })).controllableTabCount).toBe(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(["chrome", "edge"] as const)("offers an existing ordinary page in %s before any debugger attachment", async browser => {
    const test = discoveryHarness({ browser });
    await vm.runInContext("discoverOpenTabs()", test.context);
    expect(test.attaches).toEqual([]);
    expect(test.sent).toContainEqual(expect.objectContaining({ type: "claim", browser,
      tabId: 7, title: "百度", url: "https://www.baidu.com/" }));
    expect(await test.message({ action: "status" })).toMatchObject({ connected: true,
      controllableTabCount: 1, tabStatuses: [expect.objectContaining({ status: "ready" })] });
  });

  it("attaches the debugger only for Memmy commands and releases it after they go idle", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness();
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(await test.command("tabState")).toMatchObject({ ok: true });
      expect(test.attaches).toEqual([]);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(test.attaches).toEqual([7]);
      await vi.advanceTimersByTimeAsync(44_000);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(44_000);
      expect(test.detaches).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(test.detaches).toEqual([7]);
      expect((await test.message({ action: "status" })).controllableTabCount).toBe(1);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(test.attaches).toEqual([7, 7]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("installs the input observer in the current page and child frames", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown>; target: Record<string, unknown> }> = [];
    let unsupportedRunImmediately = true;
    const test = discoveryHarness({ command: async (method, params, target) => {
      calls.push({ method, params, target });
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && target.sessionId === undefined
        && params.runImmediately === true && unsupportedRunImmediately) {
        unsupportedRunImmediately = false;
        throw Error('Unknown parameter runImmediately');
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: {
        id: target.sessionId ? 'child-frame' : 'main-frame',
      } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: target.sessionId ? 22 : 11 };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return observerCommandResult(method, params, target);
    } });
    await vm.runInContext('discoverOpenTabs()', test.context);
    expect(await test.command('snapshot')).toMatchObject({ ok: true });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'Runtime.addBinding',
      params: expect.objectContaining({ executionContextName: 'memmy-user-input' }) }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'Page.addScriptToEvaluateOnNewDocument',
      params: expect.objectContaining({ worldName: 'memmy-user-input' }) }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'Page.createIsolatedWorld',
      params: expect.objectContaining({ frameId: 'main-frame' }) }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'Runtime.evaluate',
      params: expect.objectContaining({ contextId: 11,
        expression: expect.stringContaining('pointerdown') }) }));
    test.debuggerEvent(7, 'Target.attachedToTarget', {
      sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child-target',
        url: 'https://www.baidu.com/frame' },
    });
    await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: 'Runtime.evaluate', target: { tabId: 7, sessionId: 'child-session' },
      params: expect.objectContaining({ contextId: 22 }),
    })));
    const token = vm.runInContext('claims.get(7).inputObserverToken', test.context);
    test.debuggerEvent(7, 'Target.detachedFromTarget', { sessionId: 'child-session' });
    test.debuggerEvent(7, 'Runtime.bindingCalled', {
      name: '__memmyUserInput', payload: JSON.stringify([token, 'keydown', Date.now()]),
    }, 'child-session');
    expect(vm.runInContext('claims.get(7).lastUserInputAt', test.context)).toBe(0);
  });

  it("reports an attachment failure on that command and attaches again for the next one", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const test = discoveryHarness({ attach: async () => { if (++attempt === 1) throw Error("Cannot attach to this target."); } });
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(await test.command("snapshot")).toMatchObject({ ok: false, error: expect.stringMatching(/不允许/) });
      expect((await test.message({ action: "status" })).controllableTabCount).toBe(1);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(test.attaches).toEqual([7, 7]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("resumes a debugger session this extension already holds", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness({ attach: async tabId => {
        throw Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      } });
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(test.detaches).toEqual([]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("serializes concurrent commands onto one debugger attachment", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const test = discoveryHarness({ attach: async () => wait });
      await vm.runInContext("discoverOpenTabs()", test.context);
      const first = test.command("snapshot");
      const second = test.command("snapshot");
      await Promise.resolve(); await Promise.resolve();
      release();
      expect(await Promise.all([first, second])).toMatchObject([{ ok: true }, { ok: true }]);
      expect(test.attaches).toEqual([7]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("stops a page when the user closes the debugging bar and offers it again on a later request", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness();
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      test.detach(7, "canceled_by_user");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.sent).toContainEqual({ type: "unclaim", tabId: 7 });
      const paused = await test.message({ action: "status" });
      expect(paused).toMatchObject({ controllableTabCount: 0, pausedTabCount: 1 });
      expect(paused.tabStatuses[0]).toMatchObject({ status: "user_detached", reason: expect.stringMatching(/重新连接/) });
      expect(await test.command("snapshot")).toMatchObject({ ok: false, error: expect.stringMatching(/停止操作/) });
      expect(test.saved.detachedBrowserTabs).toBeUndefined();
      await vm.runInContext("discoverOpenTabs(true)", test.context);
      expect((await test.message({ action: "status" })).pausedTabCount).toBe(1);
      vm.runInContext("pausedTabs.set(7, Date.now() - USER_CANCEL_COOLDOWN_MS)", test.context);
      await vm.runInContext("discoverOpenTabs(true)", test.context);
      expect(await test.message({ action: "status" })).toMatchObject({ controllableTabCount: 1, pausedTabCount: 0 });
      expect(await test.command("snapshot")).toMatchObject({ ok: true });
      expect(test.attaches).toEqual([7, 7]);
      test.detach(7, "canceled_by_user");
      await vi.advanceTimersByTimeAsync(0);
      await test.message({ action: "refresh" });
      expect(await test.message({ action: "status" })).toMatchObject({ controllableTabCount: 1, pausedTabCount: 0 });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("tells an in-flight command that the user stopped the page", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness({ command: async (method, params, target) => {
        if (method !== "Accessibility.getFullAXTree") return observerCommandResult(method, params, target);
        test.detach(7, "canceled_by_user");
        throw Error("Detached while handling command.");
      } });
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(await test.command("snapshot")).toMatchObject({ ok: false, error: expect.stringMatching(/停止操作/) });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("reports which tab opened a page and selects a tab without the debugger or raising the window", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness();
      test.tabs.set(8, { id: 8, title: "上海博物馆", url: "https://www.shanghaimuseum.net/", openerTabId: 7, windowId: 1 });
      await vm.runInContext("discoverOpenTabs()", test.context);
      expect(test.sent).toContainEqual(expect.objectContaining({ type: "claim", tabId: 8, openerTabId: 7 }));
      expect(test.sent.find(item => item.type === "claim" && item.tabId === 7)).not.toHaveProperty("openerTabId");
      expect(await test.command("activate")).toMatchObject({ ok: true });
      expect(test.updates).toEqual([[7, { active: true }]]);
      expect(test.attaches).toEqual([]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("opens an Agent tab in the background beside its source page and offers it before replying", async () => {
    const test = discoveryHarness();
    test.tabs.get(7)!.index = 2;
    await vm.runInContext("discoverOpenTabs()", test.context);
    expect(await vm.runInContext("openTab('https://www.taobao.com/', 7)", test.context)).toMatchObject({ tabId: 21 });
    expect(test.created).toEqual([{ url: "https://www.taobao.com/", active: false, windowId: 1, openerTabId: 7, index: 3 }]);
    expect(test.sent).toContainEqual(expect.objectContaining({ type: "claim", tabId: 21,
      url: "https://www.taobao.com/", openerTabId: 7 }));
    expect(test.attaches).toEqual([]);
    expect(test.updates).toEqual([]);
    await expect(vm.runInContext("openTab('chrome://settings/', 7)", test.context)).rejects.toThrow(/HTTP/);
    expect(await vm.runInContext("openTab('https://www.jd.com/')", test.context)).toMatchObject({ tabId: 22 });
    expect(test.created[1]).toEqual({ url: "https://www.jd.com/", active: false });
  });

  it("names the background tab whose link opened a page instead of Chrome's active-tab opener", async () => {
    const test = discoveryHarness();
    await vm.runInContext("discoverOpenTabs()", test.context);
    test.debuggerEvent(7, "Page.windowOpen", { url: "https://www.baidu.com/link?url=museum" });
    test.tabs.set(9, { id: 9, title: "邮箱", url: "https://mail.example/", windowId: 1 });
    test.createTab({ id: 9, pendingUrl: "https://mail.example/", url: "" });
    test.tabs.set(8, { id: 8, title: "上海博物馆", url: "https://www.shanghaimuseum.net/", openerTabId: 3, windowId: 1 });
    test.createTab({ id: 8, url: "" });
    await vm.runInContext("discoverTab(8)", test.context);
    await vm.runInContext("discoverTab(9)", test.context);
    expect(test.sent.filter(item => item.type === "claim" && item.tabId === 8).at(-1)).toMatchObject({ openerTabId: 7 });
    expect(test.sent.filter(item => item.type === "claim" && item.tabId === 9).at(-1)).not.toHaveProperty("openerTabId");
  });

  it("ignores pages detached by an earlier extension version", async () => {
    const test = discoveryHarness();
    test.saved.detachedBrowserTabs = [7];
    await vm.runInContext("discoverOpenTabs()", test.context);
    expect((await test.message({ action: "status" })).controllableTabCount).toBe(1);
  });

  it("releases a debugger session left by a previous worker on startup", async () => {
    vi.useFakeTimers();
    try {
      const test = discoveryHarness({ boot: true, targets: [{ tabId: 7, attached: true }, { tabId: 8, attached: false }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(test.detaches).toEqual([7]);
      expect(test.attaches).toEqual([]);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps a reconnect alarm so a stopped worker reconnects after Memmy restarts", async () => {
    vi.useFakeTimers();
    try {
      let memmyRunning = false;
      // Chrome's WebSocket throttle holds an attempt before connecting after earlier failures.
      let throttleMs = 0;
      let attempts = 0;
      let onAlarm: (alarm: { name: string }) => void = () => undefined;
      const alarms = new Map<string, Record<string, unknown>>();
      const hellos: Array<Record<string, unknown>> = [];
      class BridgeSocket {
        static OPEN = 1; static CONNECTING = 0;
        readyState = 0;
        listeners = new Map<string, (event?: unknown) => void>();
        constructor() {
          attempts++;
          setTimeout(() => {
            if (this.readyState === 3) return;
            if (!memmyRunning) { this.readyState = 3; this.listeners.get("error")?.(); return; }
            this.readyState = 1; this.listeners.get("open")?.();
          }, throttleMs);
        }
        addEventListener(name: string, listener: (event?: unknown) => void) { this.listeners.set(name, listener); }
        send(value: string) {
          const message = JSON.parse(value);
          if (message.type !== "hello") return;
          hellos.push(message);
          queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "ready" }) }));
        }
        close() { this.readyState = 3; }
      }
      const events = { addListener() {} };
      const chrome = {
        runtime: { id: "extension-id", onMessage: events },
        alarms: {
          get: async (name: string) => alarms.get(name),
          create: async (name: string, info: Record<string, unknown>) => { alarms.set(name, info); },
          onAlarm: { addListener(listener: typeof onAlarm) { onAlarm = listener; } },
        },
        tabs: { query: async () => [], onCreated: events, onRemoved: events, onUpdated: events, onActivated: events },
        windows: { onRemoved: events },
        debugger: { onDetach: events, onEvent: events },
      };
      const context = vm.createContext({ chrome, WebSocket: BridgeSocket, navigator: { userAgent: "Chrome/155" },
        URL, setTimeout, clearTimeout, setInterval, clearInterval });
      vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
      await vi.advanceTimersByTimeAsync(0);
      expect(alarms.get("memmy-reconnect")).toEqual({ periodInMinutes: 0.5 });

      // Startup plus four quick retries, each over the three bridge ports; then only the alarm retries.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attempts).toBe(15);
      expect(hellos).toEqual([]);

      memmyRunning = true;
      throttleMs = 3_000;
      onAlarm({ name: "memmy-reconnect" });
      await vi.advanceTimersByTimeAsync(throttleMs);
      expect(hellos).toEqual([expect.objectContaining({ type: "hello", browser: "chrome" })]);
      expect(attempts).toBe(16);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("reloads once when Memmy has installed a newer copy than the running worker", async () => {
    const run = async (installedVersion: string, stored: Record<string, unknown>) => {
      const reload = vi.fn();
      const events = { addListener() {} };
      const chrome = {
        runtime: { id: "extension-id", onMessage: events, reload, getURL: (file: string) => `chrome-extension://id/${file}` },
        storage: { local: { get: async () => stored, set: async (value: Record<string, unknown>) => { Object.assign(stored, value); } } },
        tabs: { query: async () => [], onCreated: events, onRemoved: events, onUpdated: events, onActivated: events },
        windows: { onRemoved: events },
        debugger: { onDetach: events, onEvent: events },
      };
      const fetch = async (url: string) => {
        expect(url).toBe("chrome-extension://id/manifest.json");
        return { json: async () => ({ version: installedVersion }) };
      };
      const context = vm.createContext({ chrome, fetch, WebSocket: class { addEventListener() {} close() {} },
        navigator: { userAgent: "Chrome/155" }, URL, setTimeout, clearTimeout, setInterval, clearInterval });
      vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
      await vi.advanceTimersByTimeAsync(0);
      vi.clearAllTimers();
      return reload.mock.calls.length;
    };
    vi.useFakeTimers();
    try {
      const running = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8")).version;
      expect(await run(running, {})).toBe(0);
      const stored: Record<string, unknown> = {};
      expect(await run("99.0.0", stored)).toBe(1);
      expect(stored).toEqual({ reloadedForVersion: "99.0.0" });
      expect(await run("99.0.0", stored)).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps private and credential-protected page metadata out of discovery status", async () => {
    const test = discoveryHarness();
    test.tabs.set(8, { id: 8, incognito: true, title: "private title", url: "https://private.test/?secret=private" });
    test.tabs.set(9, { id: 9, title: "password title", url: "https://login.test/?password=secret", windowId: 1 });
    test.saved.protectedCredentialTabs = [9];
    test.saved.protectedCredentialOrigins = { 9: "https://login.test" };
    await vm.runInContext("discoverOpenTabs()", test.context);
    expect(test.attaches).toEqual([]);
    expect(JSON.stringify(test.sent)).not.toMatch(/private title|private\.test|password title|password=secret/);
    expect(test.sent).toContainEqual(expect.objectContaining({ type: "tab_status", tabId: 8, status: "unsupported", url: "" }));
    expect(test.sent).toContainEqual(expect.objectContaining({ type: "tab_status", tabId: 9, status: "protected", url: "" }));
  });
});

describe("Chrome and Edge extension packaging", () => {
  it("includes the unpacked MV3 extension in every desktop package variant", () => {
    for (const configName of [
      "electron-builder.yml", "electron-builder.unsigned.yml",
      "electron-builder.win.yml", "electron-builder.win.unsigned.yml",
    ]) {
      const config = YAML.parse(fs.readFileSync(path.join(root, configName), "utf8"));
      expect(config.extraResources).toContainEqual({
        from: "extensions/memmy-browser", to: "browser-extension", filter: ["**/*"],
      });
    }
    for (const file of ["manifest.json", "background.js", "popup.html", "popup.js", "auth.html", "auth.js",
      "teaching-recorder.js", "teaching-page.js", "browser-history-background.js", "history-content.js", "history-sensor.js"]) {
      expect(fs.existsSync(path.join(extension, file))).toBe(true);
    }
  });

  it("uses a deterministic browser ID and limits extension privileges", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe("1.2.2");
    const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64"))
      .digest().subarray(0, 16)].flatMap(value => [value >> 4, value & 15])
      .map(value => String.fromCharCode(97 + value)).join("");
    expect(id).toBe("mhodbgbbgalbhehapffidmdegokpoaom");
    expect(fs.readFileSync(path.join(extension, "background.js"), "utf8"))
      .toContain(`const EXTENSION_VERSION = "${manifest.version}";`);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://*/*", "https://*/*"]);
    expect(manifest.permissions).toContain("alarms");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.permissions).toContain("webNavigation");
    expect(manifest.content_scripts).toContainEqual({matches: ["http://*/*", "https://*/*"], js: ["teaching-page.js"], run_at: "document_start", all_frames: false});
    expect(manifest.permissions).not.toContain("history");
    expect(manifest.permissions).not.toContain("cookies");
  });

  it("allows a focused idle tab, but pauses writes after physical page input", async () => {
    let onEvent: ((source: { tabId: number }, method: string, data: unknown) => void) | undefined;
    let delayedAgentInput: string | undefined;
    const sendCommand = async (_target: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        const token = vm.runInContext('claims.get(7).inputObserverToken', context);
        delayedAgentInput = JSON.stringify([token, 'pointerdown', Number(params.timestamp) * 1000]);
        // Deliver this notification after the command reply, as slow VMs can.

      }
      return { nodes: [] };
    };
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener(callback: typeof onEvent) { onEvent = callback; } }, sendCommand },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: true, windowId: 1, url: "https://example.test/" }) },
      windows: { get: async () => ({ focused: true }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: "Chrome" }, URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
    vm.runInContext("claims.set(7, newClaim(7, 'https://example.test')); claims.get(7).attached = true", context);
    markObserverReady(context);
    await expect(vm.runInContext("run(7, 'click', {x: 10, y: 10})", context))
      .resolves.toMatchObject({ x: 10, y: 10 });
    // A delayed CDP-generated trusted DOM event is excluded from physical takeover.
    expect(vm.runInContext("claims.get(7).lastUserInputAt", context)).toBe(0);
    onEvent?.({ tabId: 7 }, 'Runtime.bindingCalled', {
      name: '__memmyUserInput', payload: delayedAgentInput,
    });
    expect(vm.runInContext("claims.get(7).lastUserInputAt", context)).toBe(0);
    const token = vm.runInContext('claims.get(7).inputObserverToken', context);
    const physical = JSON.stringify([token, 'keydown', Date.now()]);
    onEvent?.({ tabId: 8 }, 'Runtime.bindingCalled', { name: '__memmyUserInput', payload: physical });
    expect(vm.runInContext("claims.get(7).lastUserInputAt", context)).toBe(0);
    onEvent?.({ tabId: 7 }, 'Runtime.bindingCalled', { name: '__memmyUserInput', payload: physical });
    await expect(vm.runInContext("run(7, 'click', {x: 10, y: 10})", context))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    await expect(vm.runInContext("run(7, 'cdpWrite', {approvedOrigin: 'https://example.test', method: 'Runtime.evaluate', params: {expression: 'document.title = \"changed\"'}}, 'write-1')", context))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    await expect(vm.runInContext("run(7, 'snapshot', {})", context))
      .resolves.toMatchObject({ nodes: [] });
    vm.runInContext("claims.get(7).lastUserInputAt = Date.now() - USER_ACTIVE_WINDOW_MS - 1", context);
    await expect(vm.runInContext("run(7, 'click', {x: 10, y: 10})", context))
      .resolves.toMatchObject({ x: 10, y: 10 });
    await new Promise(resolve => setTimeout(resolve, 60));
    onEvent?.({ tabId: 7 }, 'Runtime.bindingCalled', {
      name: '__memmyUserInput', payload: JSON.stringify([token, 'pointerdown', Date.now()]),
    });
    await expect(vm.runInContext("run(7, 'click', {x: 10, y: 10})", context))
      .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
    const lastPhysicalInput = vm.runInContext('claims.get(7).lastUserInputAt', context);
    vm.runInContext('markDebuggerDetached(claims.get(7)); claims.get(7).attached = true', context);
    markObserverReady(context);
    onEvent?.({ tabId: 7 }, 'Runtime.bindingCalled', { name: '__memmyUserInput', payload: physical });
    expect(vm.runInContext('claims.get(7).lastUserInputAt', context)).toBe(lastPhysicalInput);
    await expect(vm.runInContext('assertUserIsNotUsingTab(7)', context))
      .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
  });

  it("stops slow typing when the user starts typing between characters", async () => {
    let onEvent: ((source: { tabId: number }, method: string, data: unknown) => void) | undefined;
    const inserted: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} },
        onEvent: { addListener(callback: typeof onEvent) { onEvent = callback; } },
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          if (method === 'DOM.resolveNode') return { object: { objectId: 'input-1' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: String(params.functionDeclaration).includes("return this.type") ? "text" : true } };
          if (method === 'Input.insertText') {
            inserted.push(String(params.text));
            if (inserted.length === 1) {
              const token = vm.runInContext('claims.get(7).inputObserverToken', context);
              onEvent?.({ tabId: 7 }, 'Runtime.bindingCalled', {
                name: '__memmyUserInput', payload: JSON.stringify([token, 'keydown', Date.now()]),
              });
            }
          }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' }, URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, newClaim(7, 'https://example.test')); claims.get(7).attached = true", context);
    markObserverReady(context);
    await expect(vm.runInContext("run(7, 'type', {x: 10, y: 10, target: 'ax-1', text: 'AB', slowly: true})", context))
      .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
    expect(inserted).toEqual(['A']);
  });

  it("observes trusted page input without collecting text or treating modifiers as takeover", () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const reported: string[] = [];
    const wallNow = Date.now();
    const timeOrigin = wallNow - 10_000; // The page predates a VM clock correction.
    const context = vm.createContext({
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener),
      __memmyUserInput: (payload: string) => reported.push(payload),
      Date: { now: () => wallNow }, performance: { timeOrigin, now: () => 105 },
    });
    const extensionContext = vm.createContext({ chrome: {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    }, WebSocket: class {}, navigator: { userAgent: 'Chrome' }, URL });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), extensionContext);
    vm.runInContext(vm.runInContext('inputObserverSource("claim-1")', extensionContext), context);
    listeners.get('keydown')?.({ type: 'keydown', key: 'Shift', isTrusted: true, timeStamp: 101 });
    listeners.get('keydown')?.({ type: 'keydown', key: 'A', isTrusted: false, timeStamp: 102 });
    listeners.get('pointerdown')?.({ type: 'pointerdown', isTrusted: true, timeStamp: 103 });
    listeners.get('wheel')?.({ type: 'wheel', isTrusted: true, timeStamp: 104 });
    expect(reported.map(JSON.parse)).toEqual([
      ['claim-1', 'pointerdown', wallNow - 2],
      ['claim-1', 'wheel', wallNow - 1],
    ]);
  });

  it("captures viewport and element screenshots at CSS or device resolution", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") return { result: { value: 2 } };
          if (method === "Page.getLayoutMetrics") return {
            cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 600 },
          };
          if (method === "DOM.resolveNode") return { object: { objectId: "element-1" } };
          if (method === "Runtime.callFunctionOn") return {
            result: { value: { x: 10, y: 20, width: 72, height: 21 } },
          };
          if (method === "Page.captureScreenshot") { captures.push(params); return { data: "png" }; }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: "Chrome" }, URL });
    vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
    await vm.runInContext("screenshot(7, {})", context);
    await vm.runInContext("screenshot(7, {target: 'ax-3', scale: 'device'})", context);
    expect(captures).toMatchObject([
      { clip: { width: 900, height: 600, scale: 0.5 } },
      { clip: { x: 10, y: 20, width: 72, height: 21, scale: 1 } },
    ]);
  });

  it('sets files only on the approved claimed tab and live file input', async () => {
    const methods: string[] = [];
    let currentUrl = 'https://example.test/form';
    let fileInput = true;
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => {
          methods.push(method);
          if (method === 'DOM.resolveNode') return { object: { objectId: 'file-input' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: fileInput } };
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: currentUrl }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, newClaim(7, 'https://example.test'))", context);
    markObserverReady(context);
    const args = { target: 'ax-3', paths: ['/tmp/approved.txt'], approvedOrigin: 'https://example.test' };
    (context as Record<string, unknown>).args = args;
    await expect(vm.runInContext('run(7, "upload", args, "operation-1")', context)).resolves.toEqual({ uploaded: 1 });
    expect(methods).toContain('DOM.setFileInputFiles');
    methods.length = 0;
    currentUrl = 'https://other.test/form';
    await expect(vm.runInContext('run(7, "upload", args, "operation-2")', context)).rejects.toThrow(/site changed/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    currentUrl = 'https://example.test/form';
    fileInput = false;
    await expect(vm.runInContext('run(7, "upload", args, "operation-3")', context)).rejects.toThrow(/not a file input/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    fileInput = true;
    vm.runInContext("cancelledCommands.add('operation-4')", context);
    await expect(vm.runInContext('run(7, "upload", args, "operation-4")', context)).rejects.toThrow(/cancelled/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    vm.runInContext('claims.delete(7)', context);
    await expect(vm.runInContext('run(7, "upload", args, "operation-5")', context)).rejects.toThrow(/not connected/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
  });

  it('keeps CDP reads on the approved claim and drops prior-origin events', async () => {
    let currentUrl = 'https://example.test/page';
    let changeDuringRead = false;
    let roundTripDuringRead = false;
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          methods.push(method);
          if (method === 'Runtime.evaluate') {
            expect(params).toMatchObject({ expression: 'document.title', throwOnSideEffect: true,
              returnByValue: true, awaitPromise: false, userGesture: false });
            if (changeDuringRead) currentUrl = 'https://other.test/page';
            if (roundTripDuringRead) {
              vm.runInContext("resetCdpOrigin(claims.get(7), 'https://other.test'); resetCdpOrigin(claims.get(7), 'https://example.test')", context);
            }
            return { result: { value: 'Old title' } };
          }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, url: currentUrl }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, { origin: 'https://example.test', allowedOrigins: new Set(['https://example.test', 'https://other.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpSessions: new Map(), cdpWaiters: new Set() })", context);
    markObserverReady(context);
    const call = { approvedOrigin: 'https://example.test', method: 'Runtime.evaluate',
      params: { expression: 'document.title' } };
    (context as Record<string, unknown>).args = call;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-1')", context))
      .resolves.toMatchObject({ result: { value: 'Old title' } });
    methods.length = 0;
    call.method = 'DOM.setFileInputFiles';
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-2')", context))
      .rejects.toThrow(/unavailable/);
    expect(methods).toEqual([]);
    call.method = 'Runtime.evaluate';
    changeDuringRead = true;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-3')", context))
      .rejects.toThrow(/site changed/);
    currentUrl = 'https://example.test/page';
    changeDuringRead = false;
    roundTripDuringRead = true;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-4')", context))
      .rejects.toThrow(/claim changed/);
    roundTripDuringRead = false;
    vm.runInContext("resetCdpOrigin(claims.get(7), 'https://example.test'); claims.get(7).cdpEvents.push({sequence: 1, method: 'Runtime.consoleAPICalled', params: {type: 'old'}})", context);
    currentUrl = 'https://other.test/page';
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://other.test', afterSequence: 0 };
    await expect(vm.runInContext("run(7, 'cdpEvents', args, 'events-1')", context))
      .resolves.toMatchObject({ events: [] });
  });

  it('executes only claimed, idle CDP writes with approved destination origins', async () => {
    let currentUrl = 'https://example.test/page';
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => { methods.push(method); return {}; } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: currentUrl }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), console: [], requests: [], cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set()})", context);
    markObserverReady(context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-2')", context)).resolves.toEqual({});
    expect(methods).toContain('Runtime.evaluate');
    methods.length = 0;
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.navigate', params: { url: 'https://other.test/' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-3')", context)).rejects.toThrow(/unavailable/);
    expect(methods).toEqual([]);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Network.setCookie', params: { name: 'sample', value: '1', url: 'https://other.test/' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-4')", context))
      .rejects.toThrow(/destination site/);
    expect(methods).toEqual([]);
    vm.runInContext("claims.get(7).allowedOrigins.add('https://other.test')", context);
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-5')", context)).resolves.toEqual({});
    expect(methods).toContain('Network.setCookie');
    methods.length = 0;
    currentUrl = 'https://different.test/page';
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-6')", context)).rejects.toThrow(/site changed/);
    expect(methods).toEqual([]);
  });

  it('binds child CDP commands and waiting events to the claimed tab attachment', async () => {
    let onEvent: (source: { tabId: number; sessionId?: string }, method: string,
      data: Record<string, unknown>) => void = () => undefined;
    let childUrl = 'https://example.test/frame';
    const sent: Array<{ target: { tabId: number; sessionId?: string }; method: string }> = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener(listener: typeof onEvent) { onEvent = listener; } },
        sendCommand: async (target: { tabId: number; sessionId?: string }, method: string, params: Record<string, unknown>) => {
          sent.push({ target, method });
          if (method === 'Target.getTargetInfo') {
            expect(target).toEqual({ tabId: 7, sessionId: 'session-1' }); expect(params).toEqual({});
            return { targetInfo: { type: 'iframe', targetId: 'child-1', url: childUrl } };
          }
          return observerCommandResult(method, params, target);
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), console: [], requests: [], cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set()})", context);
    markObserverReady(context);
    onEvent({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'session-1',
      targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://example.test/frame' } });
    // This fixture exercises child identity after input-observer attachment.
    await vi.waitFor(() => expect(vm.runInContext(
      "claims.get(7).inputObservers.get('session-1').ready", context)).toBe(true));
    let approvedTarget = await vm.runInContext("run(7, 'cdpTarget', {approvedOrigin: 'https://example.test', target: {targetId: 'child-1'}}, 'probe-1')", context);
    expect(approvedTarget).toMatchObject({ sessionId: 'session-1', targetId: 'child-1',
      url: childUrl, origin: 'https://example.test', revision: 0 });
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 2 },
      target: { targetId: 'child-1' }, approvedTarget };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'child-1')", context)).resolves.toEqual({});
    expect(sent.find(item => item.method === 'Input.dispatchMouseEvent')?.target)
      .toEqual({ tabId: 7, sessionId: 'session-1' });
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      afterSequence: 0, target: { sessionId: 'session-1' }, timeoutMs: 100, approvedTarget };
    const pending = vm.runInContext("run(7, 'cdpEvents', args, 'events-1')", context) as Promise<unknown>;
    onEvent({ tabId: 7, sessionId: 'session-1' }, 'Runtime.consoleAPICalled', { type: 'log' });
    await expect(pending).resolves.toMatchObject({ events: [{ source: {
      tabId: 7, sessionId: 'session-1', targetId: 'child-1',
    } }] });
    childUrl = 'https://silent-navigation.test/frame';
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.getLayoutMetrics', params: {}, target: { sessionId: 'session-1' }, approvedTarget };
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-silent-race')", context))
      .rejects.toThrow(/changed after approval/);
    expect(sent.some(item => item.method === 'Page.getLayoutMetrics')).toBe(false);
    childUrl = 'https://example.test/frame';
    onEvent({ tabId: 7 }, 'Target.targetInfoChanged', {
      targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://other.test/frame' },
    });
    childUrl = 'https://other.test/frame';
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.getLayoutMetrics', params: {}, target: { sessionId: 'session-1' }, approvedTarget };
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-2')", context))
      .rejects.toThrow(/changed after approval/);
    expect(sent.some(item => item.method === 'Page.getLayoutMetrics')).toBe(false);
    approvedTarget = await vm.runInContext("run(7, 'cdpTarget', {approvedOrigin: 'https://example.test', target: {sessionId: 'session-1'}}, 'probe-2')", context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.getLayoutMetrics', params: {}, target: { sessionId: 'session-1' }, approvedTarget };
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-2-approved')", context))
      .resolves.toEqual({});
    expect(sent.find(item => item.method === 'Page.getLayoutMetrics')?.target)
      .toEqual({ tabId: 7, sessionId: 'session-1' });
    onEvent({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'session-1' });
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-3')", context))
      .rejects.toThrow(/not attached/);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      afterSequence: 0, target: { targetId: 'child-1' }, approvedTarget };
    await expect(vm.runInContext("run(7, 'cdpEvents', args, 'events-2')", context))
      .rejects.toThrow(/not attached/);
  });

  it('blocks raw CDP writes during protected autofill and vice versa', async () => {
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => { methods.push(method); return {}; } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 1, cdpWriteDepth: 0})", context);
    markObserverReady(context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-1')", context))
      .rejects.toThrow(/protected browser operation/);
    expect(methods).not.toContain('Runtime.evaluate');
    vm.runInContext('claims.get(7).protectedActivity = 0; claims.get(7).cdpWriteDepth = 1', context);
    await expect(vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'p'})", context))
      .rejects.toThrow(/during raw CDP/);
    expect(methods).not.toContain('Runtime.evaluate');
  });

  it('reports a CDP send timeout but retains the activity guard until debugger settles', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => {
          if (method === 'Runtime.evaluate') { entered(); await pending; }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 0, cdpWriteDepth: 0})", context);
    markObserverReady(context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' }, timeoutMs: 10 };
    const operation = vm.runInContext("run(7, 'cdpWrite', args, 'timeout-1')", context) as Promise<unknown>;
    try {
      await started;
      await expect(operation).rejects.toThrow(/timed out/);
      await expect(vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'p'})", context))
        .rejects.toThrow(/during raw CDP/);
    } finally { release(); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(vm.runInContext('claims.get(7).cdpWriteDepth', context)).toBe(0);
  });

  it('protects filled passwords across MV3 worker restart until a new document commits', async () => {
    const saved: Record<string, unknown> = {};
    const listeners: Array<(source: { tabId: number; sessionId?: string }, method: string,
      data: Record<string, unknown>) => void> = [];
    const sent: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: { session: {
        get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async (value: Record<string, unknown>) => { Object.assign(saved, value); },
      } },
      debugger: { attach: async () => undefined, detach: async () => undefined,
        onDetach: { addListener() {} }, onEvent: { addListener(listener: typeof listeners[number]) {
          listeners.push(listener);
        } },
        sendCommand: async (_target: unknown, method: string) => {
          sent.push(method);
          return method === 'Runtime.evaluate' ? { result: { value: 1 } } : {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }) },
      windows: { get: async () => ({ focused: false }) },
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    };
    const create = () => {
      const context = vm.createContext({ chrome, WebSocket: class { static OPEN = 1; },
        navigator: { userAgent: 'Chrome' },
        URL, setTimeout, clearTimeout });
      vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
      vm.runInContext('connect = async () => undefined', context);
      return context;
    };
    const first = create();
    await vm.runInContext('discoverTab(7)', first);
    markObserverReady(first);
    const waiting = vm.runInContext("run(7, 'cdpEvents', {approvedOrigin: 'https://example.test', afterSequence: 0, timeoutMs: 500}, 'events-waiting')", first) as Promise<unknown>;
    const waitingAssertion = expect(waiting).rejects.toThrow(/credential protection|autofill/);
    await new Promise(resolve => setTimeout(resolve, 0));
    await vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'fake-password'})", first);
    await waitingAssertion;
    expect(saved.protectedCredentialTabs).toEqual([7]);
    listeners[0]!({ tabId: 7 }, 'Network.requestWillBeSent', {
      request: { url: 'https://example.test/login?password=fake-password' },
    });
    (first as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.querySelector("input[type=password]").value' } };
    sent.length = 0;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'cdpEvents', {approvedOrigin: 'https://example.test', afterSequence: 0}, 'events-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'snapshot', {}, 'snapshot-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'click', {target: '7'}, 'click-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'tabState', {}, 'state-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'navigate', {url: 'https://other.test/'}, 'nav-1')", first))
      .rejects.toThrow(/credential protection/);
    expect(sent).not.toContain('Runtime.evaluate');
    const restarted = create();
    await vm.runInContext('discoverTab(7)', restarted);
    markObserverReady(restarted);
    (restarted as Record<string, unknown>).args = (first as Record<string, unknown>).args;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-2')", restarted))
      .rejects.toThrow(/credential protection/);
    listeners.at(-1)!({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.test/account' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved.protectedCredentialTabs).toEqual([7]);
    await vm.runInContext("run(7, 'navigate', {url: 'https://example.test/account'}, 'recover')", restarted);
    listeners.at(-1)!({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.test/account' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved.protectedCredentialTabs).toEqual([]);
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-3')", restarted))
      .resolves.toMatchObject({ result: { value: 1 } });
  });
});

it('keeps external browser auth values inside the extension and never returns them to Agent', async () => {
  const listeners: Array<(message: any, sender: any, respond: (value: any) => void) => void> = [];
  const sent: Array<{ method: string; expression?: string }> = [];
  const saved: Record<string, unknown> = {};
  const chrome = {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener(listener: typeof listeners[number]) { listeners.push(listener); } } },
    storage: { session: { get: async () => saved, set: async (value: Record<string, unknown>) => Object.assign(saved, value) } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async (_target: unknown, method: string, args: any) => {
        sent.push({ method, expression: args?.expression });
        return method === 'Runtime.evaluate'
          ? { result: { value: args.expression.includes('const controls=') ? [] : true } } : {};
      } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }),
      update: async (_tabId: number, value: { url: string }) => {
        const authId = new URL(value.url).searchParams.get('authId');
        const sender = { id: 'extension-id', tab: { windowId: 9 } };
        let details: any;
        listeners[0]!({ action: 'auth:get', authId }, sender, value => { details = value; });
        expect(details.request.origin).toBe('https://example.test');
        listeners[0]!({ action: 'auth:submit', authId, values: { password: 'fake-secret' } }, sender, () => undefined);
      } },
    windows: { onRemoved: { addListener() {} }, create: async () => ({ id: 9, tabs: [{ id: 90 }] }),
      remove: async () => undefined, get: async () => ({ focused: false }) },
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID: () => '11111111-1111-1111-1111-111111111111' },
    WebSocket: class { static OPEN = 1; }, navigator: { userAgent: 'Chrome' },
    URL, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpEvents: [], cdpWaiters: new Set(), cdpSessions: new Map(), console: [], requests: [], protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, documentEpoch: 0}); runningCommands.add('auth-1')", context);
  markObserverReady(context);
  (context as Record<string, unknown>).authInput = { origin: 'https://example.test',
    fields: [{ id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' }] };
  const result = await vm.runInContext("run(7, 'authRequest', authInput, 'auth-1')", context);
  expect(result).toEqual({ status: 'submitted' });
  expect(JSON.stringify(result)).not.toContain('fake-secret');
  expect(sent.filter(item => item.expression?.includes('fake-secret'))).toHaveLength(1);
  expect(saved.protectedCredentialTabs).toEqual([7]);
  await expect(vm.runInContext("run(7, 'snapshot', {}, 'snapshot-2')", context))
    .rejects.toThrow(/credential protection/);
});

it('validates a connected cross-origin child before external auth, including after user approval', async () => {
  const sent: Array<{ target: any; method: string; expression?: string }> = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async (target: any, method: string, args: any) => {
        sent.push({ target, method, expression: args?.expression });
        if (method === 'Runtime.evaluate' && args.expression.includes('const found=doc?.querySelectorAll'))
          return { result: { objectId: 'frame-node' } };
        if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'frame-1' } };
        if (method === 'Target.getTargetInfo') {
          expect(target).toEqual({ tabId: 7, sessionId: 'child-1' }); expect(args).toEqual({});
          return { targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://identity.test/login' } };
        }
        if (method === 'Runtime.evaluate' && args.expression.includes('timeOrigin:doc.defaultView.performance.timeOrigin'))
          return { result: { value: { url: 'https://identity.test/login', timeOrigin: 123 } } };
        if (method === 'Runtime.evaluate') return { result: { value:
          args.expression.includes('const controls=') ? [] : true } };
        return {};
      } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }) },
    windows: { get: async () => ({ focused: false }) },
  };
  const context = vm.createContext({ chrome, WebSocket: class { static OPEN = 1; },
    navigator: { userAgent: 'Chrome' }, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpEvents: [], cdpWaiters: new Set(), cdpSessions: new Map([['child-1', {targetId: 'frame-1', url: 'https://identity.test/login', revision: 0}]]), console: [], requests: [], protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, documentEpoch: 0}); runningCommands.add('auth-1')", context);
  markObserverReady(context);
  (context as Record<string, unknown>).authInput = { origin: 'https://example.test', frame: 'iframe#signin',
    fields: [{ id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' }] };
  vm.runInContext("collectAuth = async () => ({values: {password: 'fake-secret'}})", context);
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-1')", context))
    .toEqual({ status: 'submitted' });
  expect(sent.filter(item => item.expression?.includes('fake-secret')).map(item => item.target.sessionId))
    .toEqual(['child-1']);
  vm.runInContext("claims.get(7).credentialProtected = false; claims.get(7).cdpSessions.get('child-1').revision++; runningCommands.add('auth-2'); collectAuth = async () => { claims.get(7).cdpSessions.get('child-1').revision++; return {values: {password: 'late-secret'}}; }", context);
  sent.length = 0;
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-2')", context))
    .toEqual({ status: 'page_changed' });
  expect(sent.some(item => item.expression?.includes('late-secret'))).toBe(false);
  vm.runInContext("runningCommands.add('auth-3'); collectAuth = async () => { cancelledCommands.add('auth-3'); return {values: {password: 'cancelled-secret'}}; }", context);
  sent.length = 0;
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-3')", context))
    .toEqual({ status: 'page_changed' });
  expect(sent.some(item => item.expression?.includes('cancelled-secret'))).toBe(false);
});

it.each([true, false])('fills external required auth inputs (already known = %s) and preserves an unspecified optional value', async known => {
  class Input {
    isConnected = true; disabled = false; type = 'text';
    constructor(private currentValue: string) {}
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = value; }
    getClientRects() { return [{}]; }
    dispatchEvent() {}
  }
  const code = new Input('old code'), optional = new Input('keep this optional value');
  const document = { URL: 'https://example.test/login', defaultView: {
    HTMLInputElement: Input, Event: class { constructor(_name: string, _options: unknown) {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
  }, querySelectorAll: (selector: string) => selector === '#code' ? [code] : selector === '#optional' ? [optional] : [] };
  const collect = vi.fn(async (metadata: { fields: Array<{ id: string }> }) => {
    expect(metadata.fields.map(field => field.id)).toEqual(['code']);
    return { values: { code: 'collected-code' } };
  });
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async (_target: unknown, method: string, args: any) => method === 'Runtime.evaluate'
        ? { result: { value: vm.runInNewContext(args.expression, { document }) } } : {} },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => ({ id: 7, active: false, windowId: 1, url: document.URL }) },
    windows: { get: async () => ({ focused: false }) },
  };
  const context = vm.createContext({ chrome, collect, WebSocket: class { static OPEN = 1; },
    navigator: { userAgent: 'Chrome' }, URL, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  vm.runInContext("connect = async () => undefined; collectAuth = collect; claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpEvents: [], cdpWaiters: new Set(), cdpSessions: new Map(), console: [], requests: [], protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, documentEpoch: 0}); runningCommands.add('auth-optional')", context);
  markObserverReady(context);
  (context as Record<string, unknown>).authInput = { origin: 'https://example.test', fields: [
    { id: 'code', label: 'Code', type: 'text', required: true, selector: '#code' },
    { id: 'optional', label: 'Optional value', type: 'text', required: false, selector: '#optional' },
  ], provided_values: known ? { code: 'provided-code-246810' } : {} };
  const result = await vm.runInContext("run(7, 'authRequest', authInput, 'auth-optional')", context);
  expect(result).toEqual({ status: 'submitted' });
  expect(collect).toHaveBeenCalledTimes(known ? 0 : 1);
  expect(code.value).toBe(known ? 'provided-code-246810' : 'collected-code');
  expect(optional.value).toBe('keep this optional value');
  expect(JSON.stringify(result)).not.toContain(code.value);
});


it('rechecks the playwrightStart boundary after a delayed tab read and cancel', async () => {
  const methods: string[] = [];
  const test = discoveryHarness({ command: async method => { methods.push(method); return {}; } });
  const origin = 'https://example.test';
  vm.runInContext(`assertUserIsNotUsingTab = async () => undefined;
    claims.set(7, { origin: '${origin}', documentEpoch: 0, cdpSessions: new Map() });`, test.context);
  let resolveTab!: (value: unknown) => void, reads = 0;
  const tab = { id: 7, incognito: false, url: origin + '/', active: false, windowId: 1 };
  (test.context as any).chrome.tabs.get = async () => ++reads === 1 ? await new Promise(resolve => { resolveTab = resolve; }) : tab;
  (test.context as any).controlArgs = { approvedOrigin: origin, leaseId: 'a'.repeat(32), input: true, fresh: false };
  const pending = vm.runInContext("playwrightControl(7, 'playwrightStart', controlArgs, 'cancel-race')", test.context) as Promise<unknown>;
  const checked = expect(pending).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect(reads).toBe(1));
  vm.runInContext("cancelledCommands.add('cancel-race')", test.context);
  resolveTab(tab);
  await checked;
  expect(methods).toEqual([]);
});

it.each(['cancel', 'navigate', 'site', 'expire', 'user-active'])('refuses executor CDP for a %s lease at dispatch without reading browser state', async change => {
  const methods: string[] = [];
  const test = discoveryHarness({ command: async method => { methods.push(method); return {}; } });
  const origin = 'https://example.test';
  const tabReads = vi.fn(async () => ({ id: 7, incognito: false, url: origin + '/', active: false, windowId: 1 }));
  (test.context as any).chrome.tabs.get = tabReads;
  vm.runInContext(`claims.set(7, { origin: '${origin}', documentEpoch: 0, cdpSessions: new Map(),
      playwrightLease: {id: '${'a'.repeat(32)}', origin: '${origin}', input: true, expiresAt: Date.now()+45000, documentEpoch: 0} });`, test.context);
  vm.runInContext(change === 'navigate' ? 'claims.get(7).documentEpoch++'
    : change === 'site' ? "claims.get(7).origin = 'https://other.test'"
      : change === 'expire' ? 'claims.get(7).playwrightLease.expiresAt = 0'
        : change === 'user-active' ? 'claims.get(7).userActiveOnTab = true' : "cancelledCommands.add('cancel-race')", test.context);
  (test.context as any).controlArgs = { approvedOrigin: origin, leaseId: 'a'.repeat(32),
    method: 'Input.insertText', params: { text: 'never-sent' } };
  await expect(vm.runInContext("playwrightControl(7, 'playwrightCdp', controlArgs, 'cancel-race')", test.context))
    .rejects.toThrow(/cancelled|document changed|lease expired|USER_ACTIVE_ON_TARGET_TAB/);
  expect(methods).toEqual([]);
  expect(tabReads).not.toHaveBeenCalled();
});

it('delivers an executor reply before the events Chrome emits after it', async () => {
  // Real browser API reads complete in a later task. A reply delayed by one
  // would let the next CDP event overtake it, which Playwright cannot recover.
  const test = discoveryHarness();
  const origin = 'https://example.test', leaseId = 'a'.repeat(32);
  const tab = { id: 7, incognito: false, url: origin + '/', active: false, windowId: 1 };
  (test.context as any).chrome.tabs.get = () => new Promise(resolve => setTimeout(() => resolve(tab), 0));
  (test.context as any).chrome.windows.get = () => new Promise(resolve => setTimeout(() => resolve({ focused: false }), 0));
  let reply!: (value: unknown) => void;
  (test.context as any).chrome.debugger.sendCommand = () => new Promise(resolve => { reply = resolve; });
  vm.runInContext(`claims.set(7, newClaim(7, '${origin}')); claims.get(7).attached = true;
    claims.get(7).playwrightLease = {id:'${leaseId}', origin:'${origin}', input:false, documentEpoch:0, expiresAt:Date.now()+45000};`, test.context);
  try {
    (test.context as any).pendingCommand = { type: 'command', id: 'ordered-reply', tabId: 7, command: 'playwrightCdp',
      args: { leaseId, approvedOrigin: origin, method: 'Page.getFrameTree', params: {} } };
    const handled = vm.runInContext('handleCommand(pendingCommand)', test.context) as Promise<unknown>;
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
    reply({ frameTree: { frame: { id: 'main', url: origin + '/' } } });
    setTimeout(() => test.debuggerEvent(7, 'Runtime.executionContextCreated',
      { context: { id: 1, origin, auxData: { frameId: 'main', isDefault: true } } }), 0);
    await handled;
    await vi.waitFor(() => expect(test.sent.some(message => message.type === 'playwright_event')).toBe(true));
    const order = test.sent.filter(message => message.type === 'playwright_event' || message.id === 'ordered-reply')
      .map(message => message.type);
    expect(order).toEqual(['response', 'playwright_event']);
  } finally { await vm.runInContext('unclaim(7, false)', test.context); }
});


it.each(['cancel', 'replacement'])('does not install a late Start lease after user-activity wait and %s', async change => {
  const methods: string[] = [];
  const test = discoveryHarness({ command: async method => { methods.push(method); return {}; } });
  let resume!: () => void, entered = false;
  (test.context as any).userActivityWait = async () => { entered = true; await new Promise<void>(done => { resume = done; }); };
  (test.context as any).chrome.tabs.get = async () => ({ id: 7, incognito: false, url: 'https://example.test/', active: false });
  vm.runInContext(`assertUserIsNotUsingTab = userActivityWait;
    claims.set(7, {origin: 'https://example.test', documentEpoch: 0, cdpSessions: new Map()});`, test.context);
  const pending = vm.runInContext(`playwrightControl(7, 'playwrightStart', {
    leaseId: '${'a'.repeat(32)}', approvedOrigin: 'https://example.test', input: true, fresh: false }, 'late-start')`, test.context) as Promise<unknown>;
  const checked = expect(pending).rejects.toThrow(/cancelled|already busy/);
  await vi.waitFor(() => expect(entered).toBe(true));
  vm.runInContext(change === 'cancel' ? "cancelledCommands.add('late-start')"
    : `claims.get(7).playwrightLease = {id:'${'b'.repeat(32)}', expiresAt: Date.now()+45000}`, test.context);
  resume(); await checked;
  expect(methods).toEqual([]);
  expect(vm.runInContext('claims.get(7).playwrightLease?.id', test.context)).toBe(change === 'cancel' ? undefined : 'b'.repeat(32));
});

it.each(['target-id', 'target-type', 'url', 'revision', 'detached'])('rejects changed external child metadata (%s) on its own registered session', async change => {
  const test = discoveryHarness();
  try {
    await vm.runInContext('discoverTab(7)', test.context);
    const info = { type: 'iframe', targetId: 'child-target', url: 'https://frame.test/form' };
    test.debuggerEvent(7, 'Target.attachedToTarget', { sessionId: 'bound-child', targetInfo: info });
    const sendCommand = vi.fn(async (target: { tabId: number; sessionId?: string }, method: string, params: any) => {
      expect(target).toEqual({ tabId: 7, sessionId: 'bound-child' }); expect(method).toBe('Target.getTargetInfo'); expect(params).toEqual({});
      if (change === 'revision') test.debuggerEvent(7, 'Target.targetInfoChanged', { targetInfo: info });
      if (change === 'detached') test.debuggerEvent(7, 'Target.detachedFromTarget', { sessionId: 'bound-child' });
      return { targetInfo: { ...info, ...(change === 'target-id' ? { targetId: 'foreign-target' }
        : change === 'target-type' ? { type: 'page' } : change === 'url' ? { url: 'chrome://settings/' } : {}) } };
    });
    (test.context as any).chrome.debugger.sendCommand = sendCommand;
    await expect(vm.runInContext("resolveCdpTarget(7, claims.get(7), {sessionId:'bound-child'})", test.context)).rejects.toThrow();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    sendCommand.mockClear();
    await expect(vm.runInContext("resolveCdpTarget(7, claims.get(7), {sessionId:'unregistered-child'})", test.context)).rejects.toThrow(/not attached/);
    expect(sendCommand).not.toHaveBeenCalled();
  } finally { await vm.runInContext('unclaim(7, false)', test.context); }
});

it.each([['detach', 'before'], ['navigate', 'during'], ['detach', 'during']])('rejects a child command after the child %s %s dispatch', async (change, when) => {
  const test = discoveryHarness();
  const origin = 'https://example.test', leaseId = 'a'.repeat(32);
  const methods: string[] = [];
  let finish!: (value: unknown) => void;
  (test.context as any).chrome.debugger.sendCommand = (target: any, method: string) => {
    methods.push(method);
    expect(target).toEqual({ tabId: 7, sessionId: 'child-session' });
    return new Promise(resolve => { finish = resolve; });
  };
  vm.runInContext(`claims.set(7, newClaim(7, '${origin}'));
    claims.get(7).playwrightLease = {id:'${leaseId}', origin:'${origin}', input:false,
      documentEpoch:0, expiresAt:Date.now()+45000};`, test.context);
  test.debuggerEvent(7, 'Target.attachedToTarget', { sessionId: 'child-session',
    targetInfo: { type: 'iframe', targetId: 'child-target', url: 'https://frame.test/form' } });
  const change_ = () => change === 'navigate' ? test.debuggerEvent(7, 'Page.frameNavigated', {
    frame: { id: 'child-target', parentId: 'main', url: 'https://frame.test/form' },
  }, 'child-session') : test.debuggerEvent(7, 'Target.detachedFromTarget', { sessionId: 'child-session' });
  try {
    if (when === 'before') change_();
    const pending = vm.runInContext(`playwrightControl(7, 'playwrightCdp', {
      leaseId:'${leaseId}', approvedOrigin:'${origin}', sessionId:'child-session',
      method:'Runtime.evaluate', params:{expression:'1'} }, 'child-boundary')`, test.context) as Promise<unknown>;
    const checked = expect(pending).rejects.toThrow(/frame changed/);
    if (when === 'during') { expect(methods).toEqual(['Runtime.evaluate']); change_(); finish({ result: { value: 1 } }); }
    await checked;
    expect(methods).toEqual(when === 'before' ? [] : ['Runtime.evaluate']);
  } finally { finish?.({}); await vm.runInContext('unclaim(7, false)', test.context); }
});

it('sends a child command to a registered child that navigated before dispatch', async () => {
  const test = discoveryHarness();
  const origin = 'https://example.test', leaseId = 'a'.repeat(32);
  const methods: string[] = [];
  (test.context as any).chrome.debugger.sendCommand = async (_target: any, method: string) => { methods.push(method); return { result: { value: 1 } }; };
  vm.runInContext(`claims.set(7, newClaim(7, '${origin}'));
    claims.get(7).playwrightLease = {id:'${leaseId}', origin:'${origin}', input:false,
      documentEpoch:0, expiresAt:Date.now()+45000};`, test.context);
  test.debuggerEvent(7, 'Target.attachedToTarget', { sessionId: 'child-session',
    targetInfo: { type: 'iframe', targetId: 'child-target', url: 'https://frame.test/form' } });
  test.debuggerEvent(7, 'Page.frameNavigated', { frame: { id: 'child-target', parentId: 'main', url: 'https://frame.test/next' } }, 'child-session');
  try {
    await expect(vm.runInContext(`playwrightControl(7, 'playwrightCdp', {
      leaseId:'${leaseId}', approvedOrigin:'${origin}', sessionId:'child-session',
      method:'Runtime.evaluate', params:{expression:'1'} }, 'child-current')`, test.context)).resolves.toEqual({ result: { value: 1 } });
    expect(methods).toEqual(['Runtime.evaluate']);
  } finally { await vm.runInContext('unclaim(7, false)', test.context); }
});

it('keeps an idle focused executor running and stops its lease synchronously on real input', async () => {
  const calls: string[] = [];
  const test = discoveryHarness({ command: async method => { calls.push(method); return {}; } });
  const origin = 'https://example.test';
  const leaseId = 'a'.repeat(32);
  (test.context as any).chrome.tabs.get = async () => ({ id: 7, incognito: false, url: origin + '/', active: true, windowId: 1 });
  (test.context as any).chrome.windows.get = async () => ({ focused: true });
  vm.runInContext(`claims.set(7, newClaim(7, '${origin}'));
    Object.assign(claims.get(7), {attached:true, inputObserverToken:'lease-input',
      playwrightLease: {id:'${leaseId}', origin:'${origin}', input:true, documentEpoch:0, expiresAt:Date.now()+45000}});`, test.context);
  markObserverReady(test.context);
  const write = () => vm.runInContext(`playwrightControl(7, 'playwrightCdp', {
    leaseId:'${leaseId}', approvedOrigin:'${origin}', method:'Input.insertText', params:{text:'A'} }, 'input-check')`, test.context);
  try {
    vm.runInContext('refreshUserActivity()', test.context);
    await expect(write()).resolves.toEqual({});
    test.debuggerEvent(7, 'Runtime.bindingCalled', { name: '__memmyUserInput',
      payload: JSON.stringify(['lease-input', 'keydown', Date.now()]) });
    // No asynchronous focus query can allow another character through here.
    expect(vm.runInContext('claims.get(7).userActiveOnTab', test.context)).toBe(true);
    await expect(write()).rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
    vm.runInContext('claims.get(7).lastUserInputAt = Date.now() - USER_ACTIVE_WINDOW_MS - 1; refreshUserActivity()', test.context);
    await expect(write()).rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
    expect(calls).toEqual(['Input.insertText']);
    expect(test.sent.filter(message => message.type === 'playwright_event')).toHaveLength(0);
  } finally { await vm.runInContext('unclaim(7, false)', test.context); }
});

it.each([
  { label: 'main document reload', method: 'Page.frameNavigated', params: { frame: { id: 'main', url: 'https://example.test/form' } }, main: true },
  { label: 'same-process iframe reload', method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'main', url: 'https://example.test/frame' } } },
  { label: 'OOPIF reload', method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'main', url: 'https://example.test/frame' } }, sessionId: 'child-session' },
  { label: 'iframe attachment', method: 'Page.frameAttached', params: { frameId: 'child', parentFrameId: 'main' } },
  { label: 'iframe removal', method: 'Page.frameDetached', params: { frameId: 'child', reason: 'remove' } },
])('reports idle $label in the next frame generation without streaming old events', async event => {
  const origin = 'https://example.test';
  const test = discoveryHarness({ command: async method => method === 'Target.getTargetInfo'
    ? { targetInfo: { targetId: 'main', type: 'page', url: origin + '/form' } }
    : method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', url: origin + '/form' } } } : {} });
  test.tabs.get(7)!.url = origin + '/form';
  try {
    await vm.runInContext('discoverTab(7)', test.context);
    test.debuggerEvent(7, 'Target.attachedToTarget', { sessionId: 'child-session',
      targetInfo: { targetId: 'child', type: 'iframe', url: origin + '/frame' } });
    const firstId = 'a'.repeat(32), secondId = 'b'.repeat(32);
    const first = await test.command('playwrightStart', { leaseId: firstId, approvedOrigin: origin, input: false, fresh: false });
    expect(first).toMatchObject({ ok: true, result: { frameEpoch: 0 } });
    await test.command('playwrightEnd', { leaseId: firstId });
    const streamed = test.sent.filter(message => message.type === 'playwright_event').length;
    test.debuggerEvent(7, event.method, event.params, 'sessionId' in event ? event.sessionId : undefined);
    expect(test.sent.filter(message => message.type === 'playwright_event')).toHaveLength(streamed);
    const second = await test.command('playwrightStart', { leaseId: secondId, approvedOrigin: origin, input: false, fresh: false });
    expect(second).toMatchObject({ ok: true, result: { frameEpoch: 1,
      documentEpoch: 'main' in event && event.main ? 1 : 0, cdpEpoch: 0 } });
    expect(second?.result.frameTree).toEqual(first?.result.frameTree);
    expect(second?.result.childTargets).toEqual(first?.result.childTargets);
    if (!('main' in event)) {
      test.debuggerEvent(7, event.method, event.params, 'sessionId' in event ? event.sessionId : undefined);
      expect(await test.command('playwrightCdp', { leaseId: secondId, approvedOrigin: origin,
        method: 'Page.getLayoutMetrics', params: {} })).toMatchObject({ ok: true });
    }
  } finally { await vm.runInContext('unclaim(7, false)', test.context); }
});


it.each([0, 20])('does not reuse an Agent event exemption for a physical click %sms later', async delta => {
  let timestamp = 0;
  const test = discoveryHarness({ command: async (method, params) => {
    if (method === 'Input.dispatchMouseEvent') timestamp = Number(params.timestamp) * 1000;
    return {};
  } });
  vm.runInContext(`claims.set(7,newClaim(7,'https://example.test'));
    Object.assign(claims.get(7), {attached:true,inputObserverToken:'one-shot'});`, test.context);
  markObserverReady(test.context);
  await vm.runInContext("command(7,'Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1})", test.context);
  const input = (at: number) => test.debuggerEvent(7, 'Runtime.bindingCalled', {
    name: '__memmyUserInput', payload: JSON.stringify(['one-shot', 'pointerdown', at]),
  });
  input(timestamp);
  expect(vm.runInContext('claims.get(7).lastUserInputAt', test.context)).toBe(0);
  input(timestamp + delta);
  await expect(vm.runInContext('assertUserIsNotUsingTab(7)', test.context))
    .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
});

it('does not treat a nearby physical click as Agent input before its delayed notification', async () => {
  let timestamp = 0;
  const test = discoveryHarness({ command: async (method, params) => {
    if (method === 'Input.dispatchMouseEvent') timestamp = Number(params.timestamp) * 1000;
    return {};
  } });
  vm.runInContext(`claims.set(7,newClaim(7,'https://example.test'));
    Object.assign(claims.get(7), {attached:true,inputObserverToken:'delayed'});`, test.context);
  markObserverReady(test.context);
  await vm.runInContext("command(7,'Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1})", test.context);
  test.debuggerEvent(7, 'Runtime.bindingCalled', { name: '__memmyUserInput',
    payload: JSON.stringify(['delayed', 'pointerdown', timestamp + 20]) });
  await expect(vm.runInContext('assertUserIsNotUsingTab(7)', test.context))
    .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
});

it('blocks writes while a cross-origin iframe observer is still installing', async () => {
  let finishInstall: () => void = () => undefined;
  const installed = new Promise<void>(resolve => { finishInstall = resolve; });
  const commands: string[] = [];
  const test = discoveryHarness({ command: async (method, _params, target) => {
    commands.push(method);
    if (target.sessionId === 'oop-child' && method === 'Page.addScriptToEvaluateOnNewDocument') await installed;
    return {};
  } });
  vm.runInContext(`claims.set(7,newClaim(7,'https://example.test'));
    Object.assign(claims.get(7), {attached:true,inputObserverToken:'child-install'});`, test.context);
  markObserverReady(test.context);
  test.debuggerEvent(7, 'Target.attachedToTarget', { sessionId: 'oop-child',
    targetInfo: { type: 'iframe', targetId: 'cross-origin', url: 'https://other.test/frame' } });
  const pendingClick = vm.runInContext("run(7,'click',{x:1,y:1})", test.context);
  await vi.waitFor(() => expect(commands).toContain('Page.addScriptToEvaluateOnNewDocument'));
  expect(commands).not.toContain('Input.dispatchMouseEvent');
  finishInstall();
  await expect(pendingClick).resolves.toEqual({ x: 1, y: 1 });
});

it.each(['pending', 'failed'])('blocks executor input while any iframe observer is %s', async state => {
  const commands: string[] = [];
  const test = discoveryHarness({ command: async method => { commands.push(method); return {}; } });
  const leaseId = 'c'.repeat(32);
  vm.runInContext(`claims.set(7,newClaim(7,'https://example.test'));
    Object.assign(claims.get(7), {attached:true,inputObserverToken:'child-guard',
      playwrightLease:{id:'${leaseId}',origin:'https://example.test',input:true,documentEpoch:0,expiresAt:Date.now()+45000}});
    claims.get(7).inputObservers.set('',{...newInputObserver(),ready:true});
    claims.get(7).cdpSessions.set('child',{targetId:'frame',url:'https://other.test/frame',revision:0});
    claims.get(7).inputObservers.set('child',newInputObserver());`, test.context);
  await expect(vm.runInContext(`playwrightControl(7,'playwrightCdp',{
    leaseId:'${leaseId}',approvedOrigin:'https://example.test',method:'Input.insertText',params:{text:'A'}},'iframe-write')`, test.context))
    .rejects.toThrow('INPUT_OBSERVER_UNAVAILABLE');
  expect(commands).not.toContain('Input.insertText');
});

it.each(['Runtime.removeBinding', 'Runtime.disable', 'Page.removeScriptToEvaluateOnNewDocument',
  'Input.synthesizeTapGesture', 'Input.synthesizeScrollGesture'])('rejects raw CDP that cannot preserve input observation: %s', method => {
  const test = discoveryHarness();
  (test.context as any).observerMethod = method;
  expect(() => vm.runInContext("normalizeCdpWrite(observerMethod,{name:'__memmyUserInput'})", test.context))
    .toThrow('CDP write method is unavailable');
});

it('prevents raw CDP from replacing runtime input observer bindings', () => {
  const test = discoveryHarness();
  expect(() => vm.runInContext("normalizeCdpWrite('Runtime.addBinding',{name:'__memmyUserInput'})", test.context))
    .toThrow('CDP write method is unavailable');
  expect(() => vm.runInContext("normalizeCdpWrite('Runtime.addBinding',{name:'otherBinding'})", test.context))
    .toThrow('CDP write method is unavailable');
});
