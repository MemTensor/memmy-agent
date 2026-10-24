import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const background = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memmy-browser/background.js");
function harness() {
  const sent: any[] = [];
  const tabs = new Map<number, any>([
    [7, { id: 7, windowId: 1, active: true, incognito: false, status: "complete", title: "Shop", url: "https://shop.test/" }],
    [8, { id: 8, windowId: 2, active: true, incognito: false, status: "complete", title: "Company", url: "https://company.test/" }],
  ]);
  const windows = new Map<number, any>([
    [1, { id: 1, focused: true, incognito: false }], [2, { id: 2, focused: false, incognito: false }],
  ]);
  let focusChanged = () => undefined;
  let activated = (_info: any) => undefined;
  let updated = (_tabId: number, _changes: any, _tab: any) => undefined;
  let focusedWindow = 1;
  let debuggerReads = 0;
  const chrome: any = {
    runtime: { id: "test", onMessage: { addListener() {} } },
    tabs: { get: async (id: number) => tabs.get(id),
      onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      onUpdated: { addListener(fn: typeof updated) { updated = fn; } },
      onActivated: { addListener(fn: typeof activated) { activated = fn; } } },
    windows: { get: async (id: number) => ({ ...windows.get(id) }),
      getLastFocused: async () => ({ ...windows.get(focusedWindow) }),
      onFocusChanged: { addListener(fn: typeof focusChanged) { focusChanged = fn; } } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async () => { debuggerReads++; return {}; } },
  };
  const context = vm.createContext({ chrome, navigator: { userAgent: "Chrome/154" }, URL,
    WebSocket: class { static OPEN = 1; }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(background, "utf8"), context);
  chrome.tabs.query = async (query: any) => [...tabs.values()].filter(tab => tab.active && tab.windowId === query.windowId);
  (context as any).mockSocket = { readyState: 1, send: (value: string) => sent.push(JSON.parse(value)) };
  vm.runInContext("socket = mockSocket", context);
  return { context, sent, tabs, windows, chrome,
    refresh: () => vm.runInContext("refreshHistoryFocus()", context) as Promise<void>,
    selectWindow: (id: number) => {
      focusedWindow = id;
      for (const window of windows.values()) window.focused = window.id === id;
      focusChanged();
    },
    activate: (tabId: number) => activated({ tabId }),
    navigate: (tabId: number) => updated(tabId, { url: tabs.get(tabId).url }, tabs.get(tabId)),
    debuggerReads: () => debuggerReads,
  };
}
const history = (test: ReturnType<typeof harness>) => test.sent.filter(message => message.type === "history_focus");

describe("history browser focus metadata", () => {
  it("reads only the actual focused window's active tab without attaching or reading the page", async () => {
    const test = harness();
    await test.refresh();
    expect(history(test).at(-1)).toMatchObject({ focused: true, tabId: 7, windowId: 1,
      mode: "normal", url: "https://shop.test/", title: "" });
    expect(test.debuggerReads()).toBe(0);
  });

  it("invalidates the old URL synchronously on a window focus change without tab activation", async () => {
    const test = harness();
    await test.refresh();
    test.selectWindow(2);
    expect(history(test).at(-1)).toMatchObject({ focused: false, mode: "unknown" });
    await test.refresh();
    expect(history(test).at(-1)).toMatchObject({ focused: true, tabId: 8, windowId: 2, url: "https://company.test/" });
  });

  it("cannot reintroduce a stale URL when focus changes during an async API read", async () => {
    const test = harness();
    let release: (value: any) => void = () => undefined;
    test.chrome.windows.getLastFocused = () => new Promise(resolve => { release = resolve; });
    const work = test.refresh();
    vm.runInContext("invalidateHistoryFocus()", test.context);
    release({ id: 1, focused: true, incognito: false });
    await work;
    expect(history(test).every(message => message.focused === false)).toBe(true);
  });

  it("refuses a navigated/loading tab and invalidates on navigation before lookup finishes", async () => {
    const test = harness();
    await test.refresh();
    test.tabs.get(7).pendingUrl = "https://company.test/";
    test.navigate(7);
    expect(history(test).at(-1).focused).toBe(false);
    await test.refresh();
    expect(history(test).at(-1).focused).toBe(false);
  });

  it("redacts private/unknown pages and does not mistake absent incognito evidence for normal", async () => {
    const test = harness();
    test.tabs.get(7).incognito = true;
    await test.refresh();
    expect(history(test).at(-1)).toMatchObject({ focused: true, mode: "private", url: "", title: "" });
    delete test.tabs.get(7).incognito;
    await test.refresh();
    expect(history(test).at(-1)).toMatchObject({ focused: true, mode: "unknown", url: "", title: "" });
    test.tabs.get(7).incognito = false;
    vm.runInContext("protectedCredentialTabs.add(7)", test.context);
    await test.refresh();
    expect(history(test).at(-1)).toMatchObject({ mode: "unknown", url: "", title: "" });
  });

  it("publishes no normal tab when the profile window is in the background or identity is ambiguous", async () => {
    const test = harness();
    test.windows.get(1).focused = false;
    await test.refresh();
    expect(history(test).at(-1).focused).toBe(false);
    test.windows.get(1).focused = true;
    test.tabs.set(9, { ...test.tabs.get(7), id: 9 });
    await test.refresh();
    expect(history(test).at(-1).focused).toBe(false);
  });
});
