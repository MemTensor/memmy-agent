import type { RuntimeNamespace } from "../types.js";
import {
  compactAnalyticsParams,
  createCliAnalytics,
  elapsedMs,
  errorCodeFromUnknown,
  resolveAnalyticsAppEnv,
  resolveAnalyticsDebugMode,
  type AnalyticsParams,
  type CliLifecycleAnalytics,
} from "../cli/analytics.js";

export const PLUGIN_RUNTIME_EVENTS = {
  hookRecallStarted: "memory_plugin_hook_recall_started",
  hookRecallSucceeded: "memory_plugin_hook_recall_succeeded",
  hookRecallFailed: "memory_plugin_hook_recall_failed",
  hookCaptureStarted: "memory_plugin_hook_capture_started",
  hookCaptureSucceeded: "memory_plugin_hook_capture_succeeded",
  hookCaptureFailed: "memory_plugin_hook_capture_failed",
  toolCallStarted: "memory_plugin_tool_call_started",
  toolCallSucceeded: "memory_plugin_tool_call_succeeded",
  toolCallFailed: "memory_plugin_tool_call_failed",
} as const;

export type PluginRuntimeEventName =
  (typeof PLUGIN_RUNTIME_EVENTS)[keyof typeof PLUGIN_RUNTIME_EVENTS];

export type PluginTarget = "hook" | "native_plugin";

export type PluginRuntimeAttribution = {
  source?: unknown;
  adapterId?: unknown;
  namespace?: RuntimeNamespace;
  hookName?: unknown;
  turnId?: unknown;
};

const EXTERNAL_AGENT_SOURCE_IDS = new Set([
  "cursor",
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
]);

const HOOK_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex"]);
const NATIVE_PLUGIN_AGENT_SOURCE_IDS = new Set(["opencode", "openclaw", "hermes"]);

const PLUGIN_RUNTIME_SOURCE = "memmy-memory";

export type PluginRuntimeAnalytics = CliLifecycleAnalytics;

export type PluginRuntimeBaseParams = AnalyticsParams & {
  source_id: string;
  source_kind: PluginTarget;
};

