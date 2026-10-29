import { randomUUID } from "node:crypto";
import { OutboundMessage, type MessageBus } from "../runtime-messages/index.js";
import type { Session, SessionManager } from "../session/manager.js";
import {
  MAX_TASK_PLAN_ITEM_LENGTH,
  MAX_TASK_PLAN_ITEMS,
  MAX_TASK_PLAN_TITLE_LENGTH,
  TASK_PLAN_ROUTE_KEY,
  TASK_PLAN_STATE_KEY,
  isTaskPlanItemStatus,
  nextTaskPlanUpdatedAt,
  publicTaskPlanState,
  readTaskPlanRoute,
  readTaskPlanState,
  type AgentTaskPlanState,
  type TaskPlanItem,
  type TaskPlanItemStatus,
  type TaskPlanRoute,
  type TaskPlanState,
  type TaskPlanStatus,
} from "../session/task-plan-state.js";

export type TaskPlanItemInput = {
  id: string;
  content: string;
};

type MutationResult<T> = {
  value: T;
  effect?: (() => Promise<void>) | null;
};

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class TaskPlanRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "TaskPlanRuntimeError";
    this.code = code;
  }
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") throw new TaskPlanRuntimeError("invalid_task_plan_title");
  const title = value.trim();
  if (!title || title.length > MAX_TASK_PLAN_TITLE_LENGTH) {
    throw new TaskPlanRuntimeError("invalid_task_plan_title");
  }
  return title;
}

function normalizeItemId(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
  ) {
    throw new TaskPlanRuntimeError("invalid_task_plan_item_id");
  }
  return value;
}

function normalizeItemContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskPlanRuntimeError("invalid_task_plan_item_content");
  }
  const content = value.trim();
  if (!content || content.length > MAX_TASK_PLAN_ITEM_LENGTH) {
    throw new TaskPlanRuntimeError("invalid_task_plan_item_content");
  }
  return content;
}

function normalizeItems(value: unknown): TaskPlanItem[] {
  if (
    !Array.isArray(value)
    || value.length < 3
    || value.length > MAX_TASK_PLAN_ITEMS
  ) {
    throw new TaskPlanRuntimeError("invalid_task_plan_items");
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TaskPlanRuntimeError("invalid_task_plan_items");
    }
    const item = raw as Record<string, unknown>;
    const id = normalizeItemId(item.id);
    if (ids.has(id)) throw new TaskPlanRuntimeError("duplicate_task_plan_item_id");
    ids.add(id);
    return {
      id,
      content: normalizeItemContent(item.content),
      status: "pending" as const,
    };
  });
}

function derivedPlanStatus(items: TaskPlanItem[]): TaskPlanStatus {
  if (items.every((item) => item.status === "completed")) return "completed";
  if (items.some((item) => item.status === "blocked")) return "blocked";
  return "active";
}

export class TaskPlanRuntime {
  private readonly sessions: SessionManager;
  private readonly bus: MessageBus | null;
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly effectQueues = new Map<string, Promise<void>>();

  constructor({ sessions, bus = null }: { sessions: SessionManager; bus?: MessageBus | null }) {
    this.sessions = sessions;
    this.bus = bus;
  }

