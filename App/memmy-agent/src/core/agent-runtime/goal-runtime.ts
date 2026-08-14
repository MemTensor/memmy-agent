import { randomUUID } from "node:crypto";
import {
  InboundMessage,
  OutboundMessage,
  parseTurnSource,
  type MessageBus,
} from "../runtime-messages/index.js";
import type { ProviderErrorCategory } from "../../providers/provider-error-classifier.js";
import type { Session, SessionManager } from "../session/manager.js";
import {
  GOAL_ROUTE_KEY,
  GOAL_STATE_KEY,
  GOAL_TURN_INBOX_KEY,
  MAX_GOAL_OBJECTIVE_LENGTH,
  nextGoalUpdatedAt,
  publicGoalState,
  readGoalRoute,
  readGoalState,
  type AgentGoalState,
  type GoalRoute,
  type GoalState,
  type GoalStatus,
} from "../session/goal-state.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type GoalTurnInboxEntry = {
  id: string;
  turnId: string | null;
  channel: string;
  chatId: string;
  senderId: string;
  content: string;
  media: string[];
  metadata: Record<string, JsonValue>;
  receivedAt: string;
};

export const WEBUI_QUEUE_STEER_TRANSFERS_KEY = "webui_queue_steer_transfers";

export type WebuiQueueSteerTransferRecord = {
  clientRequestId: string;
  expectedTurnId: string;
  store: "slot" | "goal";
  descriptor: {
    clientRequestId: string;
    content: string;
    media: string[];
    queuedAt: string;
    sessionKey: string;
    source: { kind: "gui" | "tui" | "im"; channel: string };
    queueSurface: "chat_composer" | null;
  };
  messageFields: {
    channel: string;
    chatId: string;
    senderId: string;
    content: string;
    media: string[];
    metadata: Record<string, JsonValue>;
    timestamp: string;
    sessionKey: string;
    turnSource: { kind: "gui" | "tui" | "im"; channel: string } | null;
  };
};

export type BeginGoalQueueSteerTransferResult = {
  outcome: "transferred" | "not_steerable" | "reserved" | "missing";
  entry?: GoalTurnInboxEntry;
  transfer?: WebuiQueueSteerTransferRecord;
};

export type GoalTurnLease = {
  goalId: string;
  turnId: string;
  settling: boolean;
};

export type GoalWorkReservation = {
  turnId: string;
  kind: "inbox" | "continuation";
};

export type GoalSettlement = {
  goal: GoalState | null;
  publicState: AgentGoalState;
  shouldContinue: boolean;
};

export type GoalRuntimeCallbacks = {
  cancelActiveTasks?: (sessionKey: string) => Promise<number>;
  scheduleGoalWork?: (sessionKey: string, goal: GoalState) => void;
  invalidateGoalWork?: (sessionKey: string) => void;
};

export type GoalControlAction = "pause" | "resume" | "edit" | "set_budget" | "clear";

export type GoalControlRequest = {
  sessionKey: string;
  requestId: string;
  goalId: string;
  action: GoalControlAction;
  objective?: string;
  tokenBudget?: number | null;
};

export type GoalControlResult = {
  ok: boolean;
  warning?: "turn_cancel_failed";
  error?: string;
};

type GoalControlRecord = {
  summary: string;
  promise?: Promise<GoalControlResult>;
  result?: GoalControlResult;
  completedAt?: number;
};

type GoalTurnSettlementRecord = {
  goalId: string;
  result: GoalSettlement;
};

type GoalRuntimeInit = GoalRuntimeCallbacks & {
  sessions: SessionManager;
  bus?: MessageBus | null;
};

type MutationResult<T> = {
  value: T;
  commit?: () => void;
  effect?: (() => Promise<void>) | null;
};

const GOAL_INBOX_LIMIT = 20;
const GOAL_CONTROL_RESULT_LIMIT = 32;
const GOAL_CONTROL_RESULT_TTL_MS = 10 * 60 * 1000;
const GOAL_TURN_SETTLEMENT_LIMIT = 64;
const INBOX_METADATA_KEYS = new Set([
  "client_request_id",
  "queued_at",
  "turn_source",
  "webui_request_digest",
  "webui_queue_surface",
  "webui",
  "wantsStream",
  "webui_language",
  "model_preset",
  "model_provider",
  "model",
  "mcp_presets",
  "image_generation",
  "message_id",
  "thread_ts",
  "reply_to",
  "topic_id",
]);

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

export class GoalRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "GoalRuntimeError";
    this.code = code;
  }
}

function normalizeObjective(value: unknown): string {
  if (typeof value !== "string") throw new GoalRuntimeError("invalid_objective");
  const objective = value.trim();
  if (!objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new GoalRuntimeError("invalid_objective");
  }
  return objective;
}

function normalizeTokenBudget(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new GoalRuntimeError("invalid_token_budget");
  }
  return Number(value);
}

function normalizeUsageValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function parseQueueSteerTransfers(value: unknown): WebuiQueueSteerTransferRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, any>;
    const descriptor = record.descriptor;
    const messageFields = record.messageFields;
    if (
      typeof record.clientRequestId !== "string"
      || typeof record.expectedTurnId !== "string"
      || (record.store !== "slot" && record.store !== "goal")
      || !descriptor
      || typeof descriptor !== "object"
      || !messageFields
      || typeof messageFields !== "object"
    ) return [];
    return [structuredClone(record) as WebuiQueueSteerTransferRecord];
  });
}

