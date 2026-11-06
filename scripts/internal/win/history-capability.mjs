// Run with node --import tsx. One synthetic foreground window, one case, no parallel runs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import readline from "node:readline";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCapability, collectorPreconditionError } from "./history-capability-analysis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, "App/memmy-agent/src/tools/computer-history/win");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse) : [];
function startProbe(binary, request) {
  const child = childProcess.spawn(binary, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = []; const stderr = []; let bytes = 0;
  child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); else stdout.push(chunk); });
  child.stderr.on("data", (chunk) => { if (stderr.length < 32) stderr.push(chunk); });
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill(), 20000);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  }).finally(() => clearTimeout(timer));
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return { child, closed };
}
async function probeOnce(binary, request) {
  const probe = startProbe(binary, request); probe.child.stdin.end();
  const execution = await probe.closed;
  try { return { ...execution, result: JSON.parse(execution.stdout) }; }
  catch { return { ...execution, result: { error: "probe_output_invalid_or_timeout" } }; }
}

async function recordProduct(binary, policyFile, directory, modulePath) {
  const nativeFile = path.join(directory, "native.jsonl");
  const eventsFile = path.join(directory, "events.jsonl");
  const normalized = [];
  const raw = [];
  const diagnostics = [];
  const originalSpawn = childProcess.spawn;
  const { SnapshotNormalizer } = await import(modulePath("normalize"));
  const originalNormalize = SnapshotNormalizer.prototype.normalizeEvents;
  let spawned = 0; let observedChild; let bytes = 0; let overflow = false; let failure;
  let diagnosticBytes = 0; let diagnosticsTruncated = false; let exitCode = null; let signal = null;
  // Transparent taps in this test process only: preserve arguments, bytes, this and return values.
  childProcess.spawn = function (command, ...args) {
    const child = originalSpawn.call(this, command, ...args);
    if (path.resolve(String(command)).toLowerCase() === path.resolve(binary).toLowerCase()) {
      ++spawned; observedChild = child;
      child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { overflow = true; child.kill(); } else raw.push(Buffer.from(chunk)); });
      child.stderr.on("data", (chunk) => {
        const remaining = Math.max(0, 65536 - diagnosticBytes);
        if (chunk.length > remaining) diagnosticsTruncated = true;
        if (remaining > 0) diagnostics.push(Buffer.from(chunk).subarray(0, remaining));
        diagnosticBytes += chunk.length;
      });
      child.on("close", (code, stoppedBy) => { exitCode = code; signal = stoppedBy; });
    }
    return child;
  };
  syncBuiltinESMExports();
  SnapshotNormalizer.prototype.normalizeEvents = function (...args) {
    const result = originalNormalize.apply(this, args);
    normalized.push(...structuredClone(result));
    return result;
  };
  const timer = setTimeout(() => observedChild?.kill(), 12000);
  let recorder;
  try {
    const { WindowsHistoryRecorder } = await import(modulePath("recorder"));
    recorder = await WindowsHistoryRecorder.start({ binary, policyFile, eventsFile, title: "Synthetic capability validation",
      seconds: 3, sampleMs: 500, inputHooks: false });
    await recorder.finished;
  } catch (error) { failure = String(error.message); }
  finally {
    await recorder?.stop().catch(() => {});
    clearTimeout(timer);
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    SnapshotNormalizer.prototype.normalizeEvents = originalNormalize;
  }
  fs.writeFileSync(nativeFile, Buffer.concat(raw), { flag: "wx" });
  save(path.join(directory, "normalized.json"), normalized);
  let native = [];
  try {
    const { NativeStreamReader } = await import(modulePath("protocol"));
    const reader = new NativeStreamReader(); native = reader.feed(Buffer.concat(raw)); reader.end();
    if (spawned !== 1 || overflow || native[0]?.collector?.testHooks !== false || native.at(-1)?.kind !== "session.stopped")
      throw new Error("production_stream_incomplete");
  } catch (error) { failure ??= error.message; }
  const stderr = Buffer.concat(diagnostics).toString("utf8");
  failure = collectorPreconditionError(exitCode, stderr) ?? failure;
  const records = lines(eventsFile);
  save(path.join(directory, "capture.json"), { spawned, overflow, exitCode, signal, stderr, diagnosticsTruncated,
    state: recorder?.state, error: failure ?? null });
  return { native, normalized, records, error: failure };
}

