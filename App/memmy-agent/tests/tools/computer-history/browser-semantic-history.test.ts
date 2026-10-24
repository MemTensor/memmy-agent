import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBrowserHistoryEvent, type BrowserHistoryCaptureIntent, type BrowserHistoryTrustedContext } from "../../../src/tools/computer-history/browser-semantic-history.js";
import { browserHistorySensorScript, browserHistorySensorStopScript } from "../../../src/tools/computer-history/browser-history-sensor.js";
import { DEFAULT_OBSERVATION_SETTINGS } from "../../../src/tools/computer-history/mac/observation-settings.js";
import { ComputerHistoryDemoService, buildRecordedExperienceWorkflow, type ComputerHistoryEntry } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { compactEventEvidence } from "../../../src/tools/computer-history/mac/summary-writer.js";
import { reusableHumanActions } from "../../../src/tools/computer-history/mac/summarize-history.js";

const now = Date.now();
const intent: BrowserHistoryCaptureIntent = { enabled: true, generation: "recording-1", captureText: true,
  settings: structuredClone(DEFAULT_OBSERVATION_SETTINGS) };
const context: BrowserHistoryTrustedContext = { connectionId: "connection-1", browser: "chrome", tabId: 3, windowId: 4,
  documentId: "document-1", url: "https://example.test/form?token=secret#field", privateBrowsing: false, protected: false };
const payload = () => ({ version: 1, eventId: "event-1", observedAt: now, generation: intent.generation,
  documentId: context.documentId, action: "change", target: { role: "checkbox", name: "Include selected row", checked: true },
  before: { target: { checked: false } }, after: { target: { checked: true }, text: ["1 row selected"] } });

