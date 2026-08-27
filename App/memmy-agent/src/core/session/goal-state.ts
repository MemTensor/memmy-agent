import type { SessionManager } from "./manager.js";
import { parseTurnSource, type TurnSource } from "../runtime-messages/events.js";

export const GOAL_STATE_KEY = "goalState";
export const GOAL_ROUTE_KEY = "goalRoute";
export const GOAL_TURN_INBOX_KEY = "goalTurnInbox";
export const MAX_GOAL_OBJECTIVE_LENGTH = 12_000;

export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "completed",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalState = {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalRoute = {
  channel: string;
  chatId: string;
  source?: TurnSource;
};

export type AgentGoalState = {
  goal_id: string | null;
  status: GoalStatus | null;
  objective: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: string | null;
  updated_at: string | null;
};

const GOAL_STATE_KEYS = new Set([
  "goalId",
  "objective",
  "status",
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "createdAt",
  "updatedAt",
]);
const LEGACY_GOAL_ROUTE_KEYS = new Set(["channel", "chatId"]);
const GOAL_ROUTE_KEYS = new Set(["channel", "chatId", "source"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

export function parseGoalState(value: unknown): GoalState | null {
  if (!isObject(value) || !hasExactKeys(value, GOAL_STATE_KEYS)) return null;
  if (typeof value.goalId !== "string" || !UUID_PATTERN.test(value.goalId)) return null;
  if (
    typeof value.objective !== "string"
    || !value.objective.trim()
    || value.objective.length > MAX_GOAL_OBJECTIVE_LENGTH
  ) return null;
  if (!isGoalStatus(value.status)) return null;
  if (
    value.tokenBudget !== null
    && (!Number.isSafeInteger(value.tokenBudget) || Number(value.tokenBudget) <= 0)
  ) return null;
  if (!isNonNegativeInteger(value.tokensUsed)) return null;
  if (!isNonNegativeInteger(value.timeUsedSeconds)) return null;
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return null;
  return value as GoalState;
}

export function goalStateRaw(metadata?: Record<string, unknown> | null): unknown {
  return metadata?.[GOAL_STATE_KEY] ?? null;
}

export function readGoalState(metadata?: Record<string, unknown> | null): GoalState | null {
  return parseGoalState(goalStateRaw(metadata));
}

export function parseGoalRoute(value: unknown): GoalRoute | null {
  if (
    !isObject(value)
    || (!hasExactKeys(value, LEGACY_GOAL_ROUTE_KEYS) && !hasExactKeys(value, GOAL_ROUTE_KEYS))
  ) return null;
  if (typeof value.channel !== "string" || !value.channel.trim()) return null;
  if (typeof value.chatId !== "string" || !value.chatId.trim()) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "source")) {
    return { channel: value.channel, chatId: value.chatId };
  }
  const source = parseTurnSource(value.source);
  if (!source) return null;
  return { channel: value.channel, chatId: value.chatId, source };
}

export function readGoalRoute(metadata?: Record<string, unknown> | null): GoalRoute | null {
  return parseGoalRoute(metadata?.[GOAL_ROUTE_KEY]);
}

export function sustainedGoalActive(metadata?: Record<string, unknown> | null): boolean {
  return readGoalState(metadata)?.status === "active";
}

export function emptyAgentGoalState(): AgentGoalState {
  return {
    goal_id: null,
    status: null,
    objective: "",
    token_budget: null,
    tokens_used: 0,
    time_used_seconds: 0,
    created_at: null,
    updated_at: null,
  };
}

export function publicGoalState(goal: GoalState | null): AgentGoalState {
  if (!goal) return emptyAgentGoalState();
  return {
    goal_id: goal.goalId,
    status: goal.status,
    objective: goal.objective,
    token_budget: goal.tokenBudget,
    tokens_used: goal.tokensUsed,
    time_used_seconds: goal.timeUsedSeconds,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
  };
}

export function goalStateWsBlob(
  metadata?: Record<string, unknown> | null,
): AgentGoalState {
  return publicGoalState(readGoalState(metadata));
}

export function goalSummary(objective: string): string {
  return objective.split(/\r?\n/, 1)[0]!.slice(0, 120);
}

export function nextGoalUpdatedAt(previous: string, now = new Date()): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  return new Date(Math.max(nowMs, Number.isFinite(previousMs) ? previousMs + 1 : nowMs)).toISOString();
}

export function runnerWallLlmTimeoutS(
  sessions: SessionManager,
  sessionKey?: string | null,
  { metadata = null }: { metadata?: Record<string, unknown> | null } = {},
): number | null {
  let currentMetadata = metadata;
  if (currentMetadata == null && sessionKey) currentMetadata = sessions.getOrCreate(sessionKey).metadata;
  return sustainedGoalActive(currentMetadata) ? 0 : null;
}
