import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ComputerHistoryApiError } from "../core/computer-history-api.js";
import type { HistoryPlatformDriver, HistoryPermissions, RecorderLaunch, HistoryContentQuality } from "../core/platform-driver.js";
import { applicationCatalog, discoverApplications, resolveWindowsCollector, WindowsSettingsStore } from "./settings.js";
import { isSystemSurface, isUnsupportedBrowser, pathKey } from "./policy.js";
import { collectorGate } from "../core/collector-gate.js";
import { discoverApplicationCatalog, type CatalogApplication } from "./application-catalog.js";
import { windowsScopeAllows } from "./unified-settings.js";

interface ProcessSession { ready: Promise<void>; closed: Promise<void> }
export class WindowsPlatformDriver implements HistoryPlatformDriver {
  private quality: HistoryContentQuality | undefined;
  contentQuality() { return this.quality; }
  private readonly sessions = new WeakMap<ChildProcessWithoutNullStreams, ProcessSession>();
  private catalog: { expires: number; entries: CatalogApplication[] } | undefined;
  constructor(readonly store: WindowsSettingsStore, private readonly binary?: string,
    private readonly recorderScript = fileURLToPath(new URL("./record-human-history.js", import.meta.url))) {}
  prepare(): void {
    const settings = this.store.read();
    if (settings.defaultApplicationBehavior !== "observe" && !settings.applications.length
        && !this.store.readObservation()?.observation.rules.some(rule => rule.scope === "app" && rule.behavior === "observe")) throw new ComputerHistoryApiError(422, "Choose an application to record first");
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
    return { settings, applications: applicationCatalog(bindings, settings, this.catalog.entries, this.store.readObservation()), permissions: await this.readPermissions() };
  }
  async readPermissions(): Promise<HistoryPermissions> {
    const status: HistoryPermissions = { supported: true, platform: "windows", accessibility: false, inputMonitoring: false, ready: false, reason: "authorization_required" };
    let binary: string;
    try { binary = resolveWindowsCollector(this.binary); if (!fs.existsSync(this.recorderScript)) throw new Error(); }
    catch { return { ...status, reason: "collector_unavailable" }; }
    let settings, shared;
    try { settings = this.store.read(); shared = this.store.readObservation(); } catch { return { ...status, reason: "settings_invalid" }; }
    if (settings.defaultApplicationBehavior !== "observe" && !settings.applications.length
        && !shared?.observation.rules.some(rule => rule.scope === "app" && rule.behavior === "observe")) return status;
    try {
      const bindings = await discoverApplications(binary);
      const ready = settings.defaultApplicationBehavior === "observe" || bindings.some((binding) => !isSystemSurface(binding.executable) && !isUnsupportedBrowser(binding.executable)
        && !settings.deny?.executables?.some((exe) => pathKey(exe) === pathKey(binding.executable))
        && (shared ? windowsScopeAllows(shared, binding.executable)
          : settings.applications.some((rule) => pathKey(rule.executable) === pathKey(binding.executable))));
      return { ...status, ready, reason: ready ? "ready" : "no_running_authorized_application" };
    } catch { return { ...status, reason: "discovery_failed" }; }
  }
  async listApplications(): Promise<Array<{ bundleId: string; name: string }>> {
    const configuration = await this.configuration();
    const applications = new Map<string, { bundleId: string; name: string }>();
    for (const app of configuration.applications.filter((item) => item.supported)) {
      const bundleId = app.id;
      applications.set(bundleId, { bundleId, name: app.name });
    }
    return [...applications.values()];
  }
  openPermission(): Promise<HistoryPermissions> { return this.readPermissions(); }
  permissionError(): null { return null; }
  async iconFor(): Promise<null> { return null; }
  launch(input: RecorderLaunch): ChildProcessWithoutNullStreams {
    this.prepare();
    this.quality = undefined;
    const release = collectorGate.acquire("history");
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(process.execPath, [this.recorderScript, "--binary", resolveWindowsCollector(this.binary),
      "--settings", this.store.filePath, "--out", input.eventsFile, "--title", input.title, "--seconds", "86400", "--append", "--input-hooks",
      "--observation-settings", input.observationSettingsFile,
      ...(input.weChatConsentFile ? ["--wechat-consent", input.weChatConsentFile] : [])],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: process.env }); }
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
      if (buffer.length > 4096) { fail(); return; }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          if (line.startsWith("[recorder-quality] ")) {
            const quality = JSON.parse(line.slice("[recorder-quality] ".length));
            if (!quality || typeof quality !== "object" || Array.isArray(quality)
                || !["available", "partial", "unavailable"].includes(quality.status)
                || !["text_read", "labels_only", "read_failed", "budget_exceeded"].includes(quality.reason)
                || typeof quality.timestamp !== "string" || !Number.isFinite(Date.parse(quality.timestamp))
                || Object.keys(quality).length !== 3 || Object.keys(quality).some(key => !["status", "reason", "timestamp"].includes(key))) throw new Error();
            this.quality = quality;
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
    });
    child.once("close", (code) => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      if (failure || !started || !stopped || buffer || code !== 0) {
        const error = failure ?? new Error("Windows recorder did not finish normally"); readyReject(error); closeReject(error);
      } else closeResolve();
    });
    this.sessions.set(child, { ready, closed });
    return child;
  }
  async ready(child: ChildProcessWithoutNullStreams): Promise<void> {
    const session = this.sessions.get(child)!;
    try { await session.ready; } catch (error) { await session.closed.catch(() => {}); throw error; }
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