const roots: string[] = [], services: ComputerHistoryDemoService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("browser semantic Computer History", () => {
  it.each(["darwin", "win32"] as const)("inherits %s app/site policies and retains observed checkbox states", platform => {
    const prepared = prepareBrowserHistoryEvent(payload(), context, intent, now, platform)!;
    expect(prepared.event.application.bundleId).toBe(platform === "win32" ? "win32.chrome" : "com.google.Chrome");
    expect(prepared.event.details).toMatchObject({ source: "browser_history", actor: "unknown", url: "https://example.test/form",
      before: { target: { checked: false } }, after: { target: { checked: true } } });
    const denied = { ...intent, settings: { ...intent.settings!, observation: { ...intent.settings!.observation,
      rules: [{ scope: "app" as const, bundleID: prepared.event.application.bundleId, behavior: "do_not_observe" as const }] } } };
    expect(prepareBrowserHistoryEvent(payload(), context, denied, now, platform)).toBeNull();
  });

  it("matches the native Windows app name so one browsing session stays one activity", () => {
    expect(prepareBrowserHistoryEvent(payload(), context, intent, now, "win32")!.event.application).toEqual({ name: "chrome", bundleId: "win32.chrome" });
    expect(prepareBrowserHistoryEvent(payload(), { ...context, browser: "edge" }, intent, now, "win32")!.event.application)
      .toEqual({ name: "msedge", bundleId: "win32.msedge" });
  });

  it("replays each demonstrated page step once and names its key", () => {
    const browser = (action: string, offset: number, extra: Record<string, unknown> = {}) => prepareBrowserHistoryEvent({ ...payload(),
      eventId: `event-${action}-${offset}`, observedAt: now + offset, action, ...extra }, context, intent, now + offset, "darwin")!.event;
    const native = (eventType: string, offset: number, details: Record<string, unknown> = {}) => ({ eventType,
      timestamp: new Date(now + offset).toISOString(), application: browser("change", 0).application, details });
    const typed = browser("input", 0, { target: { role: "textbox", name: "Company", value: "Fixture" } });
    const committed = browser("change", 600, { target: { role: "textbox", name: "Company", value: "Fixture" } });
    const enter = browser("key", 900, { key: "Enter", target: { role: "textbox", name: "Company" } });
    const submitted = browser("submit", 1_100, { target: { role: "form", name: "" } });
    const scrolled = browser("scroll", 1_200, { target: undefined });
    const steps = reusableHumanActions([native("text_input", 50, { text: "Fixture" }), typed, committed,
      native("key_press", 905, { keys: ["Enter"] }), enter, submitted, scrolled, native("mouse_click", 20_000, {})]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("input on textbox Company");
    expect(steps[1]).toContain("key Enter on textbox Company");
    expect(steps[2]).toContain("an element was activated");
  });

  it("rejects stopped, private, unknown privacy, protected, stale-document and stale-generation observations", () => {
    expect(prepareBrowserHistoryEvent(payload(), context, { ...intent, enabled: false }, now)).toBeNull();
    for (const privateBrowsing of [true, null]) expect(prepareBrowserHistoryEvent(payload(), { ...context, privateBrowsing }, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent(payload(), { ...context, protected: true }, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent({ ...payload(), documentId: "old-document" }, context, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent({ ...payload(), generation: "paused-recording" }, context, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent({ ...payload(), observedAt: now - 16000 }, context, intent, now)).toBeNull();
  });

  it("checks excluded iframe sites and refuses page-claimed cross-origin before/after content", () => {
    const excluded = { ...intent, settings: { ...intent.settings!, observation: { ...intent.settings!.observation,
      rules: [{ scope: "url" as const, urlDomain: "private.test", behavior: "do_not_observe" as const }] } } };
    expect(prepareBrowserHistoryEvent(payload(), { ...context, frameUrl: "https://private.test/frame" }, excluded, now)).toBeNull();
    expect(prepareBrowserHistoryEvent({ ...payload(), after: { url: "https://another.test/secret" } }, context, intent, now)).toBeNull();
  });

  it("refuses an event from a frame nested inside an excluded site's iframe", () => {
    const excluded = { ...intent, settings: { ...intent.settings!, observation: { ...intent.settings!.observation,
      rules: [{ scope: "url" as const, urlDomain: "private.test", behavior: "do_not_observe" as const }] } } };
    const nested = { ...context, frameUrl: "https://widget.test/embed", ancestorOrigins: ["https://private.test", "https://example.test"] };
    expect(prepareBrowserHistoryEvent(payload(), nested, excluded, now)).toBeNull();
    expect(prepareBrowserHistoryEvent(payload(), { ...nested, ancestorOrigins: ["null", "https://example.test"] }, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent(payload(), { ...nested, ancestorOrigins: ["https://shop.test", "https://example.test"] }, excluded, now)!
      .event.details).toMatchObject({ url: "https://example.test/form", frameUrl: "https://widget.test/embed" });
  });

  it("cannot turn isTrusted or DOM actor claims into human/agent provenance", () => {
    const claim = { ...payload(), actor: "human", isTrusted: true, commandId: "forged-command" };
    expect(prepareBrowserHistoryEvent(claim, context, intent, now)!.event.details.actor).toBe("unknown");
    expect(prepareBrowserHistoryEvent(claim, { ...context, actorEvidence: { kind: "memmy_command", commandId: "command-1" } }, intent, now)!.event.details)
      .toMatchObject({ actor: "agent", commandId: "command-1" });
    expect(prepareBrowserHistoryEvent(claim, { ...context, actorEvidence: { kind: "native_input", eventId: "native-1" } }, intent, now)!.event.details.actor).toBe("human");
  });

  it("redacts sensitive values and text both before and after without retaining arbitrary DOM fields", () => {
    const event = { ...payload(), action: "input", target: { role: "textbox", name: "Code", autocomplete: "one-time-code", value: "123456" },
      before: { target: { value: "654321" }, text: ["123456"] }, after: { target: { value: "123456" }, text: ["654321"] }, html: "raw-private-html" };
    const serialized = JSON.stringify(prepareBrowserHistoryEvent(event, context, intent, now));
    for (const secret of ["123456", "654321", "raw-private-html", "token=secret"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    const textDisabled = prepareBrowserHistoryEvent({ ...payload(), target: { value: "unapproved-text" }, after: { text: ["unapproved-text"] } },
      context, { ...intent, captureText: false }, now)!;
    expect(JSON.stringify(textDisabled)).not.toContain("unapproved-text");
    const adjacent = prepareBrowserHistoryEvent({ ...payload(), after: { text: ["验证码：654321", "OTP 123456", "password=never-persist"] } }, context, intent, now)!;
    for (const secret of ["654321", "123456", "never-persist"]) expect(JSON.stringify(adjacent)).not.toContain(secret);
  });

  it("rejects oversized or malformed data and preserves actor/state evidence in model and retention summaries", () => {
    expect(prepareBrowserHistoryEvent({ ...payload(), target: { value: "x".repeat(4001) } }, context, intent, now)).toBeNull();
    expect(prepareBrowserHistoryEvent({ ...payload(), after: { text: [false] } }, context, intent, now)).toBeNull();
    const event = prepareBrowserHistoryEvent(payload(), context, intent, now)!.event;
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence([JSON.stringify(event)], { purpose });
      expect(evidence).toContain("unknown actor");
      expect(evidence).toContain('"checked":false');
      expect(evidence).toContain('"checked":true');
      expect(evidence).toContain("1 row selected");
    }
  });

  it("separates an unconfirmed attempt from page context and collapses a paired checkbox interaction", () => {
    const attempted = { ...payload(), eventId: "attempt-1", action: "click", phase: "attempt", interactionId: "interaction-1",
      before: { url: context.url, target: { checked: false } }, after: undefined };
    const observed = { ...payload(), eventId: "observed-1", phase: "observed", interactionId: "interaction-1" };
    const pageContext = { ...payload(), eventId: "context-1", action: "navigation", phase: "context", target: undefined,
      before: undefined, after: { url: context.url, title: "Form" } };
    const attemptEvent = prepareBrowserHistoryEvent(attempted, context, intent, now)!.event;
    const observedEvent = prepareBrowserHistoryEvent(observed, context, intent, now)!.event;
    const contextEvent = prepareBrowserHistoryEvent(pageContext, context, intent, now)!.event;
    expect(attemptEvent.details).toMatchObject({ phase: "attempt", interactionId: "interaction-1" });
    expect(attemptEvent.details).not.toHaveProperty("after");
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence([attemptEvent, contextEvent].map(event => JSON.stringify(event)), { purpose });
      expect(evidence).toContain("outcome unconfirmed");
      expect(evidence).toContain("navigation causation unconfirmed");
    }
    expect(reusableHumanActions([attemptEvent])[0]).toContain("attempt, outcome unconfirmed");
    const steps = reusableHumanActions([attemptEvent, observedEvent, contextEvent, observedEvent]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("checked=true");
    expect(steps[0]).not.toContain("attempt, outcome unconfirmed");
    expect(reusableHumanActions([contextEvent])).toEqual([]);
    for (const bad of [{ ...attempted, after: { url: context.url } }, { ...attempted, before: undefined },
      { ...attempted, action: "input" }, { ...pageContext, action: "click" }, { ...pageContext, after: {} },
      { ...observed, phase: "completed" }, { ...observed, interactionId: "invalid/id" }]) {
      expect(prepareBrowserHistoryEvent(bad, context, intent, now)).toBeNull();
    }
    for (const event of [attempted, pageContext]) {
      expect(prepareBrowserHistoryEvent(event, context, { ...intent, enabled: false }, now)).toBeNull();
      expect(prepareBrowserHistoryEvent(event, { ...context, privateBrowsing: null }, intent, now)).toBeNull();
      expect(prepareBrowserHistoryEvent(event, { ...context, protected: true }, intent, now)).toBeNull();
    }
  });

  it("keeps an unknown-actor demonstration usable with browser tools and chooses surface per mixed workflow gate", () => {
    const prepared = prepareBrowserHistoryEvent(payload(), context, intent, now)!.event;
    const steps = reusableHumanActions([prepared]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("unknown");
    expect(steps[0]).toContain("checked=true");
    const history = { id: "browser-demo", title: "Select a row", filePath: "/tmp/history.md" } as ComputerHistoryEntry;
    const browserWorkflow = buildRecordedExperienceWorkflow({ history, request: "Repeat the recorded selection", steps });
    expect(browserWorkflow).toContain("Execution surface: browser");
    expect(browserWorkflow).toContain("Browser gates use Memmy browser tools");
    expect(browserWorkflow).not.toContain("explicit human demonstration");
    expect(browserWorkflow).not.toContain("Use only the Memmy Computer Use MCP tools");
    const mixed = buildRecordedExperienceWorkflow({ history, request: "Repeat", steps: [...steps, "Activate Notes and inspect its window"] });
    expect(mixed).toContain("Execution surface: browser");
    expect(mixed).toContain("Execution surface: desktop");
    expect(mixed).toContain("Choose the executor from each gate's surface");
    const agent = prepareBrowserHistoryEvent(payload(), { ...context, actorEvidence: { kind: "memmy_command", commandId: "command-1" } }, intent, now)!.event;
    expect(reusableHumanActions([agent])).toEqual([]);
  });

  it("records without an Agent chat, deduplicates and invalidates old capture intents on pause/resume/settings changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-history-")); roots.push(root);
    const recorderScript = path.join(root, "stub-recorder.mjs");
    fs.writeFileSync(recorderScript, "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);");
    const settings = path.join(root, "settings.json");
    const service = new ComputerHistoryDemoService({ recorderScript, observationSettingsFile: settings,
      historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"), workflowDirectory: path.join(root, "workflows") });
    services.push(service);
    expect(service.getBrowserCaptureIntent().enabled).toBe(false);
    const started = service.startObservation(), capture = service.getBrowserCaptureIntent();
    const event = { ...payload(), observedAt: Date.now(), generation: capture.generation };
    expect(service.ingestBrowserSemanticEvent(event, context)).toBe(true);
    expect(service.ingestBrowserSemanticEvent(event, context)).toBe(false);
    const file = path.join(root, "recordings", "segments", started.observation.segmentId!, "events.jsonl");
    expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    await service.pauseObservation();
    expect(service.getBrowserCaptureIntent().enabled).toBe(false);
    expect(service.ingestBrowserSemanticEvent({ ...event, eventId: "event-2" }, context)).toBe(false);
    service.resumeObservation();
    expect(service.getBrowserCaptureIntent().generation).not.toBe(capture.generation);
    expect(service.ingestBrowserSemanticEvent({ ...event, eventId: "event-2" }, context)).toBe(false);
    fs.writeFileSync(settings, "{malformed-policy");
    expect(service.getBrowserCaptureIntent().enabled).toBe(false);
  });
});

describe("passive browser History sensor", () => {
  it("records standard ARIA checked/selected state when native properties are absent", () => {
    const handlers = new Map<string, (event: any) => void>(), scheduled: Array<() => void> = [], sent: any[] = [];
    const sandbox = vm.createContext({ location: { href: "https://example.test/form" }, document: { title: "Form" }, URL,
      AbortController, __memmyBrowserHistory: (value: string) => sent.push(JSON.parse(value)),
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; }, clearTimeout: () => undefined });
    vm.runInContext(browserHistorySensorScript({ generation: "recording-1", documentId: "document-1", captureText: true }), sandbox);
    for (const role of ["checkbox", "radio", "option", "tabpanel"]) {
      const attributes: Record<string, string> = { role, "aria-checked": "false", "aria-selected": "false", "aria-expanded": "false" };
      const element = { nodeType: 1, tagName: "DIV", innerText: "Custom control",
        getAttribute: (name: string) => attributes[name] ?? null, hasAttribute: (name: string) => name in attributes };
      handlers.get("pointerdown")!({ isTrusted: true, target: element });
      expect(sent.at(-1).before.target).toMatchObject({ role, checked: false, selected: false, expanded: false });
      attributes["aria-checked"] = "true"; attributes["aria-selected"] = "true"; attributes["aria-expanded"] = "true";
      handlers.get("click")!({ isTrusted: true, target: element }); scheduled.shift()!();
      expect(sent.at(-1).after.target).toMatchObject({ role, checked: true, selected: true, expanded: true });
      const nativeElement = { ...element, checked: false, selected: false };
      handlers.get("click")!({ isTrusted: true, target: nativeElement }); scheduled.shift()!();
      expect(sent.at(-1).after.target).toMatchObject({ checked: false, selected: false });
    }
  });

  it("publishes pointer and Enter attempts synchronously before deferred observations", () => {
    const handlers = new Map<string, (event: any) => void>(), scheduled: Array<() => void> = [], sent: any[] = [];
    const sandbox = vm.createContext({ location: { href: "https://example.test/form?secret=hidden" }, document: { title: "Form" }, URL,
      AbortController, __memmyBrowserHistory: (value: string) => sent.push(JSON.parse(value)),
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; }, clearTimeout: () => undefined });
    vm.runInContext(browserHistorySensorScript({ generation: "recording-1", documentId: "document-1", captureText: true }), sandbox);
    const element = { nodeType: 1, tagName: "BUTTON", innerText: "Continue", getAttribute: () => null, hasAttribute: () => false };
    expect(sent).toHaveLength(1);
    handlers.get("pointerdown")!({ isTrusted: true, target: element });
    expect(sent[1]).toMatchObject({ action: "click", phase: "attempt", before: { url: "https://example.test/form" } });
    expect(sent[1]).not.toHaveProperty("after");
    expect(scheduled).toHaveLength(0);
    handlers.get("click")!({ isTrusted: true, target: element }); scheduled.shift()!();
    expect(sent[2]).toMatchObject({ action: "click", phase: "observed", interactionId: sent[1].interactionId });
    handlers.get("keydown")!({ isTrusted: true, target: element, key: "Enter" });
    expect(sent[3]).toMatchObject({ action: "key", phase: "attempt", key: "Enter" });
    expect(sent[3]).not.toHaveProperty("after");
    vm.runInContext(browserHistorySensorStopScript, sandbox);
    scheduled.shift()!(); expect(sent).toHaveLength(4);
  });

  it("skips neighboring secret, script and hidden text before reading values", () => {
    const handlers = new Map<string, (event: any) => void>(), scheduled: Array<() => void> = [], sent: string[] = [];
    const password = { type: "password", name: "password", id: "password", autocomplete: "current-password", getAttribute: () => null,
      get value() { throw Error("Password must never be read"); } };
    const scope = { tagName: "FORM", getAttribute: () => null, hasAttribute: () => false };
    const visible = { tagName: "SPAN", parentElement: scope, getClientRects: () => [{}], getAttribute: () => null, hasAttribute: () => false };
    const blocked = [Object.create(visible, Object.getOwnPropertyDescriptors(password)), { ...visible, tagName: "SCRIPT" }, { ...visible, hidden: true }];
    const secretNodes = blocked.map(parentElement => ({ parentElement, get nodeValue() { throw Error("Hidden/secret text must never be read"); } }));
    const document = { title: "Form", createTreeWalker: () => { const nodes = [...secretNodes, { parentElement: visible, nodeValue: "1 row selected" }];
      return { nextNode: () => nodes.shift() }; }, createRange: () => ({ selectNodeContents: () => undefined,
        getClientRects: () => [{ width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }] }) };
    const element = { nodeType: 1, tagName: "BUTTON", innerText: "Select", getAttribute: () => null,
      hasAttribute: () => false, closest: () => scope };
    const sandbox = vm.createContext({ location: { href: "https://example.test/" }, document, URL, AbortController,
      innerHeight: 800, innerWidth: 1000, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      __memmyBrowserHistory: (value: string) => sent.push(value),
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; }, clearTimeout: () => undefined });
    vm.runInContext(browserHistorySensorScript({ generation: "recording-1", documentId: "document-1", captureText: true }), sandbox);
    handlers.get("click")!({ isTrusted: true, target: element });
    scheduled.shift()!();
    expect(JSON.parse(sent[0])).toMatchObject({ phase: "context", action: "navigation" });
    expect(sent[1]).toContain("1 row selected");
    handlers.get("input")!({ isTrusted: true, target: Object.create(element, Object.getOwnPropertyDescriptors(password)) });
    scheduled.shift()!();
    // The password control itself is excluded without evaluating its value getter.
    expect(sent).toHaveLength(3);
  });

  it("never emits password/OTP values and removes pending observations when stopped", () => {
    const handlers = new Map<string, (event: any) => void>(), scheduled = new Map<number, () => void>(), sent: string[] = [];
    let timerId = 0;
    const sandbox = vm.createContext({ location: { href: "https://example.test/?token=hidden" }, document: { title: "Form" }, URL,
      AbortController, crypto: { randomUUID: () => "sensor-event" },
      __memmyBrowserHistory: (value: string) => sent.push(value),
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      setTimeout: (callback: () => void) => { scheduled.set(++timerId, callback); return timerId; },
      clearTimeout: (id: number) => scheduled.delete(id) });
    vm.runInContext(browserHistorySensorScript({ generation: "recording-1", documentId: "document-1", captureText: true }), sandbox);
    const element = { nodeType: 1, tagName: "INPUT", type: "password", name: "password", id: "password", autocomplete: "current-password",
      value: "never-raw-password", getAttribute: () => null, hasAttribute: () => false,
      closest: () => ({ innerText: "never-raw-password" }) };
    handlers.get("input")!({ isTrusted: true, target: element });
    for (const callback of [...scheduled.values()]) callback(); scheduled.clear();
    expect(sent).toHaveLength(2);
    expect(sent.join("\n")).not.toContain("never-raw-password");
    expect(sent.join("\n")).not.toContain("token=hidden");
    element.type = "text"; element.name = "code"; element.id = "code"; element.autocomplete = "one-time-code"; element.value = "987654";
    handlers.get("input")!({ isTrusted: true, target: element });
    for (const callback of [...scheduled.values()]) callback(); scheduled.clear();
    expect(sent[2]).not.toContain("987654");
    handlers.get("click")!({ isTrusted: true, target: element });
    vm.runInContext(browserHistorySensorStopScript, sandbox);
    expect(scheduled.size).toBe(0);
  });
});