  private mutexFor(sessionKey: string): AsyncMutex {
    let mutex = this.mutexes.get(sessionKey);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(sessionKey, mutex);
    }
    return mutex;
  }

  private enqueueEffect(sessionKey: string, effect: () => Promise<void>): void {
    const previous = this.effectQueues.get(sessionKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(effect)
      .catch((error) => {
        console.warn("[task-plan] post-save effect failed", { sessionKey, error });
      });
    this.effectQueues.set(sessionKey, current);
    void current.finally(() => {
      if (this.effectQueues.get(sessionKey) === current) this.effectQueues.delete(sessionKey);
    });
  }

  async flushEffects(sessionKey: string): Promise<void> {
    await (this.effectQueues.get(sessionKey) ?? Promise.resolve());
  }

  private async mutate<T>(
    sessionKey: string,
    operation: (session: Session) => MutationResult<T> | Promise<MutationResult<T>>,
  ): Promise<T> {
    const result = await this.mutexFor(sessionKey).runExclusive(async () => {
      const session = this.sessions.get(sessionKey);
      if (!session) throw new TaskPlanRuntimeError("task_plan_session_unavailable");
      const priorMetadata = session.metadata;
      const priorUpdatedAt = session.updatedAt;
      session.metadata = { ...priorMetadata };
      try {
        const mutation = await operation(session);
        this.sessions.save(session, { fsync: true });
        if (mutation.effect) this.enqueueEffect(sessionKey, mutation.effect);
        return mutation;
      } catch (error) {
        session.metadata = priorMetadata;
        session.updatedAt = priorUpdatedAt;
        throw error;
      }
    });
    return result.value;
  }

  private stateEffect(
    route: TaskPlanRoute | null,
    state: AgentTaskPlanState,
  ): (() => Promise<void>) | null {
    if (!this.bus || !route) return null;
    return async () => {
      await this.bus!.publishOutbound(new OutboundMessage({
        channel: route.channel,
        chatId: route.chatId,
        content: "",
        metadata: { taskPlanStateSync: true, taskPlanState: state },
      }));
    };
  }

  get(sessionKey: string): TaskPlanState | null {
    return readTaskPlanState(this.sessions.get(sessionKey)?.metadata ?? null);
  }

  getPublic(sessionKey: string): AgentTaskPlanState {
    return publicTaskPlanState(this.get(sessionKey));
  }

  async create(input: {
    sessionKey: string;
    title: string;
    items: TaskPlanItemInput[];
    route: TaskPlanRoute;
  }): Promise<TaskPlanState> {
    const title = normalizeTitle(input.title);
    const items = normalizeItems(input.items);
    if (!input.route.channel.trim() || !input.route.chatId.trim()) {
      throw new TaskPlanRuntimeError("task_plan_route_unavailable");
    }
    return this.mutate(input.sessionKey, (session) => {
      const existing = readTaskPlanState(session.metadata);
      if (existing?.status === "active") {
        throw new TaskPlanRuntimeError("task_plan_already_active");
      }
      const now = new Date().toISOString();
      const plan: TaskPlanState = {
        planId: randomUUID(),
        title,
        status: "active",
        items,
        createdAt: now,
        updatedAt: now,
      };
      session.metadata[TASK_PLAN_STATE_KEY] = plan;
      session.metadata[TASK_PLAN_ROUTE_KEY] = { ...input.route };
      return {
        value: plan,
        effect: this.stateEffect(input.route, publicTaskPlanState(plan)),
      };
    });
  }

  async updateItem(
    sessionKey: string,
    itemId: string,
    status: TaskPlanItemStatus,
  ): Promise<TaskPlanState> {
    const normalizedId = normalizeItemId(itemId);
    if (!isTaskPlanItemStatus(status)) {
      throw new TaskPlanRuntimeError("invalid_task_plan_item_status");
    }
    return this.mutate(sessionKey, (session) => {
      const current = readTaskPlanState(session.metadata);
      if (!current) throw new TaskPlanRuntimeError("task_plan_not_found");
      if (current.status === "completed") {
        throw new TaskPlanRuntimeError("task_plan_completed");
      }
      const index = current.items.findIndex((item) => item.id === normalizedId);
      if (index < 0) throw new TaskPlanRuntimeError("task_plan_item_not_found");
      const previous = current.items[index]!;
      if (previous.status === "completed" && status !== "completed") {
        throw new TaskPlanRuntimeError("task_plan_item_completed");
      }
      if (
        status === "in_progress"
        && current.items.some((item, itemIndex) => (
          itemIndex !== index && item.status === "in_progress"
        ))
      ) {
        throw new TaskPlanRuntimeError("task_plan_item_already_in_progress");
      }
      const items = current.items.map((item, itemIndex) => (
        itemIndex === index ? { ...item, status } : item
      ));
      const updated: TaskPlanState = {
        ...current,
        status: derivedPlanStatus(items),
        items,
        updatedAt: nextTaskPlanUpdatedAt(current.updatedAt),
      };
      session.metadata[TASK_PLAN_STATE_KEY] = updated;
      return {
        value: updated,
        effect: this.stateEffect(
          readTaskPlanRoute(session.metadata),
          publicTaskPlanState(updated),
        ),
      };
    });
  }
}
