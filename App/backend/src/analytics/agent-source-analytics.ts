import type { AgentSourceStatus, ScanPermission } from "@memmy/local-api-contracts";
import {
  compactAnalyticsParams,
  createQueuedAnalytics,
  normalizeAnalyticsUserId,
  readAnalyticsClientId,
  type AnalyticsAppEdition,
  type AnalyticsAppEnv,
  type AnalyticsParams,
} from "./analytics-transport.js";

export const AGENT_SOURCE_ANALYTICS_EVENTS = {
  pluginInstalled: "agent_source_plugin_installed",
  pluginUninstalled: "agent_source_plugin_uninstalled",
  pluginConflictDetected: "agent_source_plugin_conflict_detected",
  skillInstalled: "agent_source_skill_installed",
  skillUninstalled: "agent_source_skill_uninstalled",
} as const;

export type AgentSourceAnalyticsEventName =
  (typeof AGENT_SOURCE_ANALYTICS_EVENTS)[keyof typeof AGENT_SOURCE_ANALYTICS_EVENTS];

export type AgentSourceInstallType =
  | "manual"
  | "onboarding"
  | "auto_inject"
  | "conflict_replace";

export type AgentSourceKind = "hook" | "native_plugin" | "skill" | "managed_skill";

const HOOK_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex"]);
const NATIVE_PLUGIN_AGENT_SOURCE_IDS = new Set(["opencode", "openclaw", "hermes", "deepseek_harness"]);
const AGENT_SOURCE_ANALYTICS_SOURCE = "memmy-backend";

export type AgentSourceLifecycleAnalytics = {
  trackPluginInstalled: (input: AgentSourcePluginLifecycleInput) => void;
  trackPluginUninstalled: (input: AgentSourcePluginLifecycleInput) => void;
  trackSkillInstalled: (input: AgentSourceSkillLifecycleInput) => void;
  trackSkillUninstalled: (input: AgentSourceSkillLifecycleInput) => void;
  trackPluginConflictDetected: (input: AgentSourceConflictInput) => void;
  flush: () => Promise<void>;
};

export type AgentSourcePluginLifecycleInput = {
  sourceId: string;
  permission?: ScanPermission;
  statusBefore?: AgentSourceStatus;
  statusAfter?: AgentSourceStatus;
  installType?: AgentSourceInstallType;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type AgentSourceSkillLifecycleInput = {
  sourceId: string;
  builtin?: boolean;
  permission?: ScanPermission;
  statusBefore?: AgentSourceStatus;
  statusAfter?: AgentSourceStatus;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type AgentSourceConflictInput = {
  sourceId: string;
  configPath: string;
  installedPluginId: string;
  permission?: ScanPermission;
};

export function resolvePluginSourceKind(sourceId: string): AgentSourceKind | undefined {
  if (HOOK_AGENT_SOURCE_IDS.has(sourceId)) return "hook";
  if (NATIVE_PLUGIN_AGENT_SOURCE_IDS.has(sourceId)) return "native_plugin";
  return undefined;
}

export function resolveSkillSourceKind(sourceId: string, builtin = true): AgentSourceKind {
  if (!builtin) return "managed_skill";
  return "skill";
}

/** Logged-in account users only; requires cloudUuid gate (same as CLI). */
export function resolveLoggedInAnalyticsUserId(input: {
  cloudUuid?: string | null;
  userId?: string | null;
}): string | null {
  if (!input.cloudUuid?.trim()) return null;
  return normalizeAnalyticsUserId(input.userId);
}

export function buildAgentSourcePluginLifecycleParams(
  input: AgentSourcePluginLifecycleInput,
): AnalyticsParams {
  const sourceKind = resolvePluginSourceKind(input.sourceId);
  return compactAnalyticsParams({
    source_id: input.sourceId,
    ...(sourceKind ? { source_kind: sourceKind } : {}),
    ...(input.permission ? { permission: input.permission } : {}),
    ...(input.statusBefore ? { status_before: input.statusBefore } : {}),
    ...(input.statusAfter ? { status_after: input.statusAfter } : {}),
    ...(input.installType ? { install_type: input.installType } : {}),
    latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
    success: input.success,
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
  });
}

export function buildAgentSourceSkillLifecycleParams(
  input: AgentSourceSkillLifecycleInput,
): AnalyticsParams {
  return compactAnalyticsParams({
    source_id: input.sourceId,
    source_kind: resolveSkillSourceKind(input.sourceId, input.builtin ?? true),
    ...(input.permission ? { permission: input.permission } : {}),
    ...(input.statusBefore ? { status_before: input.statusBefore } : {}),
    ...(input.statusAfter ? { status_after: input.statusAfter } : {}),
    latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
    success: input.success,
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
  });
}

export function buildAgentSourceConflictParams(input: AgentSourceConflictInput): AnalyticsParams {
  const sourceKind = resolvePluginSourceKind(input.sourceId);
  return compactAnalyticsParams({
    source_id: input.sourceId,
    ...(sourceKind ? { source_kind: sourceKind } : {}),
    ...(input.permission ? { permission: input.permission } : {}),
    config_path: input.configPath,
    installed_plugin_id: input.installedPluginId,
    success: true,
  });
}

export function createAgentSourceLifecycleAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): AgentSourceLifecycleAnalytics {
  const queued = createQueuedAnalytics({
    source: AGENT_SOURCE_ANALYTICS_SOURCE,
    getClientId: options.getClientId ?? (() => readAnalyticsClientId()),
    getUserId: options.getUserId,
    getUserMode: options.getUserMode,
    appEnv: options.appEnv,
    appEdition: options.appEdition,
    debugMode: options.debugMode,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });

  return {
    trackPluginInstalled(input) {
      queued.track(
        AGENT_SOURCE_ANALYTICS_EVENTS.pluginInstalled,
        buildAgentSourcePluginLifecycleParams(input),
      );
    },
    trackPluginUninstalled(input) {
      queued.track(
        AGENT_SOURCE_ANALYTICS_EVENTS.pluginUninstalled,
        buildAgentSourcePluginLifecycleParams(input),
      );
    },
    trackSkillInstalled(input) {
      queued.track(
        AGENT_SOURCE_ANALYTICS_EVENTS.skillInstalled,
        buildAgentSourceSkillLifecycleParams(input),
      );
    },
    trackSkillUninstalled(input) {
      queued.track(
        AGENT_SOURCE_ANALYTICS_EVENTS.skillUninstalled,
        buildAgentSourceSkillLifecycleParams(input),
      );
    },
    trackPluginConflictDetected(input) {
      queued.track(
        AGENT_SOURCE_ANALYTICS_EVENTS.pluginConflictDetected,
        buildAgentSourceConflictParams(input),
      );
    },
    flush() {
      return queued.flush();
    },
  };
}
