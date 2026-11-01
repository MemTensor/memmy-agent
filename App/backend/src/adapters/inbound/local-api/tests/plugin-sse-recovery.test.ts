import { expect, it } from "vitest";
import { createLocalApiServer } from "../server.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import type { PermissionManager } from "../../../../permission/index.js";

it("replays a pending confirmation to a late SSE subscriber, excluding its answered guidance", async () => {
  const bus = createProgressBus();
  const call = { pluginId: "legal-labor", capabilityId: "session-start", callId: "pending-call", conversationId: "websocket:chat-1", origin: "agent" as const };
  bus.emit("plugin.capability_event", { ...call, event: { type: "interaction", request: { type: "question", interactionId: "answered-guide", payload: {} } } });
  bus.acknowledgePluginInteraction(call.pluginId, call.callId, "answered-guide");
  bus.emit("plugin.capability_event", { ...call, event: { type: "interaction", request: { type: "file-input", interactionId: "pending-upload", payload: { title: "补充诊断材料" } } } });
  const app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken: async () => true } as unknown as PermissionManager,
    composioMcpToken: "test-only", services: { progressBus: bus } as BackendServices
  });
  const abort = new AbortController();
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/events?token=test-only`, { signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let content = "";
    while (!content.includes("plugin.capability_snapshot")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      content += new TextDecoder().decode(chunk.value);
    }
    expect(content).toContain("plugin.capability_event");
    expect(content).toContain('"callId":"pending-call"');
    expect(content).not.toContain("answered-guide");
    expect(content).toContain('"type":"plugin.capability_snapshot"');
    expect(content).toContain('"calls":[{"pluginId":"legal-labor","capabilityId":"session-start","callId":"pending-call","conversationId":"websocket:chat-1"}]');
    await reader.cancel();
  } finally { abort.abort(); await app.close(); }
});
