import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memmy-browser/teaching-recorder.js"), "utf8");
const id = "00000000-0000-4000-8000-000000000001";
const policy = { observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [] as unknown[] } };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness() {
  const events = () => { const listeners: Function[] = []; return { addListener: (fn: Function) => listeners.push(fn), emit: (...args: unknown[]) => listeners.forEach(fn => fn(...args)) }; };
  const tabs = new Map<number, any>([[7, { id: 7, windowId: 1, url: "https://daily.test/", incognito: false, active: true }]]);
  const windows = new Map<number, any>([[1, { id: 1, incognito: false, focused: false }]]);
  let nextWindow = 20, nextTab = 8;
  const sent: any[] = [], attached: number[] = [], detached: number[] = [], commands: any[] = [];
  const chrome: any = {
    runtime: {id: "test-extension"},
    tabs: { get: async (tabId: number) => { if (!tabs.has(tabId)) throw Error("closed"); return { ...tabs.get(tabId) }; },
      sendMessage: async (tabId: number) => { if (tabs.get(tabId)?.url.startsWith("https://")) void connect(currentContexts.get(tabId) ?? newContext(tabId)); },
      query: async (query: any) => [...tabs.values()].filter(tab => query.windowId === undefined || tab.windowId === query.windowId),
      onCreated: events(), onUpdated: events(), onDetached: events(), onAttached: events(), onRemoved: events() },
    windows: { getAll: async () => [...windows.values()],
      get: async (windowId: number, options?: any) => ({ ...windows.get(windowId), ...(options?.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === windowId) } : {}) }),
      create: async () => {
        const window = { id: nextWindow++, incognito: false, focused: true }; windows.set(window.id, window);
        const tab = { id: nextTab++, windowId: window.id, url: "about:blank", incognito: false, active: true }; tabs.set(tab.id, tab);
        return window;
      }, onRemoved: events() },
    debugger: { onEvent: events(), onDetach: events() }, webNavigation: { onCreatedNavigationTarget: events(), onCommitted: events() },
  };
  let fencesWork = true, closeOnNavigation = true, initialMissed = 0, nextContext = 1000, nextNonce = 1;
  let duringFence: (() => unknown) | undefined;
  const contexts = new Map<number, any>();
  const currentContexts = new Map<number, any>();
  const newContext = (tabId: number, contextId = ++nextContext) => {
    const state = {tabId, contextId, uniqueId: contextId.toString(16).padStart(32, "0"), nonce: (nextNonce++).toString(16).padStart(32, "0"), epoch: 0, sequence: 0, closed: false, revoked: false, missed: initialMissed};
    contexts.set(contextId, state); currentContexts.set(tabId, state); return state;
  };
  const binding = (state: any, value: any) => state.port?.onMessage.emit({type: "observation", sessionId: id,
    payload: JSON.stringify({nonce: state.nonce, epoch: state.epoch, missed: state.missed, ...value})});
  const services = {
    send: (message: any) => sent.push(JSON.parse(JSON.stringify(message))), protected: () => false,
    attach: async (tabId: number) => { attached.push(tabId); }, detach: async (tabId: number) => { detached.push(tabId); },
    command: async (tabId: number, method: string, params: any = {}) => {
      commands.push({ tabId, method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `frame-${tabId}` } } };
      if (method === "Page.createIsolatedWorld") {
        const state = currentContexts.get(tabId) ?? newContext(tabId);
        return { executionContextId: state.contextId };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `script-${tabId}` };
      if (method === "Runtime.evaluate" && params.contextId !== undefined) {
        const match = /\.checkpoint\(("[^"]+"),(\d+)/.exec(params.expression);
        if (match && duringFence) { const hook = duringFence; duringFence = undefined; hook(); }
        let state = params.uniqueContextId ? [...contexts.values()].find(s => s.uniqueId === params.uniqueContextId) : contexts.get(params.contextId);
        if (!state) throw Error("Cannot find context with specified id");
        if (params.expression.includes('function memmyTeachingPage') && state.revoked) {
          state = newContext(tabId, state.contextId);
        }
        if (match && fencesWork && !state.closed && !state.revoked) {
          const final = Number(match[2]) === 0;
          if (final) state.closed = true;
          queueMicrotask(() => binding(state, {kind: final ? "closed" : "fence", id: JSON.parse(match[1]!), documentSequence: state.sequence, reason: final ? "stop" : undefined}));
        }
        if (params.expression.includes('?.stop()')) state.revoked = true;
        return {result: {value: {...state}}};
      }
      return {};
    },
  };
  const context = vm.createContext({ chrome, URL, setInterval, clearInterval, setTimeout, clearTimeout, services });
  vm.runInContext(source, context);
  const recorder = vm.runInContext("createMemmyTeachingRecorder(services)", context);
  cleanups.push(() => recorder.close());
  const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
  async function connect(state: any) {
    if (state.port && !state.disconnected) return;
    if (state.revoked) { state.nonce = (nextNonce++).toString(16).padStart(32, "0"); state.revoked = false; state.closed = false; state.sequence = 0; }
    state.disconnected = false;
    const port = {name: "memmy-teaching/v2", sender: {id: chrome.runtime.id, frameId: 0, documentId: state.uniqueId, tab: {...tabs.get(state.tabId)}, url: tabs.get(state.tabId).url},
      onMessage: events(), onDisconnect: events(),
      disconnect() { if (!state.disconnected) {state.disconnected = true; state.revoked = true; port.onDisconnect.emit();} },
      postMessage(message: any) {
        if (state.disconnected) throw Error("Port disconnected");
        if (message.type === "configure") { queueMicrotask(() => port.onMessage.emit({type: "ready", sessionId: id, state: {...state, port: undefined}})); return; }
        if (message.type !== "command") return;
        if (message.action === "checkpoint" && duringFence) {const hook = duringFence; duringFence = undefined; hook();}
        if (state.disconnected) throw Error("Port disconnected");
        if (message.action === "checkpoint" && fencesWork && !state.closed) {
          const final = message.lifetime === 0; if (final) state.closed = true;
          queueMicrotask(() => binding(state, {kind: final ? "closed" : "fence", id: message.checkpointId, documentSequence: state.sequence, reason: final ? "stop" : undefined}));
        }
        if (message.action === "stop") state.revoked = true;
        queueMicrotask(() => port.onMessage.emit({type: "reply", id: message.id, sessionId: id, state: {...state, port: undefined}}));
      }
    };
    state.port = port; await recorder.connectPage(port);
  }
  async function navigate(tabId = 8, url = "https://teaching.test/form") {
    const previous = currentContexts.get(tabId);
    if (previous && closeOnNavigation && !previous.closed && !previous.revoked) {
      previous.closed = true; binding(previous, {kind: "closed", documentSequence: previous.sequence, reason: "pagehide"});
    }
    previous?.port?.disconnect();
    tabs.get(tabId).url = url;
    chrome.tabs.onUpdated.emit(tabId, { url }, tabs.get(tabId));
    chrome.debugger.onEvent.emit({ tabId }, "Runtime.executionContextsCleared", {});
    if (previous) contexts.delete(previous.contextId);
    chrome.debugger.onEvent.emit({ tabId }, "Page.frameNavigated", { frame: { id: `frame-${tabId}`, url } });
    const state = newContext(tabId);
    chrome.webNavigation.onCommitted.emit({tabId, frameId: 0, documentId: state.uniqueId, documentLifecycle: "active", url});
    chrome.debugger.onEvent.emit({ tabId }, "Runtime.executionContextCreated", { context: { id: state.contextId,
      uniqueId: state.uniqueId, name: `memmy.teaching.${id}`, auxData: { frameId: `frame-${tabId}` } } });
    void connect(state);
    await settle();
  }
  async function input(tabId = 8, text = "ordinary input") {
    const state = currentContexts.get(tabId);
    if (state && !state.disconnected) binding(state, {kind: "event", eventType: "text_input", observedAt: Date.now(), documentSequence: ++state.sequence, details: {text}});
    await settle();
  }
  const command = (action: string, input = {}) => recorder.handle({ sessionId: id, action, input });
  async function start(settings = policy) {
    const prepared = await command("prepare", { protocolVersion: 2, settings, bundleId: "win32.chrome" });
    expect(prepared).toEqual({ protocolVersion: 2, windowId: 20, incognito: false });
    await command("start"); await navigate();
  }
  return { chrome, tabs, windows, sent, attached, detached, commands, recorder, settle, navigate, input, command, start,
    breakFences: () => { fencesWork = false; },
    setEarlyInteractions: (count: number) => {initialMissed = count;},
    loseClose: () => {closeOnNavigation = false;},
    duringFence: (fn: () => unknown) => {duringFence = fn;}, contexts, currentContexts, binding };
}
describe("browser extension teaching isolation", () => {
  it.each([0, 1])("requires a scoped zero-interaction close proof for an unconfigured redirect (%i)", async interactions => {
    const f = harness(); await f.start();
    const documentId = "d".repeat(32);
    f.chrome.webNavigation.onCommitted.emit({tabId: 8, frameId: 0, documentId, documentLifecycle: "active", url: "https://teaching.test/redirect"});
    let receive: (message: any) => void = () => {};
    const port = {name: "memmy-teaching/v2", sender: {id: f.chrome.runtime.id, frameId: 0, documentId,
      tab: {...f.tabs.get(8)}, url: "https://teaching.test/redirect"},
      onMessage: {addListener: (fn: typeof receive) => {receive = fn;}}, onDisconnect: {addListener() {}}, disconnect() {},
      postMessage(message: any) {if (message.type === "scope") queueMicrotask(() => receive({type: "bootstrap-closed", sessionId: id, interactions}));}};
    await f.recorder.connectPage(port); await f.settle();
    await f.navigate(8, "https://teaching.test/next");
    const result = await f.command("stop", {through: new Date().toISOString()});
    expect(result).toMatchObject({boundaryConfirmed: true, coverageComplete: interactions === 0, complete: interactions === 0});
    if (!interactions) expect(f.sent).toContainEqual(expect.objectContaining({kind: "proof", status: "empty_document_closed", documentId}));
  });
  it("rejects unauthorized native Ports before configuring any page collector", async () => {
    const f = harness(); await f.start();
    const sender = {id: f.chrome.runtime.id, frameId: 0, documentId: "c".repeat(32), tab: {id: 8, windowId: 20, incognito: false}, url: "https://teaching.test/form"};
    const probe = async (overrides: Record<string, unknown>) => {
      const sent: unknown[] = []; let disconnected = false;
      await f.recorder.connectPage({name: "memmy-teaching/v2", sender: {...sender, ...overrides},
        onMessage: {addListener() {}}, onDisconnect: {addListener() {}},
        postMessage: (message: unknown) => sent.push(message), disconnect: () => {disconnected = true;}});
      expect(disconnected).toBe(true);
      expect(sent.every((message: any) => message.type === "scope")).toBe(true);
    };
    await probe({id: "other-extension"});
    await probe({frameId: 1});
    await probe({url: "edge://settings/"});
    await probe({tab: {id: 7, windowId: 1, incognito: false}});
    // Even a stale sender window cannot override the browser's current tab ownership.
    await probe({tab: {id: 7, windowId: 20, incognito: false}});
    f.tabs.get(8).incognito = true;
    await probe({});
  });
  it("separates missed startup interactions from a confirmed final event watermark", async () => {
    const f = harness(); f.setEarlyInteractions(1); await f.start(); await f.input();
    expect(await f.command("stop", {through: new Date().toISOString()})).toMatchObject({boundaryConfirmed: true, coverageComplete: false, complete: false});
  });
  it("keeps a coverage gap for a whole document that navigated away before collector readiness", async () => {
    const f = harness(); await f.start();
    f.chrome.webNavigation.onCommitted.emit({tabId: 8, frameId: 0, documentId: "a".repeat(32), documentLifecycle: "active", url: "https://teaching.test/too-fast"});
    await f.navigate(8, "https://teaching.test/next");
    const result = await f.command("stop", {through: new Date().toISOString()});
    expect(result).toMatchObject({boundaryConfirmed: true, coverageComplete: false, complete: false});
    expect(f.sent).toContainEqual(expect.objectContaining({kind: "proof", status: "collector_not_ready", documentId: "a".repeat(32)}));
  });
  it("cannot confirm coverage when stopped before a committed document becomes ready", async () => {
    const f = harness(); await f.start();
    f.chrome.webNavigation.onCommitted.emit({tabId: 8, frameId: 0, documentId: "b".repeat(32), documentLifecycle: "active", url: "https://teaching.test/not-ready"});
    expect(await f.command("stop", {through: new Date().toISOString()})).toMatchObject({coverageComplete: false});
  });
  it("completes a checkpoint racing with Port disconnect only with the old document's close proof", async () => {
    const f = harness(); await f.start(); await f.input(8, "last-before-navigation");
    f.duringFence(() => { void f.navigate(8, "https://teaching.test/next"); });
    const point = await f.command("checkpoint");
    expect(point).toMatchObject({ protocolVersion: 2, boundaryConfirmed: true, coverageComplete: true });
    expect(f.sent).toContainEqual(expect.objectContaining({kind: "document-closed", documentSequence: 1, confirmed: true}));
    // Let the new document finish activation; stopping before that is a separate coverage-gap case.
    await f.settle();
    expect((await f.command("stop", {through: new Date().toISOString()})).complete).toBe(true);
  });
  it("preserves a real missing close as a coverage gap even when the final stop boundary succeeds", async () => {
    const f = harness(); await f.start(); f.loseClose();
    await f.navigate(8, "https://teaching.test/next");
    await new Promise(resolve => setTimeout(resolve, 2100));
    const result = await f.command("stop", {through: new Date().toISOString()});
    expect(result).toMatchObject({boundaryConfirmed: true, coverageComplete: false, complete: false});
    expect(f.sent).toContainEqual(expect.objectContaining({kind: "fault", code: "browser_capture_document_tail_unconfirmed"}));
  });
  it("does not accept a close marker as proof when the final event is missing", async () => {
    const f = harness(); await f.start(); f.currentContexts.get(8).sequence++;
    await f.navigate(8, "https://teaching.test/next");
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(await f.command("stop", {through: new Date().toISOString()})).toMatchObject({coverageComplete: false});
  });
  it("drains an authorized old document after the new document registers", async () => {
    const f = harness(); await f.start(); const old = f.currentContexts.get(8); f.loseClose(); old.port.disconnect = () => {};
    await f.navigate(8, "https://teaching.test/next");
    f.binding(old, {kind: "event", eventType: "text_input", documentSequence: ++old.sequence, observedAt: Date.now(), details: {text: "late-old-tail"}});
    f.binding(old, {kind: "closed", documentSequence: old.sequence, reason: "pagehide"});
    await f.settle();
    expect(f.sent).toContainEqual(expect.objectContaining({kind: "event", details: {text: "late-old-tail"}}));
    expect((await f.command("stop", {through: new Date().toISOString()})).complete).toBe(true);
  });
  it("freezes a stop racing with navigation and replays its cached acknowledgement", async () => {
    const f = harness(); await f.start();
    f.duringFence(() => { void f.navigate(8, "https://teaching.test/after-stop"); });
    const cutoff = new Date().toISOString(), first = await f.command("stop", {through: cutoff});
    const count = f.sent.length;
    expect(await f.command("stop", {through: new Date().toISOString()})).toEqual(first);
    expect(f.sent).toHaveLength(count);
    await expect(f.command("start")).rejects.toThrow("session_expired");
  });
  it("requires the versioned document-handoff protocol", async () => {
    await expect(harness().command("prepare", {settings: policy, bundleId: "win32.chrome"})).rejects.toThrow("protocol_update_required");
  });
  it("creates a normal window in the existing profile and never attaches to the daily window", async () => {
    const f = harness(); await f.start(); await f.input(); await f.input(7, "daily-secret");
    expect(f.attached).toEqual([8]);
    expect(f.sent.filter(item => item.kind === "event" && item.eventType === "text_input")).toHaveLength(1);
    expect(JSON.stringify(f.sent)).not.toContain("daily-secret");
    const ack = await f.command("stop", { through: new Date().toISOString() });
    expect(ack.complete).toBe(true);
    const count = f.sent.length; await f.input(); expect(f.sent).toHaveLength(count);
    expect(f.tabs.has(8)).toBe(true); expect(f.windows.has(20)).toBe(true);
    expect(f.detached).toContain(8);
    expect(f.currentContexts.get(8).revoked).toBe(true);
  });
  it("ignores unrelated windows and admits only a browser-proven new popup", async () => {
    const f = harness(); await f.start();
    f.windows.set(30, { id: 30, incognito: false, focused: true });
    f.tabs.set(9, { id: 9, windowId: 30, url: "https://teaching.test/popup", incognito: false, active: true });
    f.chrome.tabs.onCreated.emit(f.tabs.get(9)); await f.settle();
    expect(f.attached).toEqual([8]);
    // Existing Computer Use URL/time guesses are intentionally irrelevant to this recorder.
    f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 8, tabId: 9 }); await f.settle();
    expect(f.attached).toEqual([8, 9]); await f.input(9);
    expect(f.sent).toContainEqual(expect.objectContaining({ kind: "window", windowId: 30, sourceTabId: 8, sourceWindowId: 20 }));
    // A new tab in a pre-existing daily window does not authorize that entire window.
    f.tabs.set(10, { id: 10, windowId: 1, url: "https://teaching.test/", incognito: false, active: true });
    f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 8, tabId: 10 }); await f.settle();
    expect(f.attached).not.toContain(10);
  });
  it("revokes a tab as it leaves and rebinds it only after entry into the teaching window", async () => {
    const f = harness(); await f.start();
    await f.input(8, "before-departure");
    f.tabs.get(8).windowId = 1; f.chrome.tabs.onDetached.emit(8, { oldWindowId: 20 });
    await f.settle(); await f.input(8, "outside-value");
    expect(f.recorder.owns(8)).toBe(false); expect(JSON.stringify(f.sent)).not.toContain("outside-value");
    f.tabs.get(8).windowId = 20; f.chrome.tabs.onAttached.emit(8, { newWindowId: 20 }); await f.settle();
    expect(f.recorder.owns(8)).toBe(true); await f.input(8, "inside-again");
    expect(JSON.stringify(f.sent)).toContain("inside-again");
    const left = f.sent.findIndex(item => item.kind === "tab-left");
    expect(f.sent.slice(0, left)).toContainEqual(expect.objectContaining({kind: "document-closed", documentSequence: 1, confirmed: true}));
    expect(await f.command("stop", {through: new Date().toISOString()})).toMatchObject({complete: true, coverageComplete: true});
  });
  it("waits for a departing document when Stop overlaps tab removal", async () => {
    const f = harness(); await f.start(); await f.input();
    f.tabs.get(8).windowId = 1; f.chrome.tabs.onDetached.emit(8, { oldWindowId: 20 });
    expect(await f.command("stop", {through: new Date().toISOString()})).toMatchObject({complete: true, coverageComplete: true});
    expect(f.sent.filter(item => item.kind === "tab-left")).toHaveLength(1);
  });
  it("retains a coverage gap when a departing document loses its close proof", async () => {
    const f = harness(); await f.start(); await f.input(); f.breakFences();
    f.tabs.get(8).windowId = 1; f.chrome.tabs.onDetached.emit(8, { oldWindowId: 20 });
    const result = await f.command("stop", {through: new Date().toISOString()});
    expect(result.coverageComplete).toBe(false);
    expect(f.sent).toContainEqual(expect.objectContaining({kind: "fault", code: "browser_capture_document_tail_unconfirmed"}));
  });
  it("does not attach to excluded sites or private popups, including before page text reads", async () => {
    const f = harness();
    await f.start({ observation: { ...policy.observation, rules: [{ scope: "url", urlDomain: "teaching.test", behavior: "do_not_observe" }] } });
    expect(f.recorder.owns(8)).toBe(false); await f.input(8, "excluded-page-text");
    expect(JSON.stringify(f.sent)).not.toContain("excluded-page-text");
    const g = harness(); await g.start();
    g.windows.set(30, { id: 30, incognito: true, focused: true });
    g.tabs.set(9, { id: 9, windowId: 30, url: "https://teaching.test/", incognito: true, active: true });
    g.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 8, tabId: 9 }); await g.settle();
    expect(g.attached).toEqual([8]);
  });
  it("revokes all recording after user detach and never resumes from a late start or navigation", async () => {
    const f = harness(); await f.start(); f.chrome.debugger.onDetach.emit({ tabId: 8 }, "canceled_by_user"); await f.settle();
    expect(f.sent).toContainEqual(expect.objectContaining({ kind: "fault", code: "browser_capture_debugger_detached", terminal: true }));
    await f.navigate(); await expect(f.command("start")).rejects.toThrow("session_expired");
    expect(f.recorder.owns(8)).toBe(false);
  });
  it("keeps an already observed final input when focus moves back to the conversation", async () => {
    const f = harness(); await f.start();
    f.windows.get(20).focused = false;
    await f.input(8, "last-observed-input");
    expect(JSON.stringify(f.sent)).toContain("last-observed-input");
    expect((await f.command("stop", { through: new Date().toISOString() })).complete).toBe(true);
  });
  it("marks a popup with no browser-proven origin incomplete without attaching to it", async () => {
    const f = harness(); await f.start();
    f.chrome.debugger.onEvent.emit({ tabId: 8 }, "Page.windowOpen", { url: "https://unknown.test/" });
    const result = await f.command("stop", { through: new Date().toISOString() });
    expect(result.complete).toBe(false);
    expect(f.sent).toContainEqual(expect.objectContaining({ kind: "fault", code: "browser_capture_popup_unconfirmed" }));
    expect(f.attached).toEqual([8]);
  });
  it("keeps missing per-document fences incomplete and revokes on transport disconnect", async () => {
    const f = harness(); await f.start(); f.breakFences();
    const result = await f.command("stop", { through: new Date().toISOString() });
    expect(result.complete).toBe(false);
    expect(f.recorder.owns(8)).toBe(false);
    const g = harness(); await g.start(); g.recorder.disconnect(); await g.settle();
    await expect(g.command("start")).rejects.toThrow("session_expired");
  });
});
