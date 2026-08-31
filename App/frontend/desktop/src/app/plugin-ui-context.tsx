import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { CapabilityEvent, PluginCapabilityEventPayload } from "@memmy/local-api-contracts";

export interface PluginUiCall {
  pluginId: string;
  capabilityId: string;
  callId: string;
  conversationId: string;
  events: CapabilityEvent[];
}

interface PluginUiContextValue {
  calls: PluginUiCall[];
  receive(payload: PluginCapabilityEventPayload): void;
}

const MAX_PLUGIN_CALLS = 50;
const PluginUiContext = createContext<PluginUiContextValue | null>(null);

export function PluginUiProvider(props: { children: ReactNode }) {
  const [calls, setCalls] = useState<PluginUiCall[]>([]);
  const receive = useCallback((payload: PluginCapabilityEventPayload) => {
    setCalls((current) => reducePluginUiCalls(current, payload));
  }, []);
  const value = useMemo(() => ({ calls, receive }), [calls, receive]);
  return <PluginUiContext.Provider value={value}>{props.children}</PluginUiContext.Provider>;
}

export function usePluginUi(): PluginUiContextValue {
  const value = useContext(PluginUiContext);
  if (!value) throw new Error("usePluginUi must be used within PluginUiProvider");
  return value;
}

export function reducePluginUiCalls(
  calls: PluginUiCall[],
  payload: PluginCapabilityEventPayload
): PluginUiCall[] {
  const index = calls.findIndex((call) => call.pluginId === payload.pluginId && call.callId === payload.callId);
  if (index < 0) {
    return [...calls, {
      pluginId: payload.pluginId,
      capabilityId: payload.capabilityId,
      callId: payload.callId,
      conversationId: payload.conversationId,
      events: [payload.event]
    }].slice(-MAX_PLUGIN_CALLS);
  }
  const current = calls[index]!;
  const next = [...calls];
  next[index] = { ...current, events: mergeCapabilityEvent(current.events, payload.event) };
  return next;
}

function mergeCapabilityEvent(events: CapabilityEvent[], event: CapabilityEvent): CapabilityEvent[] {
  const replaces = (candidate: CapabilityEvent): boolean => {
    if (event.type === "progress" || event.type === "task-list") return candidate.type === event.type;
    if (event.type === "result" || event.type === "error") return candidate.type === "result" || candidate.type === "error";
    if (event.type === "interaction") {
      return candidate.type === "interaction" && candidate.request.interactionId === event.request.interactionId;
    }
    return event.type === "artifact" && candidate.type === "artifact" && candidate.artifact.id === event.artifact.id;
  };
  const index = events.findIndex(replaces);
  if (index < 0) return [...events, event];
  const next = [...events];
  next[index] = event;
  return next;
}
