export const TASK_PLAN_STATE_KEY = "taskPlanState";
export const TASK_PLAN_ROUTE_KEY = "taskPlanRoute";
export const MAX_TASK_PLAN_TITLE_LENGTH = 300;
export const MAX_TASK_PLAN_ITEM_LENGTH = 1_000;
export const MAX_TASK_PLAN_ITEMS = 50;

export const TASK_PLAN_STATUSES = ["active", "completed", "blocked"] as const;
export const TASK_PLAN_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;

export type TaskPlanStatus = (typeof TASK_PLAN_STATUSES)[number];
export type TaskPlanItemStatus = (typeof TASK_PLAN_ITEM_STATUSES)[number];

export type TaskPlanItem = {
  id: string;
  content: string;
  status: TaskPlanItemStatus;
};

export type TaskPlanState = {
  planId: string;
  title: string;
  status: TaskPlanStatus;
  items: TaskPlanItem[];
  createdAt: string;
  updatedAt: string;
};

export type TaskPlanRoute = {
  channel: string;
  chatId: string;
};

export type AgentTaskPlanState = {
  plan_id: string | null;
  title: string;
  status: TaskPlanStatus | null;
  items: Array<{
    id: string;
    content: string;
    status: TaskPlanItemStatus;
  }>;
  created_at: string | null;
  updated_at: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_PLAN_KEYS = new Set([
  "planId",
  "title",
  "status",
  "items",
  "createdAt",
  "updatedAt",
]);
const TASK_PLAN_ITEM_KEYS = new Set(["id", "content", "status"]);
const TASK_PLAN_ROUTE_KEYS = new Set(["channel", "chatId"]);

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

export function isTaskPlanStatus(value: unknown): value is TaskPlanStatus {
  return typeof value === "string"
    && (TASK_PLAN_STATUSES as readonly string[]).includes(value);
}

export function isTaskPlanItemStatus(value: unknown): value is TaskPlanItemStatus {
  return typeof value === "string"
    && (TASK_PLAN_ITEM_STATUSES as readonly string[]).includes(value);
}

export function parseTaskPlanState(value: unknown): TaskPlanState | null {
  if (!isObject(value) || !hasExactKeys(value, TASK_PLAN_KEYS)) return null;
  if (typeof value.planId !== "string" || !UUID_PATTERN.test(value.planId)) return null;
  if (
    typeof value.title !== "string"
    || !value.title.trim()
    || value.title.length > MAX_TASK_PLAN_TITLE_LENGTH
  ) return null;
  if (!isTaskPlanStatus(value.status)) return null;
  if (
    !Array.isArray(value.items)
    || value.items.length < 3
    || value.items.length > MAX_TASK_PLAN_ITEMS
  ) return null;

  const ids = new Set<string>();
  for (const item of value.items) {
    if (!isObject(item) || !hasExactKeys(item, TASK_PLAN_ITEM_KEYS)) return null;
    if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) return null;
    if (
      typeof item.content !== "string"
      || !item.content.trim()
      || item.content.length > MAX_TASK_PLAN_ITEM_LENGTH
    ) return null;
    if (!isTaskPlanItemStatus(item.status)) return null;
    ids.add(item.id);
  }
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return null;
  return value as TaskPlanState;
}

export function readTaskPlanState(
  metadata?: Record<string, unknown> | null,
): TaskPlanState | null {
  return parseTaskPlanState(metadata?.[TASK_PLAN_STATE_KEY]);
}

export function parseTaskPlanRoute(value: unknown): TaskPlanRoute | null {
  if (!isObject(value) || !hasExactKeys(value, TASK_PLAN_ROUTE_KEYS)) return null;
  if (typeof value.channel !== "string" || !value.channel.trim()) return null;
  if (typeof value.chatId !== "string" || !value.chatId.trim()) return null;
  return { channel: value.channel, chatId: value.chatId };
}

export function readTaskPlanRoute(
  metadata?: Record<string, unknown> | null,
): TaskPlanRoute | null {
  return parseTaskPlanRoute(metadata?.[TASK_PLAN_ROUTE_KEY]);
}

export function emptyAgentTaskPlanState(): AgentTaskPlanState {
  return {
    plan_id: null,
    title: "",
    status: null,
    items: [],
    created_at: null,
    updated_at: null,
  };
}

export function publicTaskPlanState(plan: TaskPlanState | null): AgentTaskPlanState {
  if (!plan) return emptyAgentTaskPlanState();
  return {
    plan_id: plan.planId,
    title: plan.title,
    status: plan.status,
    items: plan.items.map((item) => ({ ...item })),
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  };
}

export function taskPlanStateWsBlob(
  metadata?: Record<string, unknown> | null,
): AgentTaskPlanState {
  return publicTaskPlanState(readTaskPlanState(metadata));
}

export function nextTaskPlanUpdatedAt(previous: string, now = new Date()): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  return new Date(
    Math.max(nowMs, Number.isFinite(previousMs) ? previousMs + 1 : nowMs),
  ).toISOString();
}
