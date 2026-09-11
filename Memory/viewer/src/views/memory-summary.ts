import type { TraceDTO } from "../api/types.js";

const PLACEHOLDER_SUMMARIES = new Set([
  "(empty turn)",
  "(empty trace)",
  "(empty)",
  "摘要排队中",
  "摘要整理中",
  "摘要总结中",
]);

export function pickSummary(trace: TraceDTO): string {
  const summary = usableSummary(trace.summary);
  if (summary) return summary;

  const userText = compact(trace.userText);
  if (userText) return truncate(userText);

  const agentText = compact(trace.agentText);
  return agentText ? truncate(agentText) : "(empty trace)";
}

export function usableSummary(summary: string | null | undefined): string {
  const value = (summary ?? "").trim();
  return value && !PLACEHOLDER_SUMMARIES.has(value.toLowerCase()) ? value : "";
}

function compact(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}
