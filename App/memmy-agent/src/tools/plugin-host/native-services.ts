/** Shared event capture. Plugin services cannot start task video recordings. */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { PluginEventSessions } from "./event-sessions.js";
import type { EventCaptureSource } from "../computer-history/core/event-capture-source.js";
import { PLUGIN_HOST_CAPABILITIES } from "@memmy/local-api-contracts";
import { isMacNativeRuntimeSupported } from "../computer-use/mac-native-runtime-support.js";
import { createBrowserCaptureProvider, type BrowserCaptureProvider } from "../computer-history/browser-event-capture.js";
import { externalBrowserBridge } from "../../core/agent-runtime/tools/external-browser-bridge.js";
import { launchTeachingBrowser } from "../computer-history/browser-capture-launch.js";

const Request = z.object({ pluginId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  service: z.enum(["event-sessions", "release"]), input: z.record(z.string(), z.unknown()).default({}) });
export function createNativePluginServices(options: {
  dataRoot?: string; platform?: NodeJS.Platform; osRelease?: string;
  now?: () => number; leaseTimeoutMs?: number;
  history?: EventCaptureSource; skillCreatorFile?: string; toolNames?: () => string[];
  browser?: BrowserCaptureProvider;
  skills?: () => Array<{ name: string; path: string }>;
} = {}) {
  let events: PluginEventSessions | undefined;
  const seen = new Map<string, number>();
  let reconciling: Promise<void> | undefined;
  const reconcile = () => reconciling ??= (async () => {
    for (const [owner, lastSeen] of [...seen]) {
      if ((options.now?.() ?? Date.now()) - lastSeen <= (options.leaseTimeoutMs ?? 30_000)) continue;
      if (events?.isBusy(owner)) await release(owner);
      else seen.delete(owner);
    }
  })().finally(() => { reconciling = undefined; });
  const leaseTimer = setInterval(() => { void reconcile().catch(() => undefined); }, 5_000); leaseTimer.unref();
  async function invoke(raw: unknown, context?: { history: EventCaptureSource; toolNames: string[]; skills?: Array<{ name: string; path: string }> }): Promise<Record<string, unknown>> {
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
    throw new Error("Unknown plugin event service");
  }
  async function release(id: string) {
    try { await events?.release(id); }
    finally { seen.delete(id); }
  }
  async function shutdown() {
    clearInterval(leaseTimer); await reconciling?.catch(() => undefined);
    await events?.close().catch(() => undefined);
    await Promise.allSettled([...seen.keys()].map(release));
  }
  return { invoke, release, shutdown, reconcile };
}
const instances = new Map<string, ReturnType<typeof createNativePluginServices>>();
export function invokeNativePluginService(raw: unknown,
  context?: Parameters<ReturnType<typeof createNativePluginServices>["invoke"]>[1]) {
  const request = raw as { dataRoot?: unknown };
  const dataRoot = typeof request.dataRoot === "string" && path.isAbsolute(request.dataRoot)
    ? path.resolve(request.dataRoot) : path.join(os.homedir(), ".memmy", "plugin-data");
  let native = instances.get(dataRoot);
  if (!native) { native = createNativePluginServices({ dataRoot }); instances.set(dataRoot, native); }
  return native.invoke(raw, context);
}
export async function shutdownNativePlugins() {
  await Promise.allSettled([...instances.values()].map(native => native.shutdown())); instances.clear();
}