function isClearablePausedGoal(current: GoalState, snapshot: GoalState): boolean {
  return current.goalId === snapshot.goalId
    && current.objective === snapshot.objective
    && current.status === "paused"
    && current.tokenBudget === snapshot.tokenBudget
    && current.createdAt === snapshot.createdAt
    && current.tokensUsed >= snapshot.tokensUsed
    && current.timeUsedSeconds >= snapshot.timeUsedSeconds
    && Date.parse(current.updatedAt) >= Date.parse(snapshot.updatedAt);
}

export function normalizeGoalUsage(usage: Record<string, number>): Record<string, number> {
  return {
    prompt_tokens: normalizeUsageValue(usage.prompt_tokens),
    completion_tokens: normalizeUsageValue(usage.completion_tokens),
    total_tokens: normalizeUsageValue(usage.total_tokens),
  };
}

export function goalTurnTokens(usage: Record<string, number>): number {
  const normalized = normalizeGoalUsage(usage);
  return normalized.total_tokens > 0
    ? normalized.total_tokens
    : normalized.prompt_tokens + normalized.completion_tokens;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out: JsonValue[] = [];
    for (const item of value) {
      const normalized = toJsonValue(item, seen);
      if (normalized === undefined) return undefined;
      out.push(normalized);
    }
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value) || seen.has(value)) return undefined;
  seen.add(value);
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = toJsonValue(item, seen);
    if (normalized === undefined) return undefined;
    out[key] = normalized;
  }
  seen.delete(value);
  return out;
}

export function sanitizeGoalInboxMetadata(
  channel: string,
  metadata: Record<string, unknown>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of INBOX_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
    const normalized = toJsonValue(metadata[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  if (channel === "websocket") {
    const requestId = out.client_request_id;
    const digest = out.webui_request_digest;
    if (typeof requestId !== "string" || !requestId.trim() || typeof digest !== "string" || !digest.trim()) {
      throw new GoalRuntimeError("goal_inbox_metadata_invalid");
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "turn_source")) {
    const source = parseTurnSource(out.turn_source);
    if (!source) throw new GoalRuntimeError("goal_inbox_metadata_invalid");
    out.turn_source = source;
  }
  if (Object.prototype.hasOwnProperty.call(out, "queued_at")) {
    const queuedAt = out.queued_at;
    if (typeof queuedAt !== "string" || !Number.isFinite(Date.parse(queuedAt))) {
      throw new GoalRuntimeError("goal_inbox_metadata_invalid");
    }
    out.queued_at = new Date(queuedAt).toISOString();
  }
  return out;
}

function parseInbox(value: unknown): GoalTurnInboxEntry[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new GoalRuntimeError("goal_inbox_invalid");
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new GoalRuntimeError("goal_inbox_invalid");
    if (
      typeof entry.id !== "string"
      || !entry.id
      || (entry.turnId !== null && typeof entry.turnId !== "string")
      || typeof entry.channel !== "string"
      || !entry.channel
      || typeof entry.chatId !== "string"
      || !entry.chatId
      || typeof entry.senderId !== "string"
      || typeof entry.content !== "string"
      || !Array.isArray(entry.media)
      || entry.media.some((item) => typeof item !== "string")
      || !isPlainObject(entry.metadata)
      || typeof entry.receivedAt !== "string"
      || !Number.isFinite(Date.parse(entry.receivedAt))
    ) throw new GoalRuntimeError("goal_inbox_invalid");
    const metadata = toJsonValue(entry.metadata);
    if (!isPlainObject(metadata)) throw new GoalRuntimeError("goal_inbox_invalid");
    return {
      id: entry.id,
      turnId: entry.turnId,
      channel: entry.channel,
      chatId: entry.chatId,
      senderId: entry.senderId,
      content: entry.content,
      media: [...entry.media] as string[],
      metadata: metadata as Record<string, JsonValue>,
      receivedAt: new Date(entry.receivedAt).toISOString(),
    };
  });
}

export class GoalRuntime {
  private readonly sessions: SessionManager;
  private readonly bus: MessageBus | null;
  private callbacks: GoalRuntimeCallbacks;
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly effectQueues = new Map<string, Promise<void>>();
  private readonly effectGenerations = new Map<string, number>();
  private readonly claims = new Map<string, Map<string, string>>();
  private readonly leases = new Map<string, GoalTurnLease>();
  private readonly workReservations = new Map<string, GoalWorkReservation>();
  private readonly lifecycleControls = new Set<string>();
  private readonly deletingSessions = new Set<string>();
  private readonly controlRequests = new Map<string, Map<string, GoalControlRecord>>();
  private readonly turnSettlements = new Map<string, Map<string, GoalTurnSettlementRecord>>();

  constructor({ sessions, bus = null, ...callbacks }: GoalRuntimeInit) {
    this.sessions = sessions;
    this.bus = bus;
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: GoalRuntimeCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private mutexFor(sessionKey: string): AsyncMutex {
    let mutex = this.mutexes.get(sessionKey);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(sessionKey, mutex);
    }
    return mutex;
  }