export function createPluginRuntimeAnalytics(options: {
  getClientId?: () => string | null | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): PluginRuntimeAnalytics {
  const inner = createCliAnalytics({
    ...options,
    source: PLUGIN_RUNTIME_SOURCE,
  });
  const debugMode = resolveAnalyticsDebugMode(undefined, resolveAnalyticsAppEnv());

  return {
    track(eventName, params = {}) {
      if (debugMode) {
        console.log("[analytics] plugin runtime track:", eventName, params);
      }
      inner.track(eventName, params);
    },
    trackAwait(eventName, params = {}) {
      if (debugMode) {
        console.log("[analytics] plugin runtime trackAwait:", eventName, params);
      }
      return inner.trackAwait(eventName, params);
    },
    flush() {
      return inner.flush();
    },
  };
}

export function resolveExternalAgentSource(input: PluginRuntimeAttribution): string | null {
  const directSource = stringValue(input.source) ?? stringValue(input.namespace?.source);
  if (directSource && EXTERNAL_AGENT_SOURCE_IDS.has(directSource)) {
    return directSource;
  }

  const adapterId = stringValue(input.adapterId);
  if (!adapterId) return null;

  const hookMatch = /^memmy-(.+)-hook$/u.exec(adapterId);
  if (hookMatch?.[1] && EXTERNAL_AGENT_SOURCE_IDS.has(hookMatch[1])) {
    return hookMatch[1];
  }

  const pluginMatch = /^memmy-(.+)-plugin$/u.exec(adapterId);
  if (pluginMatch?.[1] && EXTERNAL_AGENT_SOURCE_IDS.has(pluginMatch[1])) {
    return pluginMatch[1];
  }

  return null;
}

/**
 * Tool-call analytics are reserved for local native plugins (opencode/openclaw/hermes).
 * Desktop agent-source scans and hook integrations must not emit tool_call_* events —
 * scans use source=<agent> + adapterId=agent-source:*; hooks already have hook_* events.
 */
export function resolveExternalPluginToolCallSource(
  input: PluginRuntimeAttribution,
): string | null {
  const adapterId = stringValue(input.adapterId);
  if (adapterId?.startsWith("agent-source:")) return null;

  if (adapterId) {
    const pluginMatch = /^memmy-(.+)-plugin$/u.exec(adapterId);
    if (pluginMatch?.[1] && NATIVE_PLUGIN_AGENT_SOURCE_IDS.has(pluginMatch[1])) {
      return pluginMatch[1];
    }
  }

  const directSource = stringValue(input.source) ?? stringValue(input.namespace?.source);
  if (directSource && NATIVE_PLUGIN_AGENT_SOURCE_IDS.has(directSource)) {
    return directSource;
  }

  return null;
}

export function resolvePluginTarget(agentSourceId: string): PluginTarget | undefined {
  if (HOOK_AGENT_SOURCE_IDS.has(agentSourceId)) return "hook";
  if (NATIVE_PLUGIN_AGENT_SOURCE_IDS.has(agentSourceId)) return "native_plugin";
  return undefined;
}

export function buildPluginRuntimeBaseParams(
  agentSourceId: string,
  input: PluginRuntimeAttribution,
  hookNameDefault: string,
): PluginRuntimeBaseParams | null {
  const pluginTarget = resolvePluginTarget(agentSourceId);
  if (!pluginTarget) return null;
  return compactAnalyticsParams({
    source_id: agentSourceId,
    source_kind: pluginTarget,
    hook_name: resolveHookName(input.hookName, hookNameDefault),
    ...(stringValue(input.adapterId) ? { adapter_id: stringValue(input.adapterId) } : {}),
  }) as PluginRuntimeBaseParams;
}

export function resolveHookName(value: unknown, fallback: string): string {
  const trimmed = stringValue(value);
  return trimmed ?? fallback;
}

export function resolveCaptureFallbackMode(turnId: unknown): string | undefined {
  const normalized = stringValue(turnId);
  if (normalized?.includes("-fallback-")) return "synthetic_turn_id";
  return undefined;
}

export function hitCountFromTurnStartResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const ids = (response as { sourceMemoryIds?: unknown }).sourceMemoryIds;
  if (Array.isArray(ids)) {
    return ids.filter((id) => typeof id === "string" && id.trim()).length;
  }
  const hits = (response as { hits?: unknown }).hits;
  return Array.isArray(hits) ? hits.length : 0;
}

export function hasInjectedContextFromTurnStartResponse(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const injected = (response as { injectedContext?: unknown }).injectedContext;
  if (typeof injected === "string") return Boolean(injected.trim());
  if (!injected || typeof injected !== "object") return false;
  const markdown = (injected as { markdown?: unknown }).markdown;
  return typeof markdown === "string" && Boolean(markdown.trim());
}

export function storedCountFromCompleteTurnResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const record = response as { l1MemoryIds?: unknown; l1MemoryId?: unknown };
  if (Array.isArray(record.l1MemoryIds)) {
    const count = record.l1MemoryIds.filter((id) => typeof id === "string" && id.trim()).length;
    if (count > 0) return count;
  }
  return typeof record.l1MemoryId === "string" && record.l1MemoryId.trim() ? 1 : 0;
}

export function toolCallCountFromCompleteTurnRequest(request: unknown): number | undefined {
  if (!request || typeof request !== "object") return undefined;
  const toolCalls = (request as { toolCalls?: unknown }).toolCalls;
  return Array.isArray(toolCalls) ? toolCalls.length : undefined;
}

export function hitCountFromSearchResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const record = response as { debug?: { hits?: unknown }; hits?: unknown };
  const hits = Array.isArray(record.hits)
    ? record.hits
    : Array.isArray(record.debug?.hits)
      ? record.debug.hits
      : [];
  return hits.length;
}

export function hitCountFromGetResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? 1 : 0;
}

export function storedCountFromAddResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const id = (response as { id?: unknown; memoryId?: unknown }).id ?? (response as { memoryId?: unknown }).memoryId;
  return typeof id === "string" && id.trim() ? 1 : 0;
}

