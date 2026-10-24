import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalBrowserBridge, MEMMY_BROWSER_EXTENSION_ID } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { connectBrowserHistoryBridge } from "../../../../src/tools/computer-history/browser-history-bridge.js";
import { browserHistorySensorScript } from "../../../../src/tools/computer-history/browser-history-sensor.js";
import { getPlaywrightBrowsersPath } from "../../../../src/core/agent-runtime/tools/browser-setup.js";
import { reusableHumanActions } from "../../../../src/tools/computer-history/mac/summarize-history.js";

const resources: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });

async function syntheticPage() {
  const { chromium } = await import("playwright");
  const browserDirectory = getPlaywrightBrowsersPath();
  const shellFolder = fs.readdirSync(browserDirectory).find(name => name.startsWith("chromium_headless_shell-"));
  if (!shellFolder) throw new Error("Synthetic History fixture requires the prepared Chromium headless shell");
  const directory = path.join(browserDirectory, shellFolder);
  const platformFolder = fs.readdirSync(directory).find(name => name.startsWith("chrome-headless-shell-"))!;
  const executablePath = path.join(directory, platformFolder, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
  const browser = await chromium.launch({ headless: true, executablePath }); resources.push(() => browser.close());
  return browser.newPage();
}

async function harness(browser: "chrome" | "edge" = "chrome") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-integration-"));
  resources.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorder = path.join(root, "stub-recorder.mjs"), settingsFile = path.join(root, "settings.json");
  fs.writeFileSync(recorder, "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);");
  const service = new ComputerHistoryDemoService({ recorderScript: recorder, observationSettingsFile: settingsFile,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"), workflowDirectory: path.join(root, "workflows") });
  resources.push(() => service.shutdown());
  const bridge = new ExternalBrowserBridge(); resources.push(() => bridge.close());
  const connection = connectBrowserHistoryBridge(service, bridge); resources.push(() => connection.close());
  const { port } = await bridge.start(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}` });
  resources.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const messages: any[] = []; socket.on("message", value => messages.push(JSON.parse(String(value))));
  socket.send(JSON.stringify({ type: "hello", browser, capabilities: ["browserHistory", "playwright"] }));
  await vi.waitFor(() => expect(messages.some(message => message.type === "ready")).toBe(true));
  const connectionId = messages.find(message => message.type === "ready").connectionId;
  const started = service.startObservation(); connection.refresh();
  const eventsFile = path.join(root, "recordings", "segments", started.observation.segmentId!, "events.jsonl");
  const context = { browser, tabId: 7, windowId: 8, frameId: 0, documentId: "fixture-document",
    topUrl: "https://history-fixture.test/form", frameUrl: "https://history-fixture.test/form", privateBrowsing: false, protected: false };
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
  const records = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const payload = (id: string) => ({ version: 1, eventId: id, observedAt: Date.now(), generation: service.getBrowserCaptureIntent().generation,
    documentId: context.documentId, action: "change", target: { role: "checkbox", name: "Selected row", checked: true },
    before: { target: { checked: false } }, after: { target: { checked: true }, text: ["One row selected"] } });
  const emit = (event: any, extra: Record<string, unknown> = {}) => send({ type: "browser_history", ...context,
    generation: event.generation, actor: "human", payload: event, ...extra });
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
  return { service, bridge, socket, connection, connectionId, messages, context, payload, emit, records, send, settle, settingsFile };
}

describe("browser History bridge to canonical event stream", () => {
  it.each(["chrome", "edge"] as const)("records %s semantics without an Agent claim and rejects revoked/private/protected capture", async browser => {
    const h = await harness(browser);
    expect(h.bridge.listClaims()).toEqual([]);
    h.send({ type: "browser_history_config_request", id: "request-1", ...h.context });
    await vi.waitFor(() => expect(h.messages.find(message => message.id === "request-1")?.enabled).toBe(true));
    const event = h.payload("event-1"); h.emit(event);
    await vi.waitFor(() => expect(h.records()).toHaveLength(1));
    expect(h.records()[0].details).toMatchObject({ source: "browser_history", actor: "unknown", before: { target: { checked: false } },
      after: { target: { checked: true } } });
    h.emit(event); await h.settle(); expect(h.records()).toHaveLength(1);
    for (const extra of [{ privateBrowsing: true }, { privateBrowsing: null }, { protected: true }, { browser: browser === "chrome" ? "edge" : "chrome" }]) {
      h.emit(h.payload("forbidden-" + Math.random()), extra);
    }
    await h.settle(); expect(h.records()).toHaveLength(1);
    await h.service.pauseObservation(); h.emit(event); await h.settle(); expect(h.records()).toHaveLength(1);
    h.service.resumeObservation(); h.emit({ ...event, eventId: "late-event" }); await h.settle(); expect(h.records()).toHaveLength(1);
    const settings = JSON.parse(fs.readFileSync(h.settingsFile, "utf8"));
    settings.observation.rules.push({ scope: "url", urlDomain: "history-fixture.test", behavior: "do_not_observe" });
    fs.writeFileSync(h.settingsFile, JSON.stringify(settings));
    h.emit(h.payload("excluded-event")); await h.settle(); expect(h.records()).toHaveLength(1);
  });

  it("keeps frames nested inside an excluded site's iframe, and subframes without ancestry, out of History", async () => {
    const h = await harness();
    const settings = JSON.parse(fs.readFileSync(h.settingsFile, "utf8"));
    settings.observation.rules.push({ scope: "url", urlDomain: "bank.test", behavior: "do_not_observe" });
    fs.writeFileSync(h.settingsFile, JSON.stringify(settings));
    const top = new URL(h.context.topUrl).origin;
    const frame = (documentId: string, extra: Record<string, unknown> = {}) => ({ frameId: 4, documentId, frameUrl: "https://widget.test/embed", ...extra });
    const refused = [frame("inside-excluded", { ancestorOrigins: ["https://bank.test", top] }), frame("old-extension"),
      frame("unrooted", { ancestorOrigins: ["https://shop.test"] }), frame("opaque", { ancestorOrigins: ["null", top] }),
      { documentId: "top-with-ancestors", ancestorOrigins: [top] }];
    const allowed = frame("allowed-nested", { ancestorOrigins: ["https://shop.test", top] });
    for (const [index, fields] of [...refused, allowed].entries()) {
      h.send({ type: "browser_history_config_request", id: `nested-${index}`, ...h.context, ...fields });
      h.emit({ ...h.payload(`nested-event-${index}`), documentId: fields.documentId }, fields);
    }
    const replies = () => h.messages.filter(message => message.type === "browser_history_config").map(message => message.enabled);
    await vi.waitFor(() => expect(replies()).toHaveLength(refused.length + 1));
    expect(replies()).toEqual([...refused.map(() => false), true]);
    await vi.waitFor(() => expect(h.records()).toHaveLength(1));
    await h.settle(); expect(h.records()).toHaveLength(1);
    expect(h.records()[0].details).toMatchObject({ eventId: `nested-event-${refused.length}`, documentId: "allowed-nested",
      frameUrl: "https://widget.test/embed" });
  });

  it("accepts actor=agent only for the same connection/tab's dispatched input command", async () => {
    const h = await harness();
    h.emit(h.payload("forged-actor"), { actorEvidence: { kind: "memmy_command", commandId: "nonexistent" } });
    await vi.waitFor(() => expect(h.records()).toHaveLength(1));
    expect(h.records()[0].details.actor).toBe("unknown");
    h.send({ type: "claim", browser: "chrome", tabId: 7, title: "Fixture", url: h.context.topUrl });
    await vi.waitFor(() => expect(h.bridge.listClaims()).toHaveLength(1));
    const work = h.bridge.command({ connectionId: h.connectionId, tabId: 7 }, "playwrightCdp", { method: "Input.dispatchMouseEvent" });
    await vi.waitFor(() => expect(h.messages.some(message => message.type === "command")).toBe(true));
    const command = h.messages.find(message => message.type === "command");
    h.emit(h.payload("agent-input"), { actorEvidence: { kind: "memmy_command", commandId: command.id } });
    h.send({ type: "response", id: command.id, ok: true, result: {} }); await work;
    await vi.waitFor(() => expect(h.records()).toHaveLength(2));
    expect(h.records()[1].details).toMatchObject({ actor: "agent", commandId: command.id });
    h.emit(h.payload("wrong-tab"), { tabId: 9, actorEvidence: { kind: "memmy_command", commandId: command.id } });
    await vi.waitFor(() => expect(h.records()).toHaveLength(3));
    expect(h.records()[2].details.actor).toBe("unknown");
  });

  it.each(["failed", "cancelled"] as const)("does not attribute a subsequent manual event to a %s input command", async outcome => {
    const h = await harness();
    h.send({ type: "claim", browser: "chrome", tabId: 7, title: "Fixture", url: h.context.topUrl });
    await vi.waitFor(() => expect(h.bridge.listClaims()).toHaveLength(1));
    const controller = new AbortController();
    const work = h.bridge.command({ connectionId: h.connectionId, tabId: 7 }, "playwrightCdp",
      { method: "Input.dispatchMouseEvent" }, controller.signal);
    const rejected = expect(work).rejects.toThrow(outcome === "failed" ? /input failed/ : /cancelled/);
    await vi.waitFor(() => expect(h.messages.some(message => message.type === "command")).toBe(true));
    const command = h.messages.find(message => message.type === "command");
    if (outcome === "failed") h.send({ type: "response", id: command.id, ok: false, error: "input failed" });
    else controller.abort();
    await rejected;
    h.emit(h.payload("manual-after-rejected-input"), { actorEvidence: { kind: "memmy_command", commandId: command.id } });
    await vi.waitFor(() => expect(h.records()).toHaveLength(1));
    expect(h.records()[0].details.actor).toBe("unknown");
  });

  it("records a held key once, ignores pages scrolling themselves, bounds text and masks card numbers", async () => {
    const h = await harness();
    const page = await syntheticPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<main id="feed" style="height:120px;overflow:auto">
      <div style="height:4000px">Live feed</div></main><section id="article">${"Long article text. ".repeat(50_000)}</section>
      <input id="note" aria-label="Note"><label>Card number<input name="cardNumber"></label>
      <p role="status">Paid with 4111 1111 1111 1111</p>` }));
    await page.goto(h.context.topUrl);
    await page.exposeFunction("__memmyFixturePublish", (encoded: string) => h.emit(JSON.parse(encoded)));
    await page.evaluate(browserHistorySensorScript({ generation: h.service.getBrowserCaptureIntent().generation!,
      documentId: h.context.documentId, captureText: true, bindingName: "__memmyFixturePublish" }));
    await page.evaluate("document.querySelector('#feed').scrollTop = 600");
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.records().filter(event => event.details.action === "scroll")).toHaveLength(0);
    await page.focus("#note");
    for (let index = 0; index < 8; index++) await page.keyboard.down("ArrowDown");
    await page.keyboard.up("ArrowDown");
    await vi.waitFor(() => expect(h.records().some(event => event.details.key === "ArrowDown")).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(h.records().filter(event => event.details.key === "ArrowDown")).toHaveLength(1);
    await page.click("#article", { position: { x: 4, y: 4 } });
    await vi.waitFor(() => expect(h.records().some(event => event.details.action === "click" && event.details.phase === "observed")).toBe(true));
    const article = h.records().find(event => event.details.action === "click" && event.details.phase === "observed");
    expect(article.details.target.name.length).toBeLessThanOrEqual(200);
    await page.fill("input[name=cardNumber]", "4111 1111 1111 1111");
    await vi.waitFor(() => expect(h.records().some(event => event.details.action === "input")).toBe(true));
    expect(JSON.stringify(h.records())).not.toContain("4111 1111 1111 1111");
  }, 20_000);

  it("captures actual checkbox/input transitions from a synthetic headless Chromium page without an Agent session", async () => {
    const h = await harness();
    const page = await syntheticPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<form><label>Selected row<input type="checkbox"></label>
      <label>Company<input placeholder="Company"></label><p role="status">No rows selected</p>
      <p hidden>hidden-business-secret</p><script type="application/json">{"token":"script-only-secret"}</script>
      <style>.secret-example {content:'style-only-secret'}</style>
      <input type="password" value="never-raw-password"><input autocomplete="one-time-code" value="123456"></form>
      <script>document.querySelector('input[type=checkbox]').addEventListener('change',e=>document.querySelector('[role=status]').textContent=e.target.checked?'One row selected':'No rows selected')</script>` }));
    await page.goto(h.context.topUrl);
    await page.exposeFunction("__memmyFixturePublish", (encoded: string) => h.emit(JSON.parse(encoded)));
    await page.evaluate(browserHistorySensorScript({ generation: h.service.getBrowserCaptureIntent().generation!,
      documentId: h.context.documentId, captureText: true, bindingName: "__memmyFixturePublish" }));
    await page.getByRole("checkbox").check();
    await vi.waitFor(() => expect(h.records().some(event => event.details.target?.checked === true)).toBe(true));
    const checked = h.records().find(event => event.details.target?.checked === true);
    expect(h.records().filter(event => event.details.target?.role === "checkbox" && event.details.phase === "observed")).toHaveLength(1);
    expect(checked.details.action).toBe("change");
    expect(checked.details.before.target.checked).toBe(false);
    expect(checked.details.after.target.checked).toBe(true);
    expect(checked.details.after.text).toContain("One row selected");
    const checkboxAttempt = h.records().find(event => event.details.phase === "attempt" && event.details.target?.role === "checkbox");
    expect(checkboxAttempt.details.interactionId).toBe(checked.details.interactionId);
    expect(reusableHumanActions(h.records()).filter(step => step.includes("checkbox"))).toHaveLength(1);
    await page.getByPlaceholder("Company").fill("Fixture Company");
    await vi.waitFor(() => expect(h.records().some(event => event.details.action === "input")).toBe(true));
    expect(h.records().find(event => event.details.action === "input").details.after.target.value).toBe("Fixture Company");
    const evidence = JSON.stringify(h.records());
    for (const secret of ["hidden-business-secret", "script-only-secret", "style-only-secret", "never-raw-password", "123456"]) expect(evidence).not.toContain(secret);
    expect(h.bridge.listClaims()).toEqual([]);
    await h.service.pauseObservation();
    const count = h.records().length; await page.getByRole("checkbox").uncheck();
    await new Promise(resolve => setTimeout(resolve, 250)); expect(h.records()).toHaveLength(count);
  }, 15_000);

  it("retains pre-navigation attempts and new document context for real link and form navigation", async () => {
    const h = await harness(), page = await syntheticPage();
    await page.route("**/*", route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: "text/html", body: pathname === "/form"
        ? '<title>Start</title><main><a href="/next?token=do-not-retain">Next page</a></main>'
        : pathname === "/next" ? '<title>Form</title><form action="/submitted" method="get"><input name="query" value="fixture"><button type="submit">Submit form</button></form>'
          : '<title>Result</title><main>Submitted fixture</main>' });
    });
    await page.exposeFunction("__memmyFixturePublish", (encoded: string) => h.emit(JSON.parse(encoded)));
    await page.goto(h.context.topUrl);
    const authorizeCurrentDocument = async (documentId: string) => {
      h.context.documentId = documentId; h.context.topUrl = page.url(); h.context.frameUrl = page.url();
      await page.evaluate(browserHistorySensorScript({ generation: h.service.getBrowserCaptureIntent().generation ?? "disabled-recording",
        documentId, captureText: true, bindingName: "__memmyFixturePublish" }));
    };
    const pointerActivate = async (role: "link" | "button", name: string) => {
      const bounds = await page.getByRole(role, { name }).boundingBox();
      if (!bounds) throw new Error("Fixture target is not visible");
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      // A normal short pointer hold, without changing or delaying the fixture's navigation handlers.
      await new Promise(resolve => setTimeout(resolve, 80));
      await page.mouse.up();
    };
    await authorizeCurrentDocument("link-document");
    await pointerActivate("link", "Next page"); await page.waitForURL("**/next?token=do-not-retain");
    await authorizeCurrentDocument("form-document");
    await pointerActivate("button", "Submit form"); await page.waitForURL("**/submitted?query=fixture");
    await authorizeCurrentDocument("result-document");
    await vi.waitFor(() => expect(h.records().filter(event => event.details.phase === "context")).toHaveLength(3));
    const attempts = h.records().filter(event => event.details.phase === "attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts.map(event => event.details)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "click", documentId: "link-document", before: expect.objectContaining({ url: "https://history-fixture.test/form" }), target: expect.objectContaining({ role: "link", name: "Next page" }) }),
      expect.objectContaining({ action: "click", documentId: "form-document", before: expect.objectContaining({ url: "https://history-fixture.test/next" }), target: expect.objectContaining({ role: "button", name: "Submit form" }) }),
    ]));
    for (const attempt of attempts) expect(attempt.details).not.toHaveProperty("after");
    expect(h.records().filter(event => event.details.phase === "context").map(event => event.details.after.url))
      .toEqual(["https://history-fixture.test/form", "https://history-fixture.test/next", "https://history-fixture.test/submitted"]);
    expect(h.records().every(event => event.details.actor === "unknown")).toBe(true);
    expect(h.records().filter(event => event.details.phase === "observed")).toHaveLength(0);
    expect(reusableHumanActions(h.records())).toHaveLength(2);
    expect(reusableHumanActions(h.records()).every(step => step.includes("attempt, outcome unconfirmed"))).toBe(true);
    expect(JSON.stringify(h.records())).not.toContain("do-not-retain");
    expect(h.bridge.listClaims()).toEqual([]);
    await h.service.pauseObservation();
    const count = h.records().length;
    await authorizeCurrentDocument("paused-document"); await h.settle();
    expect(h.records()).toHaveLength(count);
    h.service.resumeObservation();
    const settings = JSON.parse(fs.readFileSync(h.settingsFile, "utf8"));
    settings.observation.rules.push({ scope: "url", urlDomain: "history-fixture.test", behavior: "do_not_observe" });
    fs.writeFileSync(h.settingsFile, JSON.stringify(settings));
    await authorizeCurrentDocument("excluded-document"); await h.settle();
    expect(h.records()).toHaveLength(count);
  }, 15_000);
});
