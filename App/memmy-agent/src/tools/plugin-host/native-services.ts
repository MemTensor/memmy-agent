/** Shared native primitives. No Teach-specific orchestration runs in the Host. */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { PluginEventSessions } from "./event-sessions.js";
import type { EventCaptureSource } from "../computer-history/core/event-capture-source.js";
import { PLUGIN_HOST_CAPABILITIES, RecordingStartSchema } from "@memmy/local-api-contracts";
import { CollectorGate, collectorGate } from "../computer-history/core/collector-gate.js";
import { RecordingSessionService, type TaskRecordingDriver } from "../computer-recordings/session-service.js";
import { WindowsTaskRecordingDriver } from "../computer-recordings/windows-driver.js";
import { revealWindowsWindow } from "../computer-use/windows-focus-guard.js";
import { isMacNativeRuntimeSupported } from "../computer-use/mac-native-runtime-support.js";
import { createBrowserCaptureProvider, type BrowserCaptureProvider } from "../computer-history/browser-event-capture.js";
import { externalBrowserBridge } from "../../core/agent-runtime/tools/external-browser-bridge.js";
import { launchTeachingBrowser } from "../computer-history/browser-capture-launch.js";

const Request = z.object({ pluginId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  service: z.enum(["collector", "recording", "window-focus", "event-sessions", "release"]), input: z.record(z.string(), z.unknown()).default({}) });
const uuid = z.string().uuid();
export function createNativePluginServices(options: {
  dataRoot?: string; platform?: NodeJS.Platform; osRelease?: string; historyBusy?: () => boolean;
  now?: () => number; leaseTimeoutMs?: number;
  driverFactory?: () => TaskRecordingDriver;
  focus?: (pid: number, hwnd: number) => Promise<unknown>;
  history?: EventCaptureSource; skillCreatorFile?: string; toolNames?: () => string[];
  browser?: BrowserCaptureProvider;
  skills?: () => Array<{ name: string; path: string }>;
} = {}) {
  const leases = new Map<string, { id: string; release: () => void }>();
  const recordings = new Map<string, RecordingSessionService>();
  let events: PluginEventSessions | undefined;
  const seen = new Map<string, number>();
  let reconciling: Promise<void> | undefined;
  const reconcile = () => reconciling ??= (async () => {
    for (const [owner, lastSeen] of [...seen]) {
      if ((options.now?.() ?? Date.now()) - lastSeen <= (options.leaseTimeoutMs ?? 30_000)) continue;
      if (leases.has(owner) || events?.isBusy(owner)) await release(owner);
      else seen.delete(owner);
    }
  })().finally(() => { reconciling = undefined; });
  const leaseTimer = setInterval(() => { void reconcile().catch(() => undefined); }, 5_000); leaseTimer.unref();
  function recorder(id: string) {
    let service = recordings.get(id);
    if (!service) {
      service = new RecordingSessionService({ directory: path.join(options.dataRoot ?? path.join(os.homedir(), ".memmy", "plugin-data"), id, "recordings"),
        driver: options.driverFactory?.() ?? new WindowsTaskRecordingDriver(), gate: new CollectorGate(), supported: (options.platform ?? process.platform) === "win32" });
      recordings.set(id, service);
    }
    return service;
  }
  async function invoke(raw: unknown, historyBusy?: () => boolean, context?: { history: EventCaptureSource; toolNames: string[]; skills?: Array<{ name: string; path: string }> }): Promise<Record<string, unknown>> {
    const { pluginId, service, input } = Request.parse(raw);
    seen.set(pluginId, options.now?.() ?? Date.now());
    if (service === "release") { await release(pluginId); return { ok: true }; }
    if (service === "event-sessions") {
      if (input.action === "owner-status") return { busy: events?.isBusy(pluginId) ?? false };
      const source = options.history ?? context?.history;
      if (!source) throw new Error("Host event-sessions/v1 is unavailable; update the desktop Host");
      if (input.action === "configuration") {
        const file = options.skillCreatorFile ?? fileURLToPath(new URL("../../skills/skill-creator/SKILL.md", import.meta.url));
        const platform = options.platform ?? process.platform;
        return { version: 1, features: [...PLUGIN_HOST_CAPABILITIES], supported: ["win32", "darwin"].includes(platform)
            && isMacNativeRuntimeSupported(platform, options.osRelease ?? os.release()),
          toolNames: options.toolNames?.() ?? context?.toolNames ?? [],
          skills: options.skills?.() ?? context?.skills ?? [],
          skillCreator: { available: fs.existsSync(file), ...(fs.existsSync(file) ? { instructions: fs.readFileSync(file, "utf8") } : {}) } };
      }
      const conversationId = z.string().trim().min(1).max(500).parse(input.conversationId).replace(/^websocket:/, "");
      if (!events) {
        events = new PluginEventSessions({ dataRoot: options.dataRoot ?? path.join(os.homedir(), ".memmy", "plugin-data"), source,
          browser: options.browser ?? createBrowserCaptureProvider(externalBrowserBridge, { platform: options.platform,
            launch: browser => launchTeachingBrowser(browser, options.platform) }) });
      }
      return events.invoke(pluginId, conversationId, input);
    }
    if (service === "collector") {
      if (input.action === "status") return { busy: leases.has(pluginId) };
      if (input.action === "acquire") {
        if ((options.platform ?? process.platform) !== "win32") throw new Error("Native recording requires Windows");
        if (leases.has(pluginId) || (historyBusy?.() ?? options.historyBusy?.() ?? false)) throw new Error("collector_busy");
        const release = collectorGate.acquire("task"), id = randomUUID(); leases.set(pluginId, { id, release }); return { leaseId: id };
      }
      if (input.action === "release") {
        if (leases.get(pluginId)?.id !== input.leaseId) throw new Error("Invalid collector lease");
        await release(pluginId); return { ok: true };
      }
      throw new Error("Unknown collector operation");
    }
    if (service === "window-focus") {
      if (!leases.has(pluginId)) throw new Error("Collector lease required for desktop control");
      const target = z.object({ pid: z.number().int().positive(), hwnd: z.string().regex(/^[1-9][0-9]{0,19}$/) }).parse(input);
      if (!Number.isSafeInteger(Number(target.hwnd)) || await (options.focus ?? revealWindowsWindow)(target.pid, Number(target.hwnd)) === false) throw new Error("window_focus_failed");
      return { ok: true };
    }
    const recording = recorder(pluginId), action = input.action;
    if (action === "start") {
      if (leases.get(pluginId)?.id !== input.leaseId) throw new Error("Collector lease required for recording");
      const target = z.object({ pid: z.number().int().positive(), hwnd: z.string(), processStart: z.string().min(1) }).parse(input.target);
      return recording.start(RecordingStartSchema.parse(input.recording), null, target);
    }
    const id = uuid.parse(input.id);
    if (action === "get") return recording.get(id);
    if (action === "stop") return recording.control(id, "stop");
    if (action === "pin") { await recording.pin(id, input.value === true); return { ok: true }; }
    if (action === "delete") { await recording.delete(id); return { ok: true }; }
    if (action === "media") {
      const media = await recording.openMedia(id, "recording"); fs.closeSync(media.fd);
      return { path: path.join(recording.directory, id, "recording.mp4"), type: media.type, size: media.size };
    }
    throw new Error("Unknown recording operation");
  }
  async function release(id: string) {
    const recording = recordings.get(id);
    try { await events?.release(id); }
    finally {
      try { await recording?.shutdown(); }
      finally { recordings.delete(id); leases.get(id)?.release(); leases.delete(id); seen.delete(id); }
    }
  }
  async function shutdown() {
    clearInterval(leaseTimer); await reconciling?.catch(() => undefined);
    await events?.close().catch(() => undefined);
    await Promise.allSettled([...new Set([...leases.keys(), ...recordings.keys()])].map(release));
  }
  return { invoke, release, shutdown, reconcile };
}
const instances = new Map<string, ReturnType<typeof createNativePluginServices>>();
export function invokeNativePluginService(raw: unknown, historyBusy?: () => boolean,
  context?: Parameters<ReturnType<typeof createNativePluginServices>["invoke"]>[2]) {
  const request = raw as { dataRoot?: unknown };
  const dataRoot = typeof request.dataRoot === "string" && path.isAbsolute(request.dataRoot)
    ? path.resolve(request.dataRoot) : path.join(os.homedir(), ".memmy", "plugin-data");
  let native = instances.get(dataRoot);
  if (!native) { native = createNativePluginServices({ dataRoot }); instances.set(dataRoot, native); }
  return native.invoke(raw, historyBusy, context);
}
export async function shutdownNativePlugins() {
  await Promise.allSettled([...instances.values()].map(native => native.shutdown())); instances.clear();
}
