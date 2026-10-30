import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { it, expect, vi } from "vitest";
import { createPluginNativeHostServices } from "../plugin-native-host-services.js";
import { createGeneratedPluginSkills } from "../plugin-generated-skills.js";
import type { PluginRepository } from "../../infrastructure/app-state-store/repositories/plugin-repo.js";
import type { MemmyAgentAdminClient } from "../../adapters/outbound/memmy-agent-admin-client/index.js";

it("releases a native owner even when the start acknowledgement was lost before a local lease was recorded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-lost-ack-")); let allocated = false;
  const invoke = vi.fn(async (_id: string, service: string) => {
    if (service === "release") { allocated = false; return { ok: true }; }
    allocated = true; throw new Error("lost acknowledgement");
  });
  const native = createPluginNativeHostServices({ dataRoot: root,
    generated: createGeneratedPluginSkills(root, path.join(root, "active.json")),
    repository: { get: () => ({ state: "active", manifest: { permissions: [{ type: "host-service", services: ["event-sessions"] }] }, approvedPermissions: [{ type: "host-service", services: ["event-sessions"] }] }) } as unknown as PluginRepository,
    admin: { invokePluginHostService: invoke } as unknown as MemmyAgentAdminClient });
  try {
    await expect(native.hostServices.invoke({ pluginId: "fixture.capture", callId: "call", conversationId: "chat", service: "event-sessions", input: { action: "start", consent: true, goal: "Capture" } })).rejects.toThrow("lost acknowledgement");
    expect(native.isBusy("fixture.capture")).toBe(false); expect(allocated).toBe(true);
    await native.release("fixture.capture"); expect(allocated).toBe(false);
  } finally { await native.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
