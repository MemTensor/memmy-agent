import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativePluginServices } from "../../../src/tools/plugin-host/native-services.js";

const roots: string[] = [], services: ReturnType<typeof createNativePluginServices>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function fixture(options: Parameters<typeof createNativePluginServices>[0] = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-plugin-")); roots.push(dataRoot);
  const service = createNativePluginServices({ platform: "win32", dataRoot, ...options }); services.push(service);
  const invoke = (pluginId: string, name: string, input: Record<string, unknown> = {}) => service.invoke({ pluginId, service: name, input });
  return { service, dataRoot, invoke };
}
describe("identity-bound native plugin services", () => {
  it("exposes the shared event flow on macOS without acquiring Windows legacy primitives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-plugin-events-")); roots.push(root);
    const stream = path.join(root, "events.jsonl"); fs.writeFileSync(stream, "");
    let released = false;
    const f = fixture({ platform: "darwin", osRelease: "23.0.0", toolNames: () => ["read_file", "write_file"],
      history: { acquireEventCapture: async () => ({
        checkpoint: async () => ({ running: !released, complete: true, boundaryConfirmed: true,
          limitations: [], streams: [{ id: "mac-fixture", file: stream, size: fs.statSync(stream).size }] }),
        release: async () => { released = true; },
      }) } });
    const config = await f.invoke("teach-mode", "event-sessions", { action: "configuration" });
    expect(config.supported).toBe(true);
    expect(config.features).toContain("memmy.event-checkpoints/v1");
    const active = await f.invoke("teach-mode", "event-sessions", { action: "start", conversationId: "mac-chat", goal: "Teach a Mac workflow", consent: true });
    fs.appendFileSync(stream, JSON.stringify({ recordType: "human_event", eventType: "mouse_click", sequence: 1,
      timestamp: new Date().toISOString(), application: { name: "Controlled Mac app", bundleId: "test.mac-app" } }) + "\n");
    const ended = await f.invoke("teach-mode", "event-sessions", { action: "stop", conversationId: "mac-chat", session_id: active.id });
    expect(ended).toMatchObject({ state: "ready", eventCount: 1 }); expect(released).toBe(true);
    await expect(f.invoke("teach-mode", "collector", { action: "acquire" })).rejects.toThrow();
  });
  it("does not advertise event capture below the native macOS 14 runtime baseline", async () => {
    const acquireEventCapture = vi.fn();
    const f = fixture({ platform: "darwin", osRelease: "22.6.0", history: { acquireEventCapture } });
    expect(await f.invoke("teach-mode", "event-sessions", { action: "configuration" })).toMatchObject({ supported: false });
    expect(acquireEventCapture).not.toHaveBeenCalled();
  });
  it.each([
    ["collector", "acquire"], ["collector", "status"], ["collector", "release"],
    ["window-focus", "focus"],
    ...["start", "get", "stop", "pin", "delete", "media"].map(action => ["recording", action]),
  ])("rejects the retired %s service (%s) before allocating capture resources", async (name, action) => {
    const acquireEventCapture = vi.fn(), f = fixture({ history: { acquireEventCapture } });
    await expect(f.invoke("teach-mode", name!, { action })).rejects.toThrow();
    expect(acquireEventCapture).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.dataRoot)).toEqual([]);
  });
});

it("reclaims capture owners after the backend heartbeat disappears while keeping a renewed owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-owner-timeout-"));
  const stream = path.join(root, "events.jsonl"); fs.writeFileSync(stream, "");
  let now = 0, releases = 0;
  const service = createNativePluginServices({ dataRoot: root, platform: "win32", now: () => now, leaseTimeoutMs: 30,
    history: { acquireEventCapture: async () => ({ checkpoint: async () => ({ running: true, complete: true, limitations: [], streams: [{ id: "test", file: stream, size: 0 }] }), release: async () => { releases++; } }) } });
  try {
    const a = await service.invoke({ pluginId: "fixture.a", service: "event-sessions", input: { action: "start", conversationId: "chat-a", goal: "Capture one", consent: true } });
    await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "start", conversationId: "chat-b", goal: "Capture two", consent: true } });
    now = 25; await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "owner-status" } });
    now = 40; await service.reconcile();
    expect(releases).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "fixture.a", "event-sessions", String(a.id), "session.json"), "utf8"))).toMatchObject({ state: "failed" });
    expect(await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "owner-status" } })).toEqual({ busy: true });
  } finally { await service.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