  private enqueueEffect(sessionKey: string, effect: () => Promise<void>): Promise<void> {
    const generation = this.effectGenerations.get(sessionKey) ?? 0;
    const previous = this.effectQueues.get(sessionKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (
        this.deletingSessions.has(sessionKey)
        || (this.effectGenerations.get(sessionKey) ?? 0) !== generation
      ) return;
      await effect();
    }).catch((error) => {
      console.warn("[goal] post-save effect failed", { sessionKey, error });
    });
    this.effectQueues.set(sessionKey, current);
    void current.finally(() => {
      if (this.effectQueues.get(sessionKey) === current) this.effectQueues.delete(sessionKey);
    });
    return current;
  }

  async flushEffects(sessionKey: string): Promise<void> {
    await (this.effectQueues.get(sessionKey) ?? Promise.resolve());
  }

  private async mutate<T>(
    sessionKey: string,
    operation: (session: Session) => MutationResult<T> | Promise<MutationResult<T>>,
  ): Promise<T> {
    this.assertSessionAvailable(sessionKey);
    const result = await this.mutexFor(sessionKey).runExclusive(async () => {
      this.assertSessionAvailable(sessionKey);
      const session = this.sessions.get(sessionKey);
      if (!session) throw new GoalRuntimeError("goal_not_found");
      const priorMetadata = session.metadata;
      const priorMessages = session.messages;
      const priorUpdatedAt = session.updatedAt;
      session.metadata = { ...priorMetadata };
      session.messages = [...priorMessages];
      try {
        const mutation = await operation(session);
        this.assertSessionAvailable(sessionKey);
        this.sessions.save(session, { fsync: true });
        mutation.commit?.();
        if (mutation.effect) this.enqueueEffect(sessionKey, mutation.effect);
        return mutation;
      } catch (error) {
        session.metadata = priorMetadata;
        session.messages = priorMessages;
        session.updatedAt = priorUpdatedAt;
        throw error;
      }
    });
    return result.value;
  }

  private goalStateEffect(route: GoalRoute | null, state: AgentGoalState): (() => Promise<void>) | null {
    if (!this.bus || !route) return null;
    return async () => {
      await this.bus!.publishOutbound(new OutboundMessage({
        channel: route.channel,
        chatId: route.chatId,
        content: "",
        metadata: { goalStateSync: true, goalState: state },
      }));
    };
  }

  get(sessionKey: string): GoalState | null {
    return readGoalState(this.sessions.get(sessionKey)?.metadata ?? null);
  }

  getPublic(sessionKey: string): AgentGoalState {
    return publicGoalState(this.get(sessionKey));
  }

  route(sessionKey: string): GoalRoute | null {
    return readGoalRoute(this.sessions.get(sessionKey)?.metadata ?? null);
  }

  private assertSessionAvailable(sessionKey: string): void {
    if (this.deletingSessions.has(sessionKey)) {
      throw new GoalRuntimeError("session_deletion_in_progress");
    }
  }

  private assertLifecycleAvailable(sessionKey: string): void {
    this.assertSessionAvailable(sessionKey);
    if (this.lifecycleControls.has(sessionKey) || this.leases.get(sessionKey)?.settling) {
      throw new GoalRuntimeError("goal_turn_settling");
    }
  }

  private beginLifecycleControl(sessionKey: string): void {
    this.assertLifecycleAvailable(sessionKey);
    this.lifecycleControls.add(sessionKey);
  }

  private endLifecycleControl(sessionKey: string): void {
    this.lifecycleControls.delete(sessionKey);
  }

  private beginLifecycleSettlement(sessionKey: string): void {
    this.beginLifecycleControl(sessionKey);
    const lease = this.leases.get(sessionKey);
    if (lease) lease.settling = true;
  }

  private endLifecycleSettlement(sessionKey: string): void {
    this.endLifecycleControl(sessionKey);
    const lease = this.leases.get(sessionKey);
    if (lease) lease.settling = false;
  }

  async create(input: {
    sessionKey: string;
    objective: string;
    tokenBudget?: number | null;
    route: GoalRoute;
    turnId: string;
  }): Promise<GoalState> {
    const objective = normalizeObjective(input.objective);
    const tokenBudget = normalizeTokenBudget(input.tokenBudget ?? null);
    if (!input.route.channel.trim() || !input.route.chatId.trim()) {
      throw new GoalRuntimeError("goal_route_unavailable");
    }
    this.beginLifecycleControl(input.sessionKey);
    try {
      return await this.mutate(input.sessionKey, async (session) => {
        const existing = readGoalState(session.metadata);
        if (existing && existing.status !== "completed") throw new GoalRuntimeError("goal_unfinished");
        const now = new Date().toISOString();
        const goal: GoalState = {
          goalId: randomUUID(),
          objective,
          status: "active",
          tokenBudget,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        };
        session.metadata[GOAL_STATE_KEY] = goal;
        session.metadata[GOAL_ROUTE_KEY] = { ...input.route };
        return {
          value: goal,
          commit: () => {
            const sessionClaims = this.claims.get(input.sessionKey) ?? new Map<string, string>();
            sessionClaims.set(input.turnId, goal.goalId);
            this.claims.set(input.sessionKey, sessionClaims);
            this.leases.set(input.sessionKey, {
              goalId: goal.goalId,
              turnId: input.turnId,
              settling: false,
            });
          },
          effect: this.goalStateEffect(input.route, publicGoalState(goal)),
        };
      });
    } finally {
      this.endLifecycleControl(input.sessionKey);
    }
  }

  async updateFromModel(
    sessionKey: string,
    goalId: string,
    status: Extract<GoalStatus, "completed" | "blocked">,
  ): Promise<GoalState> {
    this.beginLifecycleControl(sessionKey);
    try {
      return await this.mutate(sessionKey, (session) => {
        const goal = readGoalState(session.metadata);
        if (!goal) throw new GoalRuntimeError("goal_not_found");
        if (goal.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (goal.status !== "active") throw new GoalRuntimeError("invalid_transition");
        const updated = { ...goal, status, updatedAt: nextGoalUpdatedAt(goal.updatedAt) };
        session.metadata[GOAL_STATE_KEY] = updated;
        return {
          value: updated,
          commit: () => {
            const lease = this.leases.get(sessionKey);
            if (lease?.goalId === goalId) lease.settling = true;
          },
          effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
        };
      });
    } finally {
      this.endLifecycleControl(sessionKey);
    }
  }

  async pause(sessionKey: string, goalId: string): Promise<GoalState> {
    return (await this.pauseAndCancel(sessionKey, goalId)).goal;
  }

  async pauseAndCancel(
    sessionKey: string,
    goalId: string,
  ): Promise<{ goal: GoalState; warning?: "turn_cancel_failed" }> {
    this.beginLifecycleSettlement(sessionKey);
    try {
      const goal = await this.mutate(sessionKey, (session) => {
        const current = readGoalState(session.metadata);
        if (!current) throw new GoalRuntimeError("goal_not_found");
        if (current.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (current.status !== "active") throw new GoalRuntimeError("invalid_transition");
        const updated: GoalState = {
          ...current,
          status: "paused",
          updatedAt: nextGoalUpdatedAt(current.updatedAt),
        };
        session.metadata[GOAL_STATE_KEY] = updated;
        return {
          value: updated,
          effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
        };
      });
      this.callbacks.invalidateGoalWork?.(sessionKey);
      this.invalidateContinuationReservation(sessionKey);
      try {
        await this.callbacks.cancelActiveTasks?.(sessionKey);
        return { goal };
      } catch (error) {
        console.warn("[goal] turn cancellation failed", { sessionKey, error });
        return { goal, warning: "turn_cancel_failed" };
      }
    } finally {
      this.endLifecycleSettlement(sessionKey);
    }
  }

  async resume(sessionKey: string, goalId: string): Promise<GoalState> {
    this.beginLifecycleControl(sessionKey);
    try {
      const goal = await this.mutate(sessionKey, (session) => {
        const current = readGoalState(session.metadata);
        if (!current) throw new GoalRuntimeError("goal_not_found");
        if (current.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (current.status === "budget_limited") throw new GoalRuntimeError("budget_exhausted");
        if (!["paused", "blocked", "usage_limited"].includes(current.status)) {
          throw new GoalRuntimeError("invalid_transition");
        }
        const updated: GoalState = {
          ...current,
          status: "active",
          updatedAt: nextGoalUpdatedAt(current.updatedAt),
        };
        session.metadata[GOAL_STATE_KEY] = updated;
        return {
          value: updated,
          effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
        };
      });
      this.callbacks.scheduleGoalWork?.(sessionKey, goal);
      return goal;
    } finally {
      this.endLifecycleControl(sessionKey);
    }
  }

  async edit(sessionKey: string, goalId: string, objective: string): Promise<GoalState> {
    const normalized = normalizeObjective(objective);
    this.beginLifecycleControl(sessionKey);
    try {
      return await this.mutate(sessionKey, (session) => {
        const current = readGoalState(session.metadata);
        if (!current) throw new GoalRuntimeError("goal_not_found");
        if (current.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (current.status === "active" || current.status === "completed") {
          throw new GoalRuntimeError("invalid_transition");
        }
        const updated: GoalState = {
          ...current,
          objective: normalized,
          updatedAt: nextGoalUpdatedAt(current.updatedAt),
        };
        session.metadata[GOAL_STATE_KEY] = updated;
        return {
          value: updated,
          effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
        };
      });
    } finally {
      this.endLifecycleControl(sessionKey);
    }
  }

  async setBudget(sessionKey: string, goalId: string, value: number | null): Promise<GoalState> {
    const tokenBudget = normalizeTokenBudget(value);
    this.beginLifecycleControl(sessionKey);
    const before = this.get(sessionKey);
    const willCancel = before?.goalId === goalId
      && before.status === "active"
      && tokenBudget !== null
      && tokenBudget <= before.tokensUsed;
    if (willCancel) {
      const lease = this.leases.get(sessionKey);
      if (lease) lease.settling = true;
    }
    try {
      const goal = await this.mutate(sessionKey, (session) => {
        const current = readGoalState(session.metadata);
        if (!current) throw new GoalRuntimeError("goal_not_found");
        if (current.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (current.status === "completed") throw new GoalRuntimeError("invalid_transition");
        let status = current.status;
        if (status === "budget_limited" && (tokenBudget === null || tokenBudget > current.tokensUsed)) {
          status = "paused";
        } else if (status === "active" && tokenBudget !== null && tokenBudget <= current.tokensUsed) {
          status = "budget_limited";
        }
        const updated: GoalState = {
          ...current,
          status,
          tokenBudget,
          updatedAt: nextGoalUpdatedAt(current.updatedAt),
        };
        session.metadata[GOAL_STATE_KEY] = updated;
        return {
          value: updated,
          effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
        };
      });
      if (goal.status === "budget_limited" && willCancel) {
        this.callbacks.invalidateGoalWork?.(sessionKey);
        this.invalidateContinuationReservation(sessionKey);
        try {
          await this.callbacks.cancelActiveTasks?.(sessionKey);
        } catch (error) {
          console.warn("[goal] budget cancellation failed", { sessionKey, error });
        }
      } else if (goal.status === "active") {
        this.callbacks.invalidateGoalWork?.(sessionKey);
        this.invalidateContinuationReservation(sessionKey);
        this.callbacks.scheduleGoalWork?.(sessionKey, goal);
      }
      return goal;
    } finally {
      if (willCancel) this.endLifecycleSettlement(sessionKey);
      else this.endLifecycleControl(sessionKey);
    }
  }

  async clear(sessionKey: string, goalId: string): Promise<void> {
    this.beginLifecycleSettlement(sessionKey);
    try {
      const current = this.get(sessionKey);
      if (!current) throw new GoalRuntimeError("goal_not_found");
      if (current.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
      const running = this.leases.get(sessionKey)?.goalId === goalId;
      let pausedSnapshot: GoalState | null = null;
      if (running && current.status === "active") {
        pausedSnapshot = await this.mutate(sessionKey, (session) => {
          const goal = readGoalState(session.metadata);
          if (!goal) throw new GoalRuntimeError("goal_not_found");
          if (goal.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
          if (goal.status !== "active") throw new GoalRuntimeError("goal_turn_settling");
          const updated: GoalState = {
            ...goal,
            status: "paused",
            updatedAt: nextGoalUpdatedAt(goal.updatedAt),
          };
          session.metadata[GOAL_STATE_KEY] = updated;
          return {
            value: updated,
            effect: this.goalStateEffect(readGoalRoute(session.metadata), publicGoalState(updated)),
          };
        });
        this.callbacks.invalidateGoalWork?.(sessionKey);
        try {
          await this.callbacks.cancelActiveTasks?.(sessionKey);
        } catch (error) {
          console.warn("[goal] clear cancellation failed", { sessionKey, error });
          throw new GoalRuntimeError("clear_cancel_failed");
        }
      }
      await this.mutate(sessionKey, (session) => {
        const goal = readGoalState(session.metadata);
        if (!goal) throw new GoalRuntimeError("goal_not_found");
        if (goal.goalId !== goalId) throw new GoalRuntimeError("goal_id_mismatch");
        if (pausedSnapshot && !isClearablePausedGoal(goal, pausedSnapshot)) {
          throw new GoalRuntimeError("goal_turn_settling");
        }
        const route = readGoalRoute(session.metadata);
        delete session.metadata[GOAL_STATE_KEY];
        delete session.metadata[GOAL_ROUTE_KEY];
        return {
          value: undefined,
          effect: this.goalStateEffect(route, publicGoalState(null)),
        };
      });
      this.callbacks.invalidateGoalWork?.(sessionKey);
      this.clearGoalRuntimeWork(sessionKey);
    } finally {
      this.endLifecycleSettlement(sessionKey);
    }
  }

  registerLease(sessionKey: string, goalId: string, turnId: string): void {
    this.assertLifecycleAvailable(sessionKey);
    const current = this.leases.get(sessionKey);
    if (current && current.turnId !== turnId) throw new GoalRuntimeError("goal_control_busy");
    this.leases.set(sessionKey, { goalId, turnId, settling: false });
  }

  goalIdForTurn(sessionKey: string, turnId: string): string | null {
    return this.claims.get(sessionKey)?.get(turnId)
      ?? (this.leases.get(sessionKey)?.turnId === turnId ? this.leases.get(sessionKey)!.goalId : null);
  }

  hasGoalLease(sessionKey: string): boolean {
    return this.leases.has(sessionKey);
  }

  reserveWork(
    sessionKey: string,
    turnId: string,
    kind: GoalWorkReservation["kind"],
  ): boolean {
    if (this.deletingSessions.has(sessionKey)) return false;
    if (this.workReservations.has(sessionKey)) return false;
    this.workReservations.set(sessionKey, { turnId, kind });
    return true;
  }

  hasWorkReservation(sessionKey: string): boolean {
    return this.workReservations.has(sessionKey);
  }

  ownsWorkReservation(sessionKey: string, turnId: string): boolean {
    return this.workReservations.get(sessionKey)?.turnId === turnId;
  }

  releaseWork(sessionKey: string, turnId: string): void {
    if (this.workReservations.get(sessionKey)?.turnId === turnId) {
      this.workReservations.delete(sessionKey);
    }
  }

  releaseTurn(sessionKey: string, turnId: string): void {
    const sessionClaims = this.claims.get(sessionKey);
    sessionClaims?.delete(turnId);
    if (sessionClaims?.size === 0) this.claims.delete(sessionKey);
    if (this.leases.get(sessionKey)?.turnId === turnId) this.leases.delete(sessionKey);
  }

  async settleTurn(input: {
    sessionKey: string;
    turnId: string;
    goalId: string | null;
    usage: Record<string, number>;
    latencyMs: number;
    stopReason: string;
    errorCategory: ProviderErrorCategory | null;
  }): Promise<GoalSettlement> {
    if (!input.goalId) return { goal: null, publicState: publicGoalState(null), shouldContinue: false };
    const lease = this.leases.get(input.sessionKey);
    if (lease?.turnId === input.turnId && lease.goalId === input.goalId) lease.settling = true;
    return this.mutate<GoalSettlement>(input.sessionKey, (session) => {
      const cached = this.turnSettlements.get(input.sessionKey)?.get(input.turnId);
      if (cached) {
        if (cached.goalId !== input.goalId) throw new GoalRuntimeError("goal_id_mismatch");
        return { value: cached.result };
      }
      const current = readGoalState(session.metadata);
      if (!current || current.goalId !== input.goalId) {
        return { value: { goal: null, publicState: publicGoalState(current), shouldContinue: false } };
      }
      let status = current.status;
      if (status === "active" && ["error", "toolError"].includes(input.stopReason)) {
        status = input.errorCategory === "quota_exhausted" ? "usage_limited" : "blocked";
      }
      const tokensUsed = current.tokensUsed + goalTurnTokens(input.usage);
      const timeUsedSeconds = current.timeUsedSeconds + Math.ceil(Math.max(0, input.latencyMs) / 1000);
      if (
        status === "active"
        && current.tokenBudget !== null
        && tokensUsed >= current.tokenBudget
      ) status = "budget_limited";
      const updated: GoalState = {
        ...current,
        status,
        tokensUsed,
        timeUsedSeconds,
        updatedAt: nextGoalUpdatedAt(current.updatedAt),
      };
      session.metadata[GOAL_STATE_KEY] = updated;
      const state = publicGoalState(updated);
      const result: GoalSettlement = {
        goal: updated,
        publicState: state,
        shouldContinue: updated.status === "active",
      };
      return {
        value: result,
        commit: () => {
          const records = this.turnSettlements.get(input.sessionKey)
            ?? new Map<string, GoalTurnSettlementRecord>();
          records.set(input.turnId, { goalId: input.goalId!, result });
          while (records.size > GOAL_TURN_SETTLEMENT_LIMIT) {
            const oldest = records.keys().next().value;
            if (oldest === undefined) break;
            records.delete(oldest);
          }
          this.turnSettlements.set(input.sessionKey, records);
        },
        effect: this.goalStateEffect(readGoalRoute(session.metadata), state),
      };
    });
  }

  inbox(sessionKey: string): GoalTurnInboxEntry[] {
    return parseInbox(this.sessions.get(sessionKey)?.metadata?.[GOAL_TURN_INBOX_KEY]);
  }

  queueSteerTransfers(sessionKey: string): WebuiQueueSteerTransferRecord[] {
    return parseQueueSteerTransfers(
      this.sessions.get(sessionKey)?.metadata?.[WEBUI_QUEUE_STEER_TRANSFERS_KEY],
    );
  }

  async beginQueueSteerTransfer(
    sessionKey: string,
    clientRequestId: string,
    expectedTurnId: string,
    requiredQueueSurface: "chat_composer",
    route: { channel: string; chatId: string },
  ): Promise<BeginGoalQueueSteerTransferResult> {
    return this.mutate<BeginGoalQueueSteerTransferResult>(sessionKey, (session) => {
      const transfers = parseQueueSteerTransfers(
        session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY],
      );
      const existingTransfer = transfers.some(
        (item) => item.clientRequestId === clientRequestId,
      );
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const index = inbox.findIndex((entry) => entry.id === clientRequestId);
      if (index < 0) {
        return {
          value: { outcome: existingTransfer ? "reserved" as const : "missing" as const },
        };
      }
      const entry = inbox[index]!;
      if (entry.turnId !== null) return { value: { outcome: "reserved" as const } };
      const persistedSource = parseTurnSource(entry.metadata.turn_source);
      const source = persistedSource ?? (
        entry.channel === "websocket"
        && entry.metadata.webui === true
        && entry.metadata.webui_queue_surface === requiredQueueSurface
          ? { kind: "gui" as const, channel: "websocket" }
          : null
      );
      if (
        source?.kind !== "gui"
        || source.channel !== "websocket"
        || entry.channel !== route.channel
        || entry.chatId !== route.chatId
        || entry.metadata.webui_queue_surface !== requiredQueueSurface
        || entry.content.trimStart().startsWith("/")
      ) {
        return { value: { outcome: "not_steerable" as const } };
      }
      const transfer: WebuiQueueSteerTransferRecord = {
        clientRequestId,
        expectedTurnId,
        store: "goal",
        descriptor: {
          clientRequestId,
          content: entry.content,
          media: [...entry.media],
          queuedAt: String(entry.metadata.queued_at ?? entry.receivedAt),
          sessionKey,
          source,
          queueSurface: requiredQueueSurface,
        },
        messageFields: {
          channel: entry.channel,
          chatId: entry.chatId,
          senderId: entry.senderId,
          content: entry.content,
          media: [...entry.media],
          metadata: {
            ...structuredClone(entry.metadata),
            turn_source: source,
          },
          timestamp: entry.receivedAt,
          sessionKey,
          turnSource: source,
        },
      };
      const goalRoute = readGoalRoute(session.metadata);
      if (
        goalRoute
        && !goalRoute.source
        && goalRoute.channel === entry.channel
        && goalRoute.chatId === entry.chatId
      ) {
        session.metadata[GOAL_ROUTE_KEY] = { ...goalRoute, source };
      }
      session.metadata[GOAL_TURN_INBOX_KEY] = inbox.filter(
        (_, itemIndex) => itemIndex !== index,
      );
      session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY] = [
        ...transfers.filter((item) => item.clientRequestId !== clientRequestId),
        transfer,
      ];
      return {
        value: {
          outcome: "transferred" as const,
          entry,
          transfer,
        },
      };
    });
  }

  async restoreGoalQueueSteerTransfer(
    sessionKey: string,
    clientRequestId: string,
    queuedAt: string,
  ): Promise<GoalTurnInboxEntry | null> {
    return this.mutate(sessionKey, (session) => {
      const transfers = parseQueueSteerTransfers(
        session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY],
      );
      const transfer = transfers.find((item) => (
        item.clientRequestId === clientRequestId && item.store === "goal"
      ));
      if (!transfer) return { value: null };
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const existing = inbox.find((entry) => entry.id === clientRequestId);
      if (existing) return { value: existing };
      const entry: GoalTurnInboxEntry = {
        id: clientRequestId,
        turnId: null,
        channel: transfer.messageFields.channel,
        chatId: transfer.messageFields.chatId,
        senderId: transfer.messageFields.senderId,
        content: transfer.messageFields.content,
        media: [...transfer.messageFields.media],
        metadata: {
          ...structuredClone(transfer.messageFields.metadata),
          queued_at: queuedAt,
        },
        receivedAt: new Date().toISOString(),
      };
      session.metadata[GOAL_TURN_INBOX_KEY] = [...inbox, entry];
      return { value: entry };
    });
  }

  async completeQueueSteerTransfer(
    sessionKey: string,
    clientRequestId: string,
  ): Promise<void> {
    await this.mutate(sessionKey, (session) => {
      const transfers = parseQueueSteerTransfers(
        session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY],
      ).filter((item) => item.clientRequestId !== clientRequestId);
      if (transfers.length) session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY] = transfers;
      else delete session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY];
      return { value: undefined };
    });
  }

  async removeUnreservedInboxEntry(
    sessionKey: string,
    entryId: string,
  ): Promise<"removed" | "reserved" | "missing"> {
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const index = inbox.findIndex((entry) => (
        entry.id === entryId
        && typeof entry.metadata.client_request_id === "string"
        && parseTurnSource(entry.metadata.turn_source) !== null
      ));
      if (index < 0) return { value: "missing" as const };
      if (inbox[index]!.turnId !== null) return { value: "reserved" as const };
      session.metadata[GOAL_TURN_INBOX_KEY] = inbox.filter((_, itemIndex) => itemIndex !== index);
      return { value: "removed" as const };
    });
  }

  async enqueueUserMessage(sessionKey: string, message: InboundMessage): Promise<GoalTurnInboxEntry> {
    const source = message.turnSource ?? parseTurnSource(message.metadata?.turn_source);
    const metadata = sanitizeGoalInboxMetadata(message.channel, {
      ...(message.metadata ?? {}),
      ...(source ? { turn_source: source } : {}),
    });
    const id = typeof metadata.client_request_id === "string" ? metadata.client_request_id : randomUUID();
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const existing = inbox.find((entry) => entry.id === id);
      if (existing) return { value: existing };
      if (inbox.length >= GOAL_INBOX_LIMIT) throw new GoalRuntimeError("goal_inbox_full");
      const entry: GoalTurnInboxEntry = {
        id,
        turnId: null,
        channel: message.channel,
        chatId: message.chatId,
        senderId: message.senderId,
        content: message.content,
        media: [...message.media],
        metadata,
        receivedAt: message.timestamp.toISOString(),
      };
      session.metadata[GOAL_TURN_INBOX_KEY] = [...inbox, entry];
      return { value: entry };
    });
  }

  async reserveInboxEntry(sessionKey: string, turnId: string): Promise<GoalTurnInboxEntry | null> {
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const index = inbox.findIndex((entry) => entry.turnId === null);
      if (index < 0) return { value: null };
      const updated = { ...inbox[index]!, turnId };
      inbox[index] = updated;
      session.metadata[GOAL_TURN_INBOX_KEY] = inbox;
      return { value: updated };
    });
  }

  async consumeInboxEntry(sessionKey: string, entryId: string, turnId: string): Promise<GoalTurnInboxEntry> {
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const entry = inbox.find((item) => item.id === entryId && item.turnId === turnId);
      if (!entry) throw new GoalRuntimeError("goal_inbox_entry_unavailable");
      session.metadata[GOAL_TURN_INBOX_KEY] = inbox.filter((item) => item !== entry);
      return { value: entry };
    });
  }

  async persistInboxEntryForTurn(
    sessionKey: string,
    turnId: string,
    persist: (session: Session, entry: GoalTurnInboxEntry) => void,
  ): Promise<GoalTurnInboxEntry | null> {
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const entry = inbox.find((item) => item.turnId === turnId);
      if (!entry) return { value: null };
      persist(session, entry);
      session.metadata[GOAL_TURN_INBOX_KEY] = inbox.filter((item) => item !== entry);
      return { value: entry };
    });
  }

  async persistGoalUserTurn(
    sessionKey: string,
    turnId: string,
    route: GoalRoute,
    persist: (session: Session, entry: GoalTurnInboxEntry | null) => void,
  ): Promise<{ entry: GoalTurnInboxEntry | null; goal: GoalState | null }> {
    return this.mutate(sessionKey, (session) => {
      const inbox = parseInbox(session.metadata[GOAL_TURN_INBOX_KEY]);
      const entry = inbox.find((item) => item.turnId === turnId) ?? null;
      const goal = readGoalState(session.metadata);
      persist(session, entry);
      if (entry) {
        session.metadata[GOAL_TURN_INBOX_KEY] = inbox.filter((item) => item !== entry);
      }
      if (goal && goal.status !== "completed") {
        session.metadata[GOAL_ROUTE_KEY] = { ...route };
      }
      return { value: { entry, goal } };
    });
  }

  async resetDispatchingInbox(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session || !Object.prototype.hasOwnProperty.call(session.metadata, GOAL_TURN_INBOX_KEY)) return;
    await this.mutate(sessionKey, (current) => {
      const inbox = parseInbox(current.metadata[GOAL_TURN_INBOX_KEY]);
      current.metadata[GOAL_TURN_INBOX_KEY] = inbox.map((entry) => ({ ...entry, turnId: null }));
      return { value: undefined };
    });
  }

  private clearGoalRuntimeWork(sessionKey: string): void {
    this.claims.delete(sessionKey);
    this.leases.delete(sessionKey);
    const reservation = this.workReservations.get(sessionKey);
    if (reservation?.kind === "continuation") this.workReservations.delete(sessionKey);
    this.turnSettlements.delete(sessionKey);
  }

  private invalidateContinuationReservation(sessionKey: string): void {
    if (this.workReservations.get(sessionKey)?.kind === "continuation") {
      this.workReservations.delete(sessionKey);
    }
  }

  private controlSummary(request: GoalControlRequest): string {
    return JSON.stringify({
      goalId: request.goalId,
      action: request.action,
      ...(request.action === "edit" ? { objective: normalizeObjective(request.objective) } : {}),
      ...(request.action === "set_budget"
        ? { tokenBudget: normalizeTokenBudget(request.tokenBudget) }
        : {}),
    });
  }

  private cleanupControlRequests(sessionKey: string, now = Date.now()): Map<string, GoalControlRecord> {
    const records = this.controlRequests.get(sessionKey) ?? new Map<string, GoalControlRecord>();
    for (const [requestId, record] of records) {
      if (record.completedAt !== undefined && now - record.completedAt >= GOAL_CONTROL_RESULT_TTL_MS) {
        records.delete(requestId);
      }
    }
    this.controlRequests.set(sessionKey, records);
    return records;
  }

  private async performControl(request: GoalControlRequest): Promise<GoalControlResult> {
    try {
      let warning: GoalControlResult["warning"];
      if (request.action === "pause") {
        warning = (await this.pauseAndCancel(request.sessionKey, request.goalId)).warning;
      } else if (request.action === "resume") {
        await this.resume(request.sessionKey, request.goalId);
      } else if (request.action === "edit") {
        await this.edit(request.sessionKey, request.goalId, request.objective ?? "");
      } else if (request.action === "set_budget") {
        await this.setBudget(request.sessionKey, request.goalId, request.tokenBudget ?? null);
      } else {
        await this.clear(request.sessionKey, request.goalId);
      }
      await this.flushEffects(request.sessionKey);
      return { ok: true, ...(warning ? { warning } : {}) };
    } catch (error) {
      await this.flushEffects(request.sessionKey);
      return {
        ok: false,
        error: error instanceof GoalRuntimeError ? error.code : "invalid_transition",
      };
    }
  }

  async control(request: GoalControlRequest): Promise<GoalControlResult> {
    if (!request.requestId.trim()) return { ok: false, error: "invalid_transition" };
    let summary: string;
    try {
      summary = this.controlSummary(request);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof GoalRuntimeError ? error.code : "invalid_transition",
      };
    }
    const records = this.cleanupControlRequests(request.sessionKey);
    const existing = records.get(request.requestId);
    if (existing) {
      if (existing.summary !== summary) return { ok: false, error: "request_id_conflict" };
      if (existing.result) return existing.result;
      if (existing.promise) return existing.promise;
    }
    if ([...records.values()].some((record) => record.promise && !record.result)) {
      return { ok: false, error: "goal_control_busy" };
    }
    const promise = this.performControl(request);
    const record: GoalControlRecord = { summary, promise };
    records.set(request.requestId, record);
    const result = await promise;
    record.promise = undefined;
    record.result = result;
    record.completedAt = Date.now();
    const completed = [...records.entries()]
      .filter(([, item]) => item.completedAt !== undefined)
      .sort((a, b) => a[1].completedAt! - b[1].completedAt!);
    while (completed.length > GOAL_CONTROL_RESULT_LIMIT) {
      const oldest = completed.shift();
      if (oldest) records.delete(oldest[0]);
    }
    return result;
  }

  private clearRuntimeState(sessionKey: string, preserveMutex = false): void {
    this.effectGenerations.set(sessionKey, (this.effectGenerations.get(sessionKey) ?? 0) + 1);
    this.claims.delete(sessionKey);
    this.leases.delete(sessionKey);
    this.workReservations.delete(sessionKey);
    this.lifecycleControls.delete(sessionKey);
    this.controlRequests.delete(sessionKey);
    this.turnSettlements.delete(sessionKey);
    if (!preserveMutex) this.mutexes.delete(sessionKey);
    this.effectQueues.delete(sessionKey);
  }

  beginSessionDeletion(sessionKey: string): void {
    if (this.deletingSessions.has(sessionKey)) {
      throw new GoalRuntimeError("session_deletion_in_progress");
    }
    this.deletingSessions.add(sessionKey);
    this.clearRuntimeState(sessionKey, true);
  }

  async drainSessionDeletion(sessionKey: string): Promise<void> {
    const mutex = this.mutexes.get(sessionKey);
    if (mutex) await mutex.runExclusive(() => undefined);
  }

  endSessionDeletion(sessionKey: string): void {
    this.clearRuntimeState(sessionKey);
    this.deletingSessions.delete(sessionKey);
  }

  invalidateSession(sessionKey: string): void {
    this.clearRuntimeState(sessionKey);
  }
}
