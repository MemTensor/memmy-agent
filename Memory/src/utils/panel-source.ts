import type { MemoryStatsRow } from "../types.js";

export function panelSourceForStatsRow(memory: Pick<MemoryStatsRow, "infoSource" | "internalSource" | "sessionId" | "conversationId" | "agentId" | "appId">): string {
  const explicitSources = [memory.infoSource, memory.internalSource];
  const explicitSource = firstString(...explicitSources.map(panelNormalizeExplicitSource));
  if (explicitSource) return explicitSource;

  const hostSource = firstString(
    panelNormalizeKnownSource(memory.sessionId),
    panelNormalizeKnownSource(memory.conversationId),
    panelNormalizeSourceAgent(memory.agentId),
    panelNormalizeSourceAgent(memory.appId)
  );
  if (hostSource) return hostSource;
  return explicitSources.some(panelIsInternalSourceValue) ? "memmy" : "unknown";
}

function panelNormalizeExplicitSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (panelIsInternalSource(normalized)) return undefined;
  return panelNormalizeKnownSource(normalized) ?? normalized;
}

function panelNormalizeKnownSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized.startsWith("claude-")) return "claude-code";
  if (normalized === "open-code" || normalized.startsWith("open-code-")) return "opencode";
  for (const source of ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "manual", "memmy"]) {
    if (normalized === source || normalized.startsWith(`${source}-`)) return source;
  }
  return undefined;
}

function panelNormalizeSourceAgent(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  return panelNormalizeKnownSource(normalized) ?? normalized;
}

function panelIsInternalSourceValue(value: unknown): boolean {
  return typeof value === "string" && panelIsInternalSource(value.trim().toLowerCase());
}

function panelIsInternalSource(value: string): boolean {
  return /^(?:turn|worker|panel|system|feedback|memory|session|episode|recall|skill_trial|l2_candidate)(?:[.:_-]|$)/.test(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
