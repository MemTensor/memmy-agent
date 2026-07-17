import { SessionManager } from "./manager.js";

export const GOAL_STATE_KEY = "goalState";
const MAX_OBJECTIVE_IN_RUNTIME = 4000;
const MAX_OBJECTIVE_WS = 600;

function sessionGoalRaw(metadata?: Record<string, any> | null): any {
  if (!metadata) return null;
  return metadata[GOAL_STATE_KEY];
}

export function goalStateRaw(metadata?: Record<string, any> | null): any {
  return sessionGoalRaw(metadata);
}

export function parseGoalState(blob: any): Record<string, any> | null {
  if (blob == null) return null;
  if (typeof blob === "object" && !Array.isArray(blob)) return blob;
  if (typeof blob === "string") {
    try {
      const parsed = JSON.parse(blob);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function sustainedGoalActive(metadata?: Record<string, any> | null): boolean {
  return parseGoalState(sessionGoalRaw(metadata))?.status === "active";
}

export function goalStateRuntimeLines(metadata?: Record<string, any> | null): string[] {
  const goal = parseGoalState(sessionGoalRaw(metadata));
  if (goal?.status !== "active") return [];
  let objective = String(goal.objective ?? "").trim();
  if (!objective) return ["Goal: active (no objective text stored)."];
  if (objective.length > MAX_OBJECTIVE_IN_RUNTIME) {
    objective = `${objective.slice(0, MAX_OBJECTIVE_IN_RUNTIME).trimEnd()}\n... (truncated)`;
  }
  const out = ["Goal (active):", objective];
  const hint = String(goal.uiSummary ?? "").trim();
  if (hint) out.push(`Summary: ${hint}`);
  return out;
}

export function goalStateWsBlob(metadata?: Record<string, any> | null): Record<string, any> {
  const goal = parseGoalState(sessionGoalRaw(metadata));
  if (goal?.status !== "active") return { active: false };
  let objective = String(goal.objective ?? "").trim();
  if (objective.length > MAX_OBJECTIVE_WS) objective = `${objective.slice(0, MAX_OBJECTIVE_WS).trimEnd()}...`;
  const summary = String(goal.uiSummary ?? "").trim().slice(0, 120);
  const out: Record<string, any> = { active: true };
  if (summary) out.ui_summary = summary;
  if (objective) out.objective = objective;
  return out;
}

export function runnerWallLlmTimeoutS(
  sessions: SessionManager,
  sessionKey?: string | null,
  { metadata = null }: { metadata?: Record<string, any> | null } = {},
): number | null {
  let meta = metadata;
  if (meta == null && sessionKey) meta = sessions.getOrCreate(sessionKey).metadata;
  return sustainedGoalActive(meta) ? 0.0 : null;
}
