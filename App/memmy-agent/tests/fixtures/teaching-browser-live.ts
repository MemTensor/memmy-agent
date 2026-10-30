/** Manual Windows/macOS acceptance. Bundle with esbuild; run against an installed Chrome/Edge.
 * Uses an isolated test profile containing both an everyday window and the new teaching window.
 * The production path continues to use the user's existing profile and installed extension.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { ExternalBrowserBridge } from "../../src/core/agent-runtime/tools/external-browser-bridge.js";
import { createBrowserCaptureProvider } from "../../src/tools/computer-history/browser-event-capture.js";
import { PluginEventSessions } from "../../src/tools/plugin-host/event-sessions.js";

const [browserName, executable, extensionSource, output, detachHelper] = process.argv.slice(2);
assert(browserName === "chrome" || browserName === "edge"); assert(executable && extensionSource && output);
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), `memmy-teach-${browserName}-`));
const extension = path.join(temp, "extension"); fs.cpSync(extensionSource, extension, { recursive: true });
const bridge = new ExternalBrowserBridge();
const service = new PluginEventSessions({ dataRoot: path.join(temp, "data"),
  source: { acquireEventCapture: async () => { throw Error("Browser-only capture acquired desktop History"); } },
  browser: createBrowserCaptureProvider(bridge, { settingsFile: path.join(temp, "settings.json") }) });
const server = http.createServer((req, res) => {
  if (req.url === "/daily") res.setHeader("Set-Cookie", "teach_test_login=retained; Path=/; SameSite=Lax");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>Teach acceptance ${req.url}</title></head><body style="padding:40px;font:18px sans-serif">
    <h1>Browser teaching fixture</h1><label>Topic <input id="topic" aria-label="Topic"></label><p>
    <label>Password <input id="password" type="password" aria-label="Password"></label></p>
    <p><button id="submit" onclick="document.getElementById('result').textContent='Submitted'">Submit</button></p>
    <p><a id="popup" href="/popup" target="_blank">Open popup</a> <a id="next" href="/next">Next page</a></p>
    <div id="result"></div></body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const { port } = await bridge.start(0);
const background = path.join(extension, "background.js");
fs.writeFileSync(background, fs.readFileSync(background, "utf8").replace(/const BRIDGE_PORTS = \[[^\]]+\]/, `const BRIDGE_PORTS = [${port}]`));
const child = spawn(executable, [`--user-data-dir=${path.join(temp, "profile")}`, "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-background-mode", `${url}/daily`],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let stderr = "", buffer = Buffer.alloc(0), nextId = 1;
child.stderr!.on("data", data => { stderr = (stderr + String(data)).slice(-6000); });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
child.stdio[4]!.on("data", (data: Buffer) => {
  buffer = Buffer.concat([buffer, data]);
  for (;;) {
    const zero = buffer.indexOf(0); if (zero < 0) break;
    const line = buffer.subarray(0, zero).toString(); buffer = buffer.subarray(zero + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  }
});
const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  (child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
});
const waitFor = async <T>(fn: () => T | Promise<T>, description: string): Promise<NonNullable<T>> => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value as NonNullable<T>; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${description}`);
};
const targets = async (): Promise<any[]> => (await cdp("Target.getTargets")).targetInfos;
const attach = async (target: any): Promise<string> => (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
async function evaluate(sessionId: string, expression: string) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function click(sessionId: string, selector: string) {
  await cdp("Page.bringToFront", {}, sessionId);
  const rect = await evaluate(sessionId, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect }, sessionId);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect }, sessionId);
}
async function type(sessionId: string, selector: string, text: string) { await click(sessionId, selector); await cdp("Input.insertText", { text }, sessionId); }
const report: Record<string, any> = { browser: browserName, platform: process.platform, checks: {}, temporaryProfile: temp };
try {
  report.version = await cdp("Browser.getVersion");
  await cdp("Extensions.loadUnpacked", { path: extension });
  await waitFor(() => bridge.listTeachingProfiles().length === 1, "extension connection");
  const daily = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url === `${url}/daily`), "daily page");
  const dailySession = await attach(daily);
  const worker = await waitFor(async () => (await targets()).find(target => target.type === "service_worker" && target.url.includes("/background.js")), "extension worker");
  const workerSession = await attach(worker);
  const before = new Set((await targets()).map(target => target.targetId));
  const recording = await service.start("teach-mode", "live-chat", "Teach browser fixture workflow", true, { name: browserName });
  assert.equal(recording.state, "recording");
  const teaching = await waitFor(async () => (await targets()).find(target => target.type === "page" && !before.has(target.targetId)), "teaching window");
  const teachingSession = await attach(teaching);
  await cdp("Page.navigate", { url: `${url}/teach` }, teachingSession);
  await waitFor(() => evaluate(teachingSession, "!!document.querySelector('#topic')"), "teaching document");
  await waitFor(() => evaluate(teachingSession, "!!document.querySelector('#memmy-teaching-recording')"), "recording badge");
  report.checks.loginStateRetained = await evaluate(teachingSession, "document.cookie.includes('teach_test_login=retained')");
  assert.equal(report.checks.loginStateRetained, true);
  await type(teachingSession, "#topic", "RECORDED_TOPIC");
  await type(teachingSession, "#password", "PASSWORD_MUST_NOT_APPEAR");
  await click(teachingSession, "#submit");
  await type(dailySession, "#topic", "DAILY_MUST_NOT_APPEAR");
  await click(teachingSession, "#popup");
  const popup = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url === `${url}/popup`), "popup");
  const popupSession = await attach(popup);
  await waitFor(() => evaluate(popupSession, "!!document.querySelector('#memmy-teaching-recording')"), "popup recorder");
  await type(popupSession, "#topic", "RECORDED_POPUP");
  const tabIds = await evaluate(workerSession, `(async()=>{const tabs=await chrome.tabs.query({});const teaching=tabs.find(t=>t.url===${JSON.stringify(`${url}/teach`)});const daily=tabs.find(t=>t.url===${JSON.stringify(`${url}/daily`)});return{teaching:teaching.id,teachingWindow:teaching.windowId,dailyWindow:daily.windowId}})()`);
  await evaluate(workerSession, `chrome.tabs.create({windowId:${tabIds.teachingWindow},url:${JSON.stringify(`${url}/spare`)},active:false})`);
  await evaluate(workerSession, `chrome.tabs.move(${tabIds.teaching},{windowId:${tabIds.dailyWindow},index:-1})`);
  await waitFor(async () => !(await evaluate(teachingSession, "!!document.querySelector('#memmy-teaching-recording')")), "tab removal revokes collector");
  await type(teachingSession, "#topic", "DRAGGED_OUT_MUST_NOT_APPEAR");
  await evaluate(workerSession, `chrome.tabs.move(${tabIds.teaching},{windowId:${tabIds.teachingWindow},index:-1})`);
  await waitFor(() => evaluate(teachingSession, "!!document.querySelector('#memmy-teaching-recording')"), "tab reentry recorder");
  await type(teachingSession, "#topic", "RECORDED_AFTER_REENTRY");
  await click(teachingSession, "#next");
  await waitFor(() => evaluate(teachingSession, "location.pathname==='/next' && !!document.querySelector('#memmy-teaching-recording')"), "recorder after navigation");
  await type(teachingSession, "#topic", "RECORDED_AFTER_NAVIGATION");
  // Exercise more than the old 15-second Computer Use idle-detach interval.
  await new Promise(resolve => setTimeout(resolve, 17000));
  report.checks.longRecordingLease = await evaluate(teachingSession, "!!document.querySelector('#memmy-teaching-recording')");
  await type(teachingSession, "#topic", "RECORDED_AFTER_IDLE");
  const recordingScreenshot = await cdp("Page.captureScreenshot", { format: "png" }, teachingSession);
  fs.writeFileSync(path.join(output, `${browserName}-recording.png`), Buffer.from(recordingScreenshot.data, "base64"));
  // Let the browser bindings drain before accepting the cutoff; stop itself also fences each document.
  await new Promise(resolve => setTimeout(resolve, 300));
  const ended = await service.stop("teach-mode", "live-chat", recording.id);
  report.session = ended;
  const file = path.join(temp, "data", "teach-mode", "event-sessions", recording.id, "events.jsonl");
  const evidence = fs.readFileSync(file, "utf8");
  const rawSource = fs.readFileSync(path.join(path.dirname(file), "browser-source.jsonl"), "utf8");
  report.checks.normalInput = evidence.includes("RECORDED_TOPIC");
  report.checks.popupInput = evidence.includes("RECORDED_POPUP");
  report.checks.navigationInput = evidence.includes("RECORDED_AFTER_NAVIGATION");
  report.checks.reentryInput = evidence.includes("RECORDED_AFTER_REENTRY");
  report.checks.idleInput = evidence.includes("RECORDED_AFTER_IDLE");
  report.checks.draggedOutExcluded = !evidence.includes("DRAGGED_OUT_MUST_NOT_APPEAR");
  report.checks.dailyWindowExcluded = !evidence.includes("DAILY_MUST_NOT_APPEAR");
  report.checks.passwordExcluded = !evidence.includes("PASSWORD_MUST_NOT_APPEAR");
  report.checks.rawSourceExcludesOutsideInputs = !/DAILY_MUST_NOT_APPEAR|PASSWORD_MUST_NOT_APPEAR|DRAGGED_OUT_MUST_NOT_APPEAR/.test(rawSource);
  await type(teachingSession, "#topic", "AFTER_STOP_MUST_NOT_APPEAR");
  await new Promise(resolve => setTimeout(resolve, 200));
  report.checks.snapshotImmutable = fs.readFileSync(file, "utf8") === evidence;
  report.checks.stoppedBadgeRemoved = !(await evaluate(teachingSession, "!!document.querySelector('#memmy-teaching-recording')"));
  for (const [name, passed] of Object.entries(report.checks)) assert.equal(passed, true, name);
  assert.equal(ended.availability, "available", ended.limitations.join("; "));
  fs.copyFileSync(file, path.join(output, `${browserName}-events.jsonl`));
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" }, teachingSession);
  fs.writeFileSync(path.join(output, `${browserName}-stopped.png`), Buffer.from(screenshot.data, "base64"));
  // A browser detach must end authority; a fresh extension connection cannot resume it.
  const beforeDetach = new Set((await targets()).map(target => target.targetId));
  const interrupted = await service.start("teach-mode", "detach-chat", "Check recording revocation", true, { name: browserName });
  const detachTarget = await waitFor(async () => (await targets()).find(target => target.type === "page" && !beforeDetach.has(target.targetId)), "detach teaching page");
  const detachSession = await attach(detachTarget);
  await cdp("Page.navigate", { url: `${url}/detach` }, detachSession);
  await waitFor(() => evaluate(detachSession, "!!document.querySelector('#memmy-teaching-recording')"), "detach recorder");
  // Extension-initiated debugger.detach does not exercise the user's cancel UI.
  // Use the native control and verify that its revocation actually ends capture.
  assert(process.platform === "win32" && detachHelper, "Windows user-detach helper required");
  report.userDetach = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", detachHelper,
    "-TestProfilePath", path.join(temp, "profile"), "-ExecutableName", path.basename(executable),
    "-Screenshot", path.join(output, `${browserName}-user-detach.png`), "-WindowTitle", "Teach acceptance /detach"], { encoding: "utf8", timeout: 15000 }));
  const failed = await waitFor(() => { const value = service.list("teach-mode", "detach-chat")[0]; return value?.state === "failed" ? value : null; }, "detach ends recording");
  report.checks.detachEndsRecording = failed.availability === "partial";
  await type(detachSession, "#topic", "AFTER_DETACH_MUST_NOT_APPEAR");
  await new Promise(resolve => setTimeout(resolve, 100));
  const failedSource = fs.readFileSync(path.join(temp, "data", "teach-mode", "event-sessions", interrupted.id, "browser-source.jsonl"), "utf8");
  report.checks.noCaptureAfterDetach = !failedSource.includes("AFTER_DETACH_MUST_NOT_APPEAR");
  assert.equal(report.checks.detachEndsRecording, true); assert.equal(report.checks.noCaptureAfterDetach, true);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.stack : String(error); report.browserStderr = stderr;
  process.exitCode = 1;
} finally {
  await service.close(); await bridge.close();
  await cdp("Browser.close").catch(() => child.kill());
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Acceptance finished")); }
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.writeFileSync(path.join(output, `${browserName}-report.json`), JSON.stringify(report, null, 2));
  const captures = path.join(temp, "data");
  if (fs.existsSync(captures)) fs.cpSync(captures, path.join(output, `${browserName}-data`), { recursive: true });
  if (report.passed) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  console.log(JSON.stringify(report));
}
