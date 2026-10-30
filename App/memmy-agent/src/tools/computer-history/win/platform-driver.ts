import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ComputerHistoryApiError } from "../core/computer-history-api.js";
import type { HistoryPlatformDriver, HistoryPermissions, RecorderLaunch } from "../core/platform-driver.js";
import { applicationCatalog, browserNames, discoverApplications, resolveWindowsCollector, WindowsSettingsStore } from "./settings.js";
import { isSystemSurface, pathKey } from "./policy.js";
import path from "node:path";
import crypto from "node:crypto";
import { collectorGate } from "../core/collector-gate.js";
import { discoverApplicationCatalog, type CatalogApplication } from "./application-catalog.js";
import { checkpointId, persistedCheckpoint, recorderRotationRequest, recorderRotationResult } from "../core/recorder-checkpoint.js";
import { WindowsApplicationIconReader } from "./application-icon.js";

interface ProcessSession { ready: Promise<void>; closed: Promise<void>; rotate(input: RecorderLaunch): Promise<void> }
export class WindowsPlatformDriver implements HistoryPlatformDriver {
  private readonly sessions = new WeakMap<ChildProcessWithoutNullStreams, ProcessSession>();
  private readonly icons = new WindowsApplicationIconReader();
  private catalog: { expires: number; entries: CatalogApplication[] } | undefined;
  constructor(readonly store: WindowsSettingsStore, private readonly binary?: string,
    private readonly recorderScript = fileURLToPath(new URL("./record-human-history.js", import.meta.url))) {}
  prepare(): void {
    const settings = this.store.read();
    if (settings.defaultApplicationBehavior !== "observe" && !settings.applications.length) throw new ComputerHistoryApiError(422, "Choose an application to record first");
    resolveWindowsCollector(this.binary);
    if (!fs.existsSync(this.recorderScript)) throw new ComputerHistoryApiError(503, "Windows recorder entry is unavailable");
  }
  async configuration() {
    const settings = this.store.read();
    let bindings: Awaited<ReturnType<typeof discoverApplications>> = [];
    try { bindings = await discoverApplications(resolveWindowsCollector(this.binary)); } catch { /* capabilities reports the cause */ }
    if (!this.catalog || Date.now() >= this.catalog.expires) {
      let entries: CatalogApplication[] = [];
      try { entries = await discoverApplicationCatalog(resolveWindowsCollector(this.binary)); } catch { /* EXE names remain available */ }
      this.catalog = { expires: Date.now() + 60000, entries };
    }
    return { settings, applications: applicationCatalog(bindings, settings, this.catalog.entries), permissions: await this.readPermissions() };
  }
  async readPermissions(): Promise<HistoryPermissions> {
    const status: HistoryPermissions = { supported: true, platform: "windows", accessibility: false, inputMonitoring: false, ready: false, reason: "authorization_required" };
    let binary: string;
    try { binary = resolveWindowsCollector(this.binary); if (!fs.existsSync(this.recorderScript)) throw new Error(); }
    catch { return { ...status, reason: "collector_unavailable" }; }
    let settings;
    try { settings = this.store.read(); } catch { return { ...status, reason: "settings_invalid" }; }
    if (settings.defaultApplicationBehavior !== "observe" && !settings.applications.length) return status;
    try {
      const bindings = await discoverApplications(binary);
      const ready = settings.defaultApplicationBehavior === "observe" || bindings.some((binding) => !isSystemSurface(binding.executable) && !browserNames.has(path.win32.basename(pathKey(binding.executable)))
        && !settings.deny?.executables?.some((exe) => pathKey(exe) === pathKey(binding.executable))
        && settings.applications.some((rule) => pathKey(rule.executable) === pathKey(binding.executable)));
      return { ...status, ready, reason: ready ? "ready" : "no_running_authorized_application" };
    } catch { return { ...status, reason: "discovery_failed" }; }
  }
  async listApplications(): Promise<Array<{ bundleId: string; name: string }>> {
    const configuration = await this.configuration();
    const applications = new Map<string, { bundleId: string; name: string }>();
    for (const app of configuration.applications.filter((item) => item.supported)) {
      const bundleId = `win32.${path.win32.basename(app.executable, ".exe").toLowerCase()}`;
      applications.set(bundleId, { bundleId, name: app.name });
    }
    return [...applications.values()];
  }
  openPermission(): Promise<HistoryPermissions> { return this.readPermissions(); }
  permissionError(): null { return null; }
  iconFor(bundleId: string): Promise<string | null> { return this.icons.iconFor(bundleId); }
  launch(input: RecorderLaunch): ChildProcessWithoutNullStreams {
    this.prepare();
    const release = collectorGate.acquire("history");
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(process.execPath, [this.recorderScript, "--binary", resolveWindowsCollector(this.binary),
      "--settings", this.store.filePath, "--out", input.eventsFile, "--title", input.title, "--seconds", "86400", "--append", "--input-hooks",
      "--observation-settings", input.observationSettingsFile,
      ...(input.weChatConsentFile ? ["--wechat-consent", input.weChatConsentFile] : [])],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }); }
    catch (error) { release(); throw error; }
    child.once("close", release);
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let closeResolve!: () => void;
    let closeReject!: (error: Error) => void;
    let buffer = "";
    let started = false;
    let stopped = false;
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const rotations = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const closed = new Promise<void>((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
    void ready.catch(() => {}); void closed.catch(() => {});
    const fail = () => {
      failure ??= new Error("Windows recorder failed to start or finish normally"); readyReject(failure);
      if (child.stdin.writable) child.stdin.end("stop\n");
      killTimer ??= setTimeout(() => child.kill(), 2000);
    };
    const timeout = setTimeout(fail, 12000);
    child.once("error", fail);
    child.stdin.on("error", () => { if (!stopped) fail(); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        if (index > 4096) { fail(); return; }
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          if (line.startsWith("[recorder-rotation] ")) {
            const result = recorderRotationResult.parse(JSON.parse(line.slice("[recorder-rotation] ".length)));
            const request = rotations.get(result.id);
            if (!request) throw new Error();
            rotations.delete(result.id); clearTimeout(request.timer);
            if (result.complete) request.resolve(); else request.reject(new Error("Windows recorder output rotation failed"));
            continue;
          }
          if (line.startsWith("[recorder-checkpoint] ")) {
            const checkpoint = JSON.parse(line.slice("[recorder-checkpoint] ".length));
            if (!persistedCheckpoint.safeParse(checkpoint).success && !(checkpointId.safeParse(checkpoint.id).success
                && checkpoint.complete === false && Object.keys(checkpoint).every(key => key === "id" || key === "complete"))) throw new Error();
            continue;
          }
          if (line.startsWith("[recorder-health] ")) {
            const health = JSON.parse(line.slice("[recorder-health] ".length));
            if (!health || typeof health !== "object" || Array.isArray(health)
                || health.code !== "event_recorded" || typeof health.timestamp !== "string"
                || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(health.timestamp)
                || !Number.isFinite(Date.parse(health.timestamp))
                || Object.keys(health).some(key => key !== "code" && key !== "timestamp")) throw new Error();
            continue;
          }
          const state = JSON.parse(line);
          if (state.kind !== "recorder.state" || Object.keys(state).length !== 2 || stopped
              || !["running", "paused", "stopping", "stopped"].includes(state.state)) throw new Error();
          if (!started) { if (state.state !== "running") throw new Error(); started = true; clearTimeout(timeout); readyResolve(); }
          if (state.state === "stopped") stopped = true;
        } catch { fail(); }
      }
      if (buffer.length > 4096) fail();
    });
    child.once("close", (code) => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      for (const request of rotations.values()) { clearTimeout(request.timer); request.reject(new Error("Windows recorder closed during rotation")); }
      rotations.clear();
      if (failure || !started || !stopped || buffer || code !== 0) {
        const error = failure ?? new Error("Windows recorder did not finish normally"); readyReject(error); closeReject(error);
      } else closeResolve();
    });
    this.sessions.set(child, { ready, closed, rotate: input => {
      if (!started || stopped || failure || !child.stdin.writable || rotations.size) return Promise.reject(new Error("Windows recorder cannot rotate now"));
      const command = recorderRotationRequest.parse({ kind: "rotate", id: crypto.randomUUID(), eventsFile: input.eventsFile, title: input.title });
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          rotations.delete(command.id); reject(new Error("Windows recorder output rotation timed out")); fail();
        }, 12000);
        rotations.set(command.id, { resolve, reject, timer });
        // Stdin is a bounded ASCII protocol; preserve Unicode paths using JSON escapes.
        const line = JSON.stringify(command).replace(/[^\x20-\x7e]/gu, character => Array.from({ length: character.length }, (_, i) =>
          "\\u" + character.charCodeAt(i).toString(16).padStart(4, "0")).join(""));
        child.stdin.write(line + "\n", error => { if (error) fail(); });
      });
    } });
    return child;
  }
  async ready(child: ChildProcessWithoutNullStreams): Promise<void> {
    const session = this.sessions.get(child)!;
    try { await session.ready; } catch (error) { await session.closed.catch(() => {}); throw error; }
  }
  async rotate(child: ChildProcessWithoutNullStreams, input: RecorderLaunch): Promise<void> {
    const session = this.sessions.get(child);
    if (!session) throw new Error("Unknown Windows recorder process");
    await session.rotate(input);
  }
  async stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    const session = this.sessions.get(child);
    if (!session) throw new Error("Unknown Windows recorder process");
    if (child.exitCode !== null || child.signalCode !== null) return session.closed;
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      if (child.stdin.writable) child.stdin.end("stop\n");
      await session.closed;
    } finally { clearTimeout(timer); }
  }
}
