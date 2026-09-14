import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
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

export interface PluginInvocationContext {
  pluginId: string;
  capabilityId: string;
  conversationId: string;
  input: unknown;
}

export interface PluginChatFeedback {
  message: string;
  clientRequestId: string;
}

interface PluginUiContextValue {
  registerChatFeedback(conversationId: string, handler: (feedback: PluginChatFeedback) => void): () => void;
  notifyChatMessage(chatId: string, feedback: PluginChatFeedback): void;
  fileDrafts: Map<string, File[]>;
  calls: PluginUiCall[];
  activeSurface: PluginInvocationContext | null;
  openSurface(context: PluginInvocationContext): void;
  closeSurface(): void;
  receive(payload: PluginCapabilityEventPayload): void;
}

const MAX_PLUGIN_CALLS = 50;
const PluginUiContext = createContext<PluginUiContextValue | null>(null);

export function PluginUiProvider(props: { children: ReactNode }) {
  const feedbackHandlers = useRef(new Map<symbol, { conversationId: string; handler: (feedback: PluginChatFeedback) => void }>());
  const fileDrafts = useRef(new Map<string, File[]>()).current;
  const registerChatFeedback = useCallback((conversationId: string, handler: (feedback: PluginChatFeedback) => void) => {
    const id = Symbol();
    feedbackHandlers.current.set(id, { conversationId, handler });
    return () => { feedbackHandlers.current.delete(id); };
  }, []);
  const notifyChatMessage = useCallback((chatId: string, feedback: PluginChatFeedback) => {
    const sessionKey = chatId.startsWith("websocket:") ? chatId : `websocket:${chatId}`;
    for (const entry of [...feedbackHandlers.current.values()]) {
      if (entry.conversationId === chatId || entry.conversationId === sessionKey) entry.handler(feedback);
    }
  }, []);
  const [calls, setCalls] = useState<PluginUiCall[]>([]);
  const [activeSurface, setActiveSurface] = useState<PluginInvocationContext | null>(null);
  const receive = useCallback((payload: PluginCapabilityEventPayload) => {
    setCalls((current) => reducePluginUiCalls(current, payload));
  }, []);
  const openSurface = useCallback((context: PluginInvocationContext) => setActiveSurface(context), []);
  const closeSurface = useCallback(() => setActiveSurface(null), []);
  const value = useMemo(() => ({ calls, activeSurface, openSurface, closeSurface, receive, registerChatFeedback, notifyChatMessage, fileDrafts }), [activeSurface, calls, closeSurface, openSurface, receive, registerChatFeedback, notifyChatMessage, fileDrafts]);
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

/** Optional for standalone renderer previews; routes only messages from the same conversation. */
export function usePluginChatFeedback(conversationId: string | undefined, handler: (feedback: PluginChatFeedback) => void) {
  const context = useContext(PluginUiContext);
  const latest = useRef(handler);
  latest.current = handler;
  const register = context?.registerChatFeedback;
  useEffect(() => {
    if (register && conversationId) return register(conversationId, (feedback) => latest.current(feedback));
  }, [register, conversationId]);
  return context?.fileDrafts;
}
