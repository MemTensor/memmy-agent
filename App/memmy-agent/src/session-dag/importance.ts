import type { DagNodeKind, DagNodeStatus } from "./types.js";

export function normalizeImportance(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

export function fallbackImportance(kind: DagNodeKind, status: DagNodeStatus): number {
  if (kind === "task") return status === "done" ? 70 : 80;
  if (status === "blocked") return 65;
  if (status === "failed" || status === "frozen") return 50;
  return 50;
}
