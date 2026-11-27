import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memmy-browser/teaching-page.js"), "utf8");
const sessionId = "00000000-0000-4000-8000-000000000001";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function page() {
  const listeners = () => {
    const values = new Map<string, Set<Function>>();
    return { addEventListener(type: string, fn: Function) { if (!values.has(type)) values.set(type, new Set()); values.get(type)!.add(fn); },
      removeEventListener(type: string, fn: Function) { values.get(type)?.delete(fn); },
      fire(type: string, event: any = {}) { for (const fn of [...values.get(type) ?? []]) fn({type, isTrusted: true, ...event}); } };
  };
  let attributeReads = 0, created = 0, valueReads = 0, selectionReads = 0;
  class Element {
    id = "query"; tagName = "INPUT"; labels: any[] = []; style = {}; isConnected = false;
    nodeType = 1; parentElement: Element | null = null; children: Element[] = [];
    constructor(readonly attrs: Record<string, string> = {}) {}
    getAttribute(name: string) { attributeReads++; return this.attrs[name] ?? null; }
    setAttribute() {}
    closest(selector: string): Element | null {
      if (selector === "form") return null;
      return selector.split(",").some(part => part.toUpperCase() === this.tagName
        || part === "[role]" && this.attrs.role || part === "[contenteditable]" && "contenteditable" in this.attrs)
        ? this : this.parentElement?.closest(selector) ?? null;
    }
    querySelector(selector: string) { return this.children.find(el => el.closest(selector) === el) ?? null; }
    querySelectorAll() { return this.children; }
    remove() { this.isConnected = false; }
    get value() { throw Error("Whole-field reads must never be used for teaching"); }
  }
  class Input extends Element {}
  const document = {...listeners(), hasFocus: () => true, visibilityState: "visible",
    createElement: () => { created++; return new Element(); },
    documentElement: {appendChild: (el: Element) => {el.isConnected = true;}}};
  const window: any = {...listeners()}; window.top = window;
  const ports: any[] = [];
  const chrome = {runtime: {id: "test-extension", onMessage: {addListener() {}}, connect() {
    const messages: Function[] = [], disconnects: Function[] = [];
    const port = {sent: [] as any[], onMessage: {addListener: (fn: Function) => messages.push(fn)},
      onDisconnect: {addListener: (fn: Function) => disconnects.push(fn)},
      postMessage(message: unknown) {port.sent.push(JSON.parse(JSON.stringify(message)));},
      incoming(message: unknown) {messages.forEach(fn => fn(message));}, disconnect() {disconnects.forEach(fn => fn());}};
    ports.push(port); return port;
  }}};
  const timers = new Set<ReturnType<typeof setInterval>>();
  const context = vm.createContext({window, document, chrome, crypto: webcrypto, Uint8Array, URL,
    location: new URL("https://teaching.test/form"), Element, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: class {},
    setInterval: (fn: () => void, ms: number) => { const timer = setInterval(fn, ms); timers.add(timer); return timer; }, clearInterval});
  vm.runInContext(source, context); cleanup.push(() => timers.forEach(clearInterval));
  const configure = () => ports.at(-1).incoming({type: "configure", sessionId});
  const scope = () => ports.at(-1).incoming({type: "scope", sessionId});
  const command = (action: string, extra = {}) => ports.at(-1).incoming({type: "command", sessionId, id: "request", action, ...extra});
  const activate = () => command("activate", {url: "https://teaching.test/form", epoch: 0});
  const input = (text = "inserted text", attrs = {}) => {const target = new Input(attrs); document.fire("input", {data: text, target, composedPath: () => [target]});};
  const date = (value: string, options: {trusted?: boolean; attrs?: Record<string,string>} = {}) => {
    const target = new Input({type: "date", ...options.attrs});
    Object.defineProperty(target, "value", {get() { valueReads++; return value; }});
    document.fire("change", {target, isTrusted: options.trusted ?? true});
  };
  const copy = (text: string, options: {trusted?: boolean; sensitive?: boolean; editable?: boolean; descendant?: boolean; outside?: boolean; boundary?: boolean; collapsed?: boolean} = {}) => {
    const target = new Element(options.sensitive ? {name: "api-key"} : {}); target.tagName = options.editable ? "INPUT" : "DD";
    if (options.descendant || options.outside || options.boundary) target.children.push(new Input({type: "password"}));
    window.getSelection = () => ({isCollapsed: options.collapsed ?? false, rangeCount: 1, getRangeAt: () => ({commonAncestorContainer: target,
      endOffset: options.boundary ? 0 : 1, endContainer: options.boundary ? target.children[0] : target,
      intersectsNode: () => !options.outside, toString: () => { selectionReads++; return text; }})});
    document.fire("copy", {target, isTrusted: options.trusted ?? true});
  };
  const observed = () => ports.flatMap(p => p.sent.filter((m: any) => m.type === "observation").map((m: any) => JSON.parse(m.payload)));
  return {ports, window, document, scope, configure, activate, command, input, date, copy, observed,
    reads: () => attributeReads, created: () => created, valueReads: () => valueReads, selectionReads: () => selectionReads};
}
describe("authorized native teaching content script", () => {
  it("captures canonical dates only after an authorized trusted change", () => {
    const f = page(); f.date("2026-10-23"); f.configure(); f.date("2026-10-23");
    expect(f.valueReads()).toBe(0); f.activate(); f.date("2026-10-23", {trusted:false});
    expect(f.valueReads()).toBe(0); f.date("2026-10-23");
    expect(f.observed()).toMatchObject([{eventType:"text_input", details:{inputType:"date",text:"2026-10-23",textSource:"control_change",redacted:false}}]);
    f.command("checkpoint", {checkpointId:"stop",lifetime:0}); f.date("2026-10-24");
    expect(f.valueReads()).toBe(1);
  });
  it.each(["date", "datetime-local", "time", "month", "week"])("keeps %s control values behind privacy and visibility checks", type => {
    const f = page(); f.configure(); f.activate(); f.date("2026-10-23", {attrs:{type,name:"secret"}});
    f.document.visibilityState="hidden"; f.date("2026-10-23", {attrs:{type}});
    expect(f.valueReads()).toBe(0); expect(f.observed()).toEqual([]);
  });
  it("records explicitly copied static text without reading the clipboard or full page", () => {
    const f = page(); f.copy("BEFORE_AUTH"); f.configure(); f.copy("BEFORE_ACTIVE");
    expect(f.selectionReads()).toBe(0); f.activate(); f.copy("发票编号 EXP-TEST-01");
    expect(f.observed()).toMatchObject([{eventType:"selection_changed",details:{role:"document-text",text:"发票编号 EXP-TEST-01",textSource:"document_copy",redacted:false}}]);
    f.command("checkpoint", {checkpointId:"stop",lifetime:0}); f.copy("AFTER_STOP");
    expect(f.selectionReads()).toBe(1);
  });
  it.each([{trusted:false},{sensitive:true},{editable:true},{descendant:true},{collapsed:true}])("rejects unsafe or non-user copy selections before reading text (%j)", options => {
    const f = page(); f.configure(); f.activate(); f.copy("MUST_NOT_READ",options);
    expect(f.selectionReads()).toBe(0); expect(f.observed()).toEqual([]);
  });
  it.each([{outside:true},{boundary:true}])("ignores unrelated sensitive elements outside the copied contents (%j)", options => {
    const f = page(); f.configure(); f.activate(); f.copy("VISIBLE_RECEIPT", options);
    expect(f.selectionReads()).toBe(1);
    expect(f.observed()[0].details.text).toBe("VISIBLE_RECEIPT");
  });
  it("redacts secret-shaped content in an otherwise public copy selection", () => {
    const f = page(); f.configure(); f.activate(); f.copy("token=private123456789");
    expect(f.observed()[0].details).toMatchObject({text:"token=[REDACTED]",redacted:true});
  });
  it("does not read copied text from an unfocused document", () => {
    const f=page(); f.configure(); f.activate(); f.document.hasFocus=()=>false; f.copy("NOT_FOREGROUND");
    expect(f.selectionReads()).toBe(0); expect(f.observed()).toEqual([]);
  });
  it("does not install a collector or inspect page fields before background authorization", () => {
    const f = page(); f.input("outside-teaching-secret");
    f.window.fire("pagehide");
    expect(f.created()).toBe(0); expect(f.reads()).toBe(0); expect(f.observed()).toEqual([]);
    expect(f.ports[0].sent).toEqual([]);
  });
  it.each([0, 1])("proves an unconfigured scoped document's interaction count without reading content (%i)", count => {
    const f = page();
    if (count) f.input("never-read-bootstrap-secret");
    f.scope(); f.window.fire("pagehide"); f.window.fire("freeze");
    expect(f.ports[0].sent).toEqual([{type: "bootstrap-closed", sessionId, interactions: count}]);
    expect(f.reads()).toBe(0); expect(f.created()).toBe(0);
    f.configure(); expect(f.created()).toBe(0);
  });
  it("counts early interactions without reading their values before collector activation", () => {
    const f = page(); f.configure(); f.input("before-activation-secret");
    expect(f.reads()).toBe(0); expect(f.observed()).toEqual([]);
    f.activate();
    expect(f.ports[0].sent.at(-1).state.missed).toBe(1);
  });
  it("reports a startup gap even when the interaction preceded collector configuration", () => {
    const f = page(); f.input("before-configuration-secret");
    f.configure(); f.activate();
    expect(f.ports[0].sent.at(-1).state.missed).toBe(1);
    expect(f.reads()).toBe(0);
    expect(JSON.stringify(f.observed())).not.toContain("before-configuration-secret");
  });
  it("sends inserted text and the exact final sequence through a native Port on pagehide", () => {
    const f = page(); f.configure(); f.activate(); f.input();
    f.window.fire("pagehide"); f.input("after-pagehide");
    const events = f.observed();
    expect(events.map(e => e.kind)).toEqual(["event", "closed"]);
    expect(events[0]).toMatchObject({documentSequence: 1, details: {text: "inserted text"}});
    expect(events[1]).toMatchObject({documentSequence: 1, reason: "pagehide"});
  });
  it("omits sensitive inputs and cannot resume capture after stop or Port disconnection", () => {
    const f = page(); f.configure(); f.activate(); f.input("password-secret", {type: "password"});
    expect(f.observed()).toEqual([]);
    f.command("checkpoint", {checkpointId: "stop", lifetime: 0});
    f.window.fire("pageshow"); f.input("after-stop");
    expect(f.observed().map(e => e.kind)).toEqual(["closed"]);
    f.ports[0].disconnect(); f.window.fire("pageshow"); f.input("after-reconnect-without-authorization");
    expect(f.ports).toHaveLength(2); expect(f.ports[1].sent).toEqual([]);
    expect(JSON.stringify(f.observed())).not.toMatch(/password-secret|after-stop|after-reconnect/);
  });
});
