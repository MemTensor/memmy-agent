import type { MemoryListItem, MemoryProcessingRecord, MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import type { SessionRecord } from "../../storage/repositories.js";
import {
  IMPORT_FAILED_TAG,
  IMPORT_INDEXING_TAG,
  IMPORT_STATUS_TAGS,
  IMPORT_SUMMARY_PROCESSING_TAG
} from "../import/memory-import-pipeline.js";
import { panelDateKey, panelRoundDecimal } from "./model-costs.js";

export function panelListItemFromMemory(
  item: MemoryListItem,
  memory: MemoryRow,
  processing?: MemoryProcessingRecord,
  session?: SessionRecord
): MemoryListItem {
  const spanGoal = panelSpanGoalForMemory(memory);
  const namespace = panelNamespaceForMemory(memory, session);
  return {
    ...item,
    processing,
    metadata: {
      ...(item.metadata ?? {}),
      source: panelSourceForMemory(memory),
      namespace,
      ...(spanGoal ? { spanGoal } : {})
    },
    tags: panelTagsForMemory(memory, processing)
  };
}

function panelSpanGoalForMemory(memory: MemoryRow): string | undefined {
  if (memory.properties.internal_info.memory_kind !== "span") return undefined;
  const span = isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : {};
  const goal = span.span_goal;
  return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
}

export function panelSourceDistribution(memories: MemoryRow[]): Array<{ source: string; count: number; percentage: number }> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const source = panelSourceForMemory(memory);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      count,
      percentage: memories.length > 0 ? panelRoundDecimal((count / memories.length) * 100, 1) : 0
    }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export interface PanelNamespaceSummary {
  tenantId: string;
  projectId: string;
  workspaceId?: string;
  workspacePath?: string;
  label: string;
}

export function panelNamespaceForMemory(memory: MemoryRow, session?: SessionRecord): PanelNamespaceSummary {
  const provenance = isRecord(memory.properties.internal_info.provenance)
    ? memory.properties.internal_info.provenance
    : {};
  const tenantId = firstString(
    session?.meta.tenant_id,
    session?.meta.tenantId,
    memory.info.tenant_id,
    memory.info.tenantId,
    provenance.tenantId
  ) ?? "local";
  const projectId = firstString(
    session?.projectId,
    memory.info.project_id,
    memory.info.projectId,
    provenance.projectId,
    memory.appId
  ) ?? "unscoped";
  const workspaceId = firstString(
    session?.workspaceId,
    memory.info.workspace_id,
    memory.info.workspaceId,
    provenance.workspaceId,
    memory.appId
  );
  const workspacePath = firstString(
    session?.workspacePath,
    memory.info.workspace_path,
    memory.info.workspacePath,
    provenance.workspacePath
  );
  return {
    tenantId,
    projectId,
    workspaceId,
    workspacePath,
    label: panelNamespaceLabel(projectId, workspacePath, workspaceId)
  };
}

export function panelNamespaceDistribution(
  memories: MemoryRow[],
  sessionForMemory: (memory: MemoryRow) => SessionRecord | undefined
): Array<PanelNamespaceSummary & { count: number; percentage: number }> {
  const counts = new Map<string, { namespace: PanelNamespaceSummary; count: number }>();
  for (const memory of memories) {
    const namespace = panelNamespaceForMemory(memory, sessionForMemory(memory));
    const key = `${namespace.tenantId}:${namespace.projectId}:${namespace.workspaceId ?? ""}`;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
    } else {
      counts.set(key, { namespace, count: 1 });
    }
  }

  return Array.from(counts.values())
    .map(({ namespace, count }) => ({
      ...namespace,
      count,
      percentage: memories.length > 0 ? panelRoundDecimal((count / memories.length) * 100, 1) : 0
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function panelCountByDate<T>(
  rows: T[],
  dates: string[],
  getTime: (row: T) => string | undefined
): Array<{ date: string; count: number }> {
  const counts = new Map(dates.map((date) => [date, 0]));
  for (const row of rows) {
    const key = panelDateKey(getTime(row));
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function panelTagsForMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): string[] {
  const tags = memory.tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag));
  if (memory.status === "archived" || memory.status === "deleted" || !processing) return tags;
  const label = processing.state === "summary_pending" || processing.state === "summarizing"
    ? IMPORT_SUMMARY_PROCESSING_TAG
    : processing.state === "embedding_pending" || processing.state === "embedding"
      ? IMPORT_INDEXING_TAG
      : processing.state === "failed"
        ? IMPORT_FAILED_TAG
        : undefined;
  return label ? uniq([...tags, label]) : tags;
}

export function panelSourceForMemory(memory: MemoryRow): string {
  const internalInfo: Record<string, unknown> = isRecord(memory.properties.internal_info)
    ? memory.properties.internal_info
    : {};
  const explicitSources = [memory.info.source, internalInfo.source];
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

function panelNamespaceLabel(projectId: string, workspacePath: string | undefined, workspaceId: string | undefined): string {
  if (workspacePath) {
    const parts = workspacePath.split("/").filter(Boolean);
    return parts[parts.length - 1] || workspacePath;
  }
  if (projectId !== "unscoped") return projectId;
  return workspaceId ?? "unscoped";
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


function uniq(values: string[]): string[] {
  return [...new Set(values)];
}
