/** Progress bus tests. */
import { describe, expect, it } from "vitest";
import { createProgressBus } from "../progress-bus.js";

describe("progress bus", () => {
  it("restores live plugin cards after reconnect without resurrecting answered steps", () => {
    const bus = createProgressBus();
    const call = { pluginId: "legal-labor", capabilityId: "session-start", callId: "call-1", conversationId: "websocket:chat-1", origin: "agent" as const };
    bus.emit("plugin.capability_event", { ...call, event: { type: "progress", current: 0, total: 2 } });
    bus.emit("plugin.capability_event", { ...call, event: { type: "interaction", request: { type: "question", interactionId: "guide", payload: {} } } });
    bus.emit("plugin.capability_event", { ...call, event: { type: "progress", current: 1, total: 2 } });
    expect(bus.pendingPluginEvents()).toHaveLength(2);
    bus.acknowledgePluginInteraction(call.pluginId, call.callId, "guide");
    bus.emit("plugin.capability_event", { ...call, event: { type: "interaction", request: { type: "file-input", interactionId: "upload", payload: {} } } });
    expect(bus.pendingPluginEvents().filter(({ event }) => event.type === "interaction").map(({ event }) => event.type === "interaction" && event.request.interactionId)).toEqual(["upload"]);
    bus.emit("plugin.capability_event", { ...call, event: { type: "result", output: { sessionId: "legal-session" } } });
    expect(bus.pendingPluginEvents()).toEqual([]);
  });
  it("emits typed scan progress and supports unsubscribe", () => {
    const bus = createProgressBus();
    const received: string[] = [];
    const unsubscribe = bus.on("agent_source.scan_progress", (event) => {
      received.push(event.phase);
    });

    bus.emit("agent_source.scan_progress", {
      jobId: "job-1",
      sourceId: "cursor",
      phase: "scan",
      current: 0,
      total: 1
    });
    unsubscribe();
    bus.emit("agent_source.scan_progress", {
      jobId: "job-1",
      sourceId: "cursor",
      phase: "done",
      current: 1,
      total: 1
    });

    expect(received).toEqual(["scan"]);
  });
});