export async function trackExternalHookRecall<T>(
  analytics: PluginRuntimeAnalytics,
  input: PluginRuntimeAttribution,
  run: () => Promise<T>,
): Promise<T> {
  const agentSourceId = resolveExternalAgentSource(input);
  if (!agentSourceId) return run();

  const baseParams = buildPluginRuntimeBaseParams(agentSourceId, input, "turn_start");
  if (!baseParams) return run();

  const startedAt = Date.now();
  analytics.track(PLUGIN_RUNTIME_EVENTS.hookRecallStarted, compactAnalyticsParams({
    ...baseParams,
    status: "started",
  }));
  try {
    const result = await run();
    analytics.track(PLUGIN_RUNTIME_EVENTS.hookRecallSucceeded, compactAnalyticsParams({
      ...baseParams,
      status: "succeeded",
      latency_ms: elapsedMs(startedAt),
      success: true,
      hit_count: hitCountFromTurnStartResponse(result),
      has_injected_context: hasInjectedContextFromTurnStartResponse(result),
    }));
    return result;
  } catch (error) {
    analytics.track(PLUGIN_RUNTIME_EVENTS.hookRecallFailed, compactAnalyticsParams({
      ...baseParams,
      status: "failed",
      latency_ms: elapsedMs(startedAt),
      success: false,
      error_code: errorCodeFromUnknown(error),
    }));
    throw error;
  }
}

export async function trackExternalHookCapture<T>(
  analytics: PluginRuntimeAnalytics,
  input: PluginRuntimeAttribution,
  request: unknown,
  run: () => Promise<T> | T,
): Promise<T> {
  const agentSourceId = resolveExternalAgentSource(input);
  if (!agentSourceId) return await run();

  const baseParams = buildPluginRuntimeBaseParams(agentSourceId, input, "turn_complete");
  if (!baseParams) return await run();

  const fallbackMode = resolveCaptureFallbackMode(input.turnId);
  const startedAt = Date.now();
  analytics.track(PLUGIN_RUNTIME_EVENTS.hookCaptureStarted, compactAnalyticsParams({
    ...baseParams,
    status: "started",
    ...(fallbackMode ? { fallback_mode: fallbackMode } : {}),
  }));
  try {
    const result = await run();
    const toolCallCount = toolCallCountFromCompleteTurnRequest(request);
    analytics.track(PLUGIN_RUNTIME_EVENTS.hookCaptureSucceeded, compactAnalyticsParams({
      ...baseParams,
      status: "succeeded",
      ...(fallbackMode ? { fallback_mode: fallbackMode } : {}),
      latency_ms: elapsedMs(startedAt),
      success: true,
      stored_count: storedCountFromCompleteTurnResponse(result),
      ...(typeof toolCallCount === "number" ? { tool_call_count: toolCallCount } : {}),
    }));
    return result;
  } catch (error) {
    analytics.track(PLUGIN_RUNTIME_EVENTS.hookCaptureFailed, compactAnalyticsParams({
      ...baseParams,
      status: "failed",
      ...(fallbackMode ? { fallback_mode: fallbackMode } : {}),
      latency_ms: elapsedMs(startedAt),
      success: false,
      error_code: errorCodeFromUnknown(error),
    }));
    throw error;
  }
}

export async function trackExternalToolCall<T>(
  analytics: PluginRuntimeAnalytics,
  input: PluginRuntimeAttribution & { toolName: string },
  run: () => Promise<T> | T,
  mapSuccess: (result: T) => AnalyticsParams,
): Promise<T> {
  const agentSourceId = resolveExternalPluginToolCallSource(input);
  if (!agentSourceId) return await run();

  const baseParams = buildPluginRuntimeBaseParams(agentSourceId, input, input.toolName);
  if (!baseParams) return await run();

  const startedAt = Date.now();
  analytics.track(PLUGIN_RUNTIME_EVENTS.toolCallStarted, compactAnalyticsParams({
    ...baseParams,
    status: "started",
    tool_name: input.toolName,
  }));
  try {
    const result = await run();
    analytics.track(PLUGIN_RUNTIME_EVENTS.toolCallSucceeded, compactAnalyticsParams({
      ...baseParams,
      status: "succeeded",
      tool_name: input.toolName,
      latency_ms: elapsedMs(startedAt),
      success: true,
      ...mapSuccess(result),
    }));
    return result;
  } catch (error) {
    analytics.track(PLUGIN_RUNTIME_EVENTS.toolCallFailed, compactAnalyticsParams({
      ...baseParams,
      status: "failed",
      tool_name: input.toolName,
      latency_ms: elapsedMs(startedAt),
      success: false,
      error_code: errorCodeFromUnknown(error),
    }));
    throw error;
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
