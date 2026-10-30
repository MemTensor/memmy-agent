import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileWindowsPolicy, isSystemSurface, parseNativePolicy, pathKey, replaceNativePolicy, type ApplicationBinding, type NativePolicy } from "./policy.js";
import { browserNames, discoverApplications, WindowsSettingsStore } from "./settings.js";
import type { WindowsHistoryRecorder } from "./recorder.js";

export function bindSettings(store: WindowsSettingsStore, bindings: ApplicationBinding[]): NativePolicy {
  const settings = store.read();
  const options = { defaultApplicationBehavior: settings.defaultApplicationBehavior, sensitiveAutomationIds: settings.sensitiveAutomationIds, deny: settings.deny, limits: settings.limits };
  // No usable binding (including all-denied scopes) keeps an inert native policy.
  const eligible = bindings.filter((binding) => !settings.deny?.executables?.some((exe) => pathKey(exe) === pathKey(binding.executable)));
  try {
    return compileWindowsPolicy(settings.applications, eligible, options);
  } catch (error) {
    // A nonempty candidate set may fail validation (size/budget); never hide that failure.
    const candidates = eligible.filter((binding) => !isSystemSurface(binding.executable) && !browserNames.has(path.win32.basename(pathKey(binding.executable)))
      && (settings.defaultApplicationBehavior === "observe" || settings.applications.some((rule) => pathKey(rule.executable) === pathKey(binding.executable))));
    if (candidates.length) throw error;
    // A revoked/closed application must not keep an old process instance authorized.
    // This rule cannot match: its only PID is also explicitly denied.
    return parseNativePolicy({ version: 1, applications: [{ pid: process.pid, executable: process.execPath, processStart: "1" }],
      sensitiveAutomationIds: settings.sensitiveAutomationIds, limits: settings.limits,
      deny: { ...settings.deny, pids: [process.pid] } });
  }
}
export class WindowsPolicySession {
  readonly file: string;
  private interval: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private current = "";
  private stopping = false;
  private constructor(private readonly directory: string, private readonly store: WindowsSettingsStore, private readonly binary: string) {
    this.file = path.join(directory, "policy.json");
  }
  static async create(settingsFile: string, binary: string): Promise<WindowsPolicySession> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-windows-policy-"));
    const session = new WindowsPolicySession(directory, new WindowsSettingsStore(settingsFile), binary);
    try {
      const settings = session.store.read();
      if (settings.defaultApplicationBehavior !== "observe" && !settings.applications.length) throw new Error("windows_authorization_required");
      const policy = bindSettings(session.store, await discoverApplications(binary));
      session.current = JSON.stringify(policy);
      replaceNativePolicy(session.file, policy);
      return session;
    } catch (error) { await session.dispose(); throw error; }
  }
  monitor(recorder: WindowsHistoryRecorder, onError: (error: Error) => void): void {
    this.interval = setInterval(() => {
      if (this.stopping || this.pending) return;
      if (recorder.state !== "running" && recorder.state !== "paused") return;
      this.pending = (async () => {
        const policy = bindSettings(this.store, await discoverApplications(this.binary));
        if (this.stopping || (recorder.state !== "running" && recorder.state !== "paused")) return;
        const serialized = JSON.stringify(policy);
        if (serialized === this.current) return;
        await recorder.updatePolicy(policy);
        this.current = serialized;
      })().catch(() => {
        if (!this.stopping && recorder.state !== "stopping" && recorder.state !== "stopped") {
          onError(new Error("windows_policy_refresh_failed"));
          void recorder.stop().catch(() => {});
        }
      }).finally(() => { this.pending = null; });
    }, 2000);
    this.interval.unref();
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    await this.pending?.catch(() => {});
    // Delete only the two exact session-owned paths; never recursively remove a computed tree.
    try { fs.unlinkSync(this.file); } catch { /* may not have been created */ }
    try { fs.rmdirSync(this.directory); } catch { /* preserve unexpected files */ }
  }
}