export async function runCapabilityCase({ manifest, nativeBin, probeBin, reportDir, runtimeRoot }) {
  if (process.platform !== "win32") throw new Error("windows_required");
  if (manifest.syntheticOnly !== true || typeof manifest.marker !== "string" || manifest.marker.length < 12
      || manifest.title.includes(manifest.marker)) throw new Error("synthetic_body_only_marker_required");
  if (Object.keys(manifest.rule ?? {}).some((key) => !["documentRegions", "searchFields", "sensitiveAutomationIds"].includes(key)))
    throw new Error("rule_cannot_override_target_identity");
  const modulePath = (name) => pathToFileURL(path.join(runtimeRoot ?? source, `${name}.${runtimeRoot ? "js" : "ts"}`));
  if (runtimeRoot) {
    if (!/[/\\]app\.asar[/\\]/u.test(runtimeRoot)) throw new Error("packaged_asar_runtime_required");
    const { resolveNativeCollector } = await import(modulePath("native-helper"));
    const bundled = resolveNativeCollector(modulePath("settings").href, "C:/deliberately-missing-override.exe");
    if (path.resolve(bundled).toLowerCase() !== path.resolve(nativeBin).toLowerCase()) throw new Error("packaged_helper_mismatch");
  }
  fs.mkdirSync(reportDir, { recursive: false }); // Never overwrite an earlier attempt.
  save(path.join(reportDir, "manifest.json"), manifest);
  save(path.join(reportDir, "environment.json"), { recordedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch, nativeBin, nativeSha256: sha256(nativeBin), probeBin,
    probeSha256: sha256(probeBin), order: "production-before-system-probe", installedAppAcceptance: false,
    runtimeRoot: runtimeRoot ?? source, packagedRuntimeControlledCall: !!runtimeRoot,
    uiAutomationTextInspectionBeforeCase: manifest.uiAutomationTextInspectionBeforeCase ?? "unspecified" });
  const described = await probeOnce(probeBin, { ...manifest, mode: "describe" });
  save(path.join(reportDir, "describe.json"), described);
  if (described.code !== 0 || described.result.foreground?.mismatch !== false) {
    const result = { conclusion: "precondition_invalid", conditionValid: false, reason: described.result.error ?? "not_foreground" };
    save(path.join(reportDir, "result.json"), result); return result;
  }
  const context = described.result.context;
  const { parseNativePolicy, compileWindowsPolicy } = await import(modulePath("policy"));
  const policy = manifest.useApplicationDefaults
    ? compileWindowsPolicy([{ executable: context.executable, ...(manifest.rule ?? {}) }], [context])
    : parseNativePolicy({ version: 1, applications: [{ pid: context.pid, executable: context.executable,
      processStart: context.processStart, hwnd: context.hwnd, ...(manifest.rule ?? {}) }] });
  const policyFile = path.join(reportDir, "policy.json"); save(policyFile, policy);
  const request = { ...manifest, pid: context.pid, processStart: context.processStart, policy };
  const watcher = startProbe(probeBin, { ...request, mode: "watch" });
  const reader = readline.createInterface({ input: watcher.child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  let raw; let captured = {}; let watch; let error;
  try {
    const ready = await iterator.next();
    if (ready.done || JSON.parse(ready.value).ready !== true) throw new Error("foreground_watcher_not_ready");
    captured = await recordProduct(nativeBin, policyFile, reportDir, modulePath);
    raw = await probeOnce(probeBin, { ...request, mode: "probe" });
    save(path.join(reportDir, "system-uia.json"), raw);
    if (raw.code !== 0) error = raw.result.error;
  } catch (failure) { error = failure.message; }
  finally {
    watcher.child.stdin.end("stop\n");
    const execution = await watcher.closed;
    reader.close();
    const output = execution.stdout.trim().split(/\r?\n/u).filter(Boolean);
    try { watch = JSON.parse(output.at(-1)); } catch { error ??= "foreground_watcher_output_invalid"; }
    save(path.join(reportDir, "foreground-watch.json"), { execution, result: watch });
  }
  const result = analyzeCapability({ ...captured, marker: manifest.marker, raw: raw?.result, watch, error: error ?? captured.error });
  const forbidden = manifest.forbiddenMarkers ?? [];
  result.privacyLeaks = forbidden.filter((marker) => JSON.stringify([captured.native, captured.normalized, captured.records]).includes(marker));
  if (result.privacyLeaks.length) result.conclusion = "privacy_failure";
  result.expected = manifest.expected ?? null;
  result.expectationMet = !!result.expected && result.conclusion === result.expected;
  save(path.join(reportDir, "result.json"), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value, all[index + 1]]); return pairs;
  }, []));
  try {
    const result = await runCapabilityCase({ manifest: JSON.parse(fs.readFileSync(args["--case"], "utf8")),
      nativeBin: path.resolve(args["--native-bin"]), probeBin: path.resolve(args["--probe-bin"]), reportDir: path.resolve(args["--report-dir"]),
      ...(args["--runtime-root"] ? { runtimeRoot: path.resolve(args["--runtime-root"]) } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.conditionValid || (result.expected && !result.expectationMet) || result.privacyLeaks?.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
