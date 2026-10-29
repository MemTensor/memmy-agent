/** Progress bus module. */
import { EventEmitter } from "node:events";
import type { PluginCapabilityEventPayload, ScanPhase, ScanResult } from "@memmy/local-api-contracts";

/** Contract for agent source scan progress event. */
export interface AgentSourceScanProgressEvent {
  jobId: string;
  attemptId?: string;
  attemptStartedAt?: string;
  sourceId: string;
  phase: ScanPhase;
  current: number;
  total: number;
  message?: string;
}

/** Contract for agent source scan completed event. */
export interface AgentSourceScanCompletedEvent {
  jobId: string;
  attemptId?: string;
  attemptStartedAt?: string;
  sourceId: string;
  results: ScanResult[];
  succeeded?: boolean;
}

/** Contract for progress bus event map. */
export interface ProgressBusEventMap {
  "agent_source.scan_progress": AgentSourceScanProgressEvent;
  "agent_source.scan_completed": AgentSourceScanCompletedEvent;
  "plugin.capability_event": PluginCapabilityEventPayload;
}

/** Contract for progress bus. */
export interface ProgressBus {
  pendingPluginEvents(): PluginCapabilityEventPayload[];
  acknowledgePluginInteraction(pluginId: string, callId: string, interactionId: string): void;
  emit<EventName extends keyof ProgressBusEventMap>(
    eventName: EventName,
    event: ProgressBusEventMap[EventName]
  ): void;
  on<EventName extends keyof ProgressBusEventMap>(
    eventName: EventName,
    listener: (event: ProgressBusEventMap[EventName]) => void
  ): () => void;
}

/** Creates create progress bus. */
export function createProgressBus(): ProgressBus {
  const emitter = new EventEmitter();
  // Reconnecting a renderer must not lose the only card a running tool awaits.
  // Keep only live calls; terminal calls and acknowledged prompts are retired.
  const pluginCalls = new Map<string, PluginCapabilityEventPayload[]>();

  return {
    pendingPluginEvents() { return [...pluginCalls.values()].flat(); },
    acknowledgePluginInteraction(pluginId, callId, interactionId) {
      const key = `${pluginId}:${callId}`;
      const events = pluginCalls.get(key);
      if (events) pluginCalls.set(key, events.filter(({ event }) => event.type !== "interaction" || event.request.interactionId !== interactionId));
    },
    emit(eventName, event) {
      if (eventName === "plugin.capability_event") {
        const payload = event as PluginCapabilityEventPayload;
        const key = `${payload.pluginId}:${payload.callId}`;
        if (payload.event.type === "result" || payload.event.type === "error") pluginCalls.delete(key);
        else {
          const retained = pluginCalls.get(key) ?? [];
          const next = payload.event;
          pluginCalls.set(key, [...retained.filter(({ event: prior }) => {
            if (next.type === "progress" || next.type === "task-list") return prior.type !== next.type;
            if (next.type === "interaction") return prior.type !== "interaction" || prior.request.interactionId !== next.request.interactionId;
            if (next.type === "artifact") return prior.type !== "artifact" || prior.artifact.id !== next.artifact.id;
            return true;
          }), payload]);
        }
      }
      emitter.emit(eventName, event);
    },

    on(eventName, listener) {
      emitter.on(eventName, listener);
      return () => {
        emitter.off(eventName, listener);
      };
    }
  };
}
