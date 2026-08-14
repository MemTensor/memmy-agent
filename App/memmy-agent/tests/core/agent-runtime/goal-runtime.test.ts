import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GoalRuntime,
  GoalRuntimeError,
  goalTurnTokens,
  sanitizeGoalInboxMetadata,
  type GoalRuntimeCallbacks,
} from "../../../src/core/agent-runtime/goal-runtime.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { SessionManager } from "../../../src/core/session/manager.js";

const SESSION_KEY = "websocket:goal-runtime";
const ROUTE = { channel: "websocket", chatId: "goal-runtime" } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createRuntime(callbacks: GoalRuntimeCallbacks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-goal-runtime-"));
  const sessions = new SessionManager(root);
  sessions.getOrCreate(SESSION_KEY);
  const bus = new MessageBus();
  const runtime = new GoalRuntime({ sessions, bus, ...callbacks });
  return { root, sessions, bus, runtime };
}

async function createGoal(runtime: GoalRuntime, overrides: {
  objective?: string;
  tokenBudget?: number | null;
  turnId?: string;
} = {}) {
  return runtime.create({
    sessionKey: SESSION_KEY,
    objective: overrides.objective ?? "Ship persistent Goal mode",
    tokenBudget: overrides.tokenBudget ?? null,
    route: ROUTE,
    turnId: overrides.turnId ?? "turn-create",
  });
}

async function expectGoalError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("GoalRuntime state transitions", () => {
  it("enforces lifecycle transitions and goal identity", async () => {
    const { runtime } = createRuntime();
    const created = await createGoal(runtime);

    await expectGoalError(runtime.edit(SESSION_KEY, created.goalId, "changed"), "invalid_transition");
    await expectGoalError(runtime.pause(SESSION_KEY, "00000000-0000-4000-8000-000000000000"), "goal_id_mismatch");

    const paused = await runtime.pause(SESSION_KEY, created.goalId);
    expect(paused.status).toBe("paused");
    const edited = await runtime.edit(SESSION_KEY, created.goalId, "Ship and verify Goal mode");
    expect(edited.objective).toBe("Ship and verify Goal mode");
    const budgeted = await runtime.setBudget(SESSION_KEY, created.goalId, 20_000);
    expect(budgeted).toMatchObject({ status: "paused", tokenBudget: 20_000 });
    const resumed = await runtime.resume(SESSION_KEY, created.goalId);
    expect(resumed.status).toBe("active");
    const completed = await runtime.updateFromModel(SESSION_KEY, created.goalId, "completed");
    expect(completed.status).toBe("completed");
    await expectGoalError(runtime.resume(SESSION_KEY, created.goalId), "goal_turn_settling");

    runtime.releaseTurn(SESSION_KEY, "turn-create");
    await runtime.clear(SESSION_KEY, created.goalId);
    expect(runtime.get(SESSION_KEY)).toBeNull();
  });

  it("requires budget_limited Goals to receive a larger budget before resume", async () => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime, { tokenBudget: 10, turnId: "turn-budget" });
    const limited = await runtime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-budget",
      goalId: goal.goalId,
      usage: { total_tokens: 10 },
      latencyMs: 1_001,
      stopReason: "completed",
      errorCategory: null,
    });
    expect(limited.goal).toMatchObject({ status: "budget_limited", tokensUsed: 10, timeUsedSeconds: 2 });
    runtime.releaseTurn(SESSION_KEY, "turn-budget");
    await expectGoalError(runtime.resume(SESSION_KEY, goal.goalId), "budget_exhausted");

    const raised = await runtime.setBudget(SESSION_KEY, goal.goalId, 20);
    expect(raised.status).toBe("paused");
    await expect(runtime.resume(SESSION_KEY, goal.goalId)).resolves.toMatchObject({ status: "active" });
  });

  it("maps only structured quota exhaustion to usage_limited", async () => {
    const quotaRuntime = createRuntime().runtime;
    const quotaGoal = await createGoal(quotaRuntime, { turnId: "turn-quota" });
    const quota = await quotaRuntime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-quota",
      goalId: quotaGoal.goalId,
      usage: {},
      latencyMs: 0,
      stopReason: "error",
      errorCategory: "quota_exhausted",
    });
    expect(quota.goal?.status).toBe("usage_limited");

    const ordinaryRuntime = createRuntime().runtime;
    const ordinaryGoal = await createGoal(ordinaryRuntime, { turnId: "turn-error" });
    const ordinary = await ordinaryRuntime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-error",
      goalId: ordinaryGoal.goalId,
      usage: {},
      latencyMs: 0,
      stopReason: "error",
      errorCategory: null,
    });
    expect(ordinary.goal?.status).toBe("blocked");
  });

  it.each([
    ["rate_limited", null],
    ["network_error", null],
    ["quota exceeded in unstructured text", null]
  ] as const)("does not map ordinary error category %s to usage_limited", async (_label, errorCategory) => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime, { turnId: "turn-ordinary-error" });
    const result = await runtime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-ordinary-error",
      goalId: goal.goalId,
      usage: {},
      latencyMs: 0,
      stopReason: "error",
      errorCategory,
    });

    expect(result.goal?.status).toBe("blocked");
  });

  it.each([
    "image_input_unsupported",
    "image_analysis_failed",
  ] as const)("settles %s as a blocked Goal instead of completion", async (errorCategory) => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime, { turnId: `turn-${errorCategory}` });
    const result = await runtime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: `turn-${errorCategory}`,
      goalId: goal.goalId,
      usage: {},
      latencyMs: 0,
      stopReason: "error",
      errorCategory,
    });

    expect(result.goal?.status).toBe("blocked");
    expect(result.shouldContinue).toBe(false);
  });

  it("keeps updatedAt strictly increasing when the clock stalls or moves backward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const { runtime } = createRuntime();
    const created = await createGoal(runtime);
    const paused = await runtime.pause(SESSION_KEY, created.goalId);
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const edited = await runtime.edit(SESSION_KEY, created.goalId, "Updated objective");

    expect(Date.parse(paused.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(paused.updatedAt));
  });
});

describe("GoalRuntime transaction and settlement guarantees", () => {
  it("does not leak a claim or lease when Goal creation cannot be saved", async () => {
    const { sessions, runtime } = createRuntime();
    vi.spyOn(sessions, "save").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(createGoal(runtime, { turnId: "turn-save-failed" })).rejects.toThrow("disk full");
    expect(runtime.get(SESSION_KEY)).toBeNull();
    expect(runtime.goalIdForTurn(SESSION_KEY, "turn-save-failed")).toBeNull();
    expect(runtime.hasGoalLease(SESSION_KEY)).toBe(false);
  });

  it("settles token and time usage once per top-level Turn", async () => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime, { turnId: "turn-once" });
    const input = {
      sessionKey: SESSION_KEY,
      turnId: "turn-once",
      goalId: goal.goalId,
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 0 },
      latencyMs: 1_001,
      stopReason: "completed",
      errorCategory: null,
    } as const;

    const first = await runtime.settleTurn(input);
    const second = await runtime.settleTurn(input);
    expect(first).toEqual(second);
    expect(runtime.get(SESSION_KEY)).toMatchObject({ tokensUsed: 12, timeUsedSeconds: 2 });
  });

  it("normalizes provider usage deterministically", () => {
    expect(goalTurnTokens({ total_tokens: 17, prompt_tokens: 100, completion_tokens: 100 })).toBe(17);
    expect(goalTurnTokens({ total_tokens: 0, prompt_tokens: 7, completion_tokens: 5 })).toBe(12);
    expect(goalTurnTokens({ total_tokens: Number.NaN, prompt_tokens: -1, completion_tokens: Infinity })).toBe(0);
  });

  it("normalizes fractional and invalid usage before accumulating it", () => {
    expect(goalTurnTokens({ total_tokens: -10, prompt_tokens: 4.9, completion_tokens: 2.1 })).toBe(6);
    expect(goalTurnTokens({ total_tokens: Infinity, prompt_tokens: Number.NaN, completion_tokens: -5 })).toBe(0);
    expect(goalTurnTokens({ total_tokens: 0.9, prompt_tokens: 99, completion_tokens: 99 })).toBe(198);
  });

  it("publishes committed Goal states in order and continues after one send failure", async () => {
    const { bus, runtime } = createRuntime();
    const delivered: string[] = [];
    let calls = 0;
    vi.spyOn(bus, "publishOutbound").mockImplementation(async (message) => {
      calls += 1;
      if (calls === 1) throw new Error("disconnected renderer");
      delivered.push(message.metadata.goalState.status ?? "empty");
    });

    const goal = await createGoal(runtime);
    await runtime.pause(SESSION_KEY, goal.goalId);
    await runtime.flushEffects(SESSION_KEY);

    expect(calls).toBe(2);
    expect(delivered).toEqual(["paused"]);
  });

  it("does not hold the Session metadata mutex while cancellation is pending", async () => {
    const cancellation = deferred<number>();
    const { runtime } = createRuntime({
      cancelActiveTasks: async () => cancellation.promise,
    });
    const goal = await createGoal(runtime);

    const pausing = runtime.pauseAndCancel(SESSION_KEY, goal.goalId);
    await vi.waitFor(() => expect(runtime.get(SESSION_KEY)?.status).toBe("paused"));
    await expect(runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      senderId: "user",
      content: "queued while cancelling",
      metadata: {
        client_request_id: "queued-request",
        webui_request_digest: "queued-digest",
      },
    }))).resolves.toMatchObject({ content: "queued while cancelling" });

    cancellation.resolve(1);
    await expect(pausing).resolves.toMatchObject({ goal: { status: "paused" } });
  });

  it("claims lifecycle control before waiting for the metadata mutex", async () => {
    const { runtime, sessions } = createRuntime();
    const goal = await createGoal(runtime);
    await runtime.pause(SESSION_KEY, goal.goalId);
    runtime.releaseTurn(SESSION_KEY, "turn-create");

    const save = sessions.save.bind(sessions);
    let resume: Promise<unknown> | null = null;
    let competingBudget: Promise<unknown> | null = null;
    vi.spyOn(sessions, "save").mockImplementationOnce((session, options) => {
      resume = runtime.resume(SESSION_KEY, goal.goalId);
      competingBudget = runtime.setBudget(SESSION_KEY, goal.goalId, 100);
      void competingBudget.catch(() => undefined);
      save(session, options);
    });

    await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      senderId: "user",
      content: "hold the metadata mutex",
      metadata: {
        client_request_id: "lifecycle-request",
        webui_request_digest: "lifecycle-digest",
      },
    }));

    await expect(resume).resolves.toMatchObject({ status: "active" });
    await expect(competingBudget).rejects.toMatchObject({ code: "goal_turn_settling" });
    expect(runtime.get(SESSION_KEY)).toMatchObject({ status: "active", tokenBudget: null });
  });

  it("keeps paused state when cancellation fails", async () => {
    const { runtime } = createRuntime({
      cancelActiveTasks: vi.fn(async () => {
        throw new Error("cancel transport failed");
      }),
    });
    const goal = await createGoal(runtime);

    await expect(runtime.pauseAndCancel(SESSION_KEY, goal.goalId)).resolves.toMatchObject({
      goal: { status: "paused" },
      warning: "turn_cancel_failed",
    });
    expect(runtime.get(SESSION_KEY)?.status).toBe("paused");
  });

  it("revalidates a running Clear snapshot and preserves the real-user inbox", async () => {
    const cancellation = deferred<number>();
    const { runtime } = createRuntime({
      cancelActiveTasks: async () => cancellation.promise,
    });
    const goal = await createGoal(runtime, { turnId: "turn-clear" });
    const clearing = runtime.clear(SESSION_KEY, goal.goalId);
    await vi.waitFor(() => expect(runtime.get(SESSION_KEY)?.status).toBe("paused"));

    await expect(runtime.resume(SESSION_KEY, goal.goalId)).rejects.toMatchObject({ code: "goal_turn_settling" });
    await expect(runtime.edit(SESSION_KEY, goal.goalId, "new objective")).rejects.toMatchObject({ code: "goal_turn_settling" });
    await expect(runtime.setBudget(SESSION_KEY, goal.goalId, 100)).rejects.toMatchObject({ code: "goal_turn_settling" });
    await expect(runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      content: "do not lose me",
      metadata: {
        client_request_id: "clear-inbox-request",
        webui_request_digest: "clear-inbox-digest",
      },
    }))).resolves.toMatchObject({ content: "do not lose me" });

    await runtime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-clear",
      goalId: goal.goalId,
      usage: { total_tokens: 7 },
      latencyMs: 100,
      stopReason: "completed",
      errorCategory: null,
    });
    cancellation.resolve(1);
    await expect(clearing).resolves.toBeUndefined();
    expect(runtime.get(SESSION_KEY)).toBeNull();
    expect(runtime.inbox(SESSION_KEY)).toHaveLength(1);
  });

  it("cancels exactly once when a lower budget limits an active Goal", async () => {
    const cancelActiveTasks = vi.fn(async () => 1);
    const { runtime } = createRuntime({ cancelActiveTasks });
    const goal = await createGoal(runtime, { turnId: "turn-budget-control" });
    await runtime.settleTurn({
      sessionKey: SESSION_KEY,
      turnId: "turn-budget-control",
      goalId: goal.goalId,
      usage: { total_tokens: 25 },
      latencyMs: 0,
      stopReason: "completed",
      errorCategory: null,
    });
    runtime.releaseTurn(SESSION_KEY, "turn-budget-control");

    await expect(runtime.setBudget(SESSION_KEY, goal.goalId, 20)).resolves.toMatchObject({
      status: "budget_limited",
      tokenBudget: 20,
    });
    expect(cancelActiveTasks).toHaveBeenCalledOnce();
  });

  it("reschedules an active Goal from its new snapshot after Budget changes", async () => {
    const scheduleGoalWork = vi.fn();
    const invalidateGoalWork = vi.fn();
    const { runtime } = createRuntime({ scheduleGoalWork, invalidateGoalWork });
    const goal = await createGoal(runtime, { turnId: "turn-budget-reschedule" });
    runtime.releaseTurn(SESSION_KEY, "turn-budget-reschedule");
    expect(runtime.reserveWork(SESSION_KEY, "turn-stale-continuation", "continuation")).toBe(true);

    const updated = await runtime.setBudget(SESSION_KEY, goal.goalId, 1_000);

    expect(updated.status).toBe("active");
    expect(updated.updatedAt).not.toBe(goal.updatedAt);
    expect(invalidateGoalWork).toHaveBeenCalledWith(SESSION_KEY);
    expect(runtime.ownsWorkReservation(SESSION_KEY, "turn-stale-continuation")).toBe(false);
    expect(scheduleGoalWork).toHaveBeenCalledWith(SESSION_KEY, updated);
  });

  it("fences mutations, reservations, and queued effects during Session deletion", async () => {
    const firstEffect = deferred<void>();
    const publishStarted = deferred<void>();
    const { bus, runtime } = createRuntime();
    const publishOutbound = vi.spyOn(bus, "publishOutbound").mockImplementation(async () => {
      publishStarted.resolve();
      await firstEffect.promise;
    });
    const goal = await createGoal(runtime);
    await publishStarted.promise;
    await runtime.pause(SESSION_KEY, goal.goalId);

    runtime.beginSessionDeletion(SESSION_KEY);
    expect(runtime.reserveWork(SESSION_KEY, "turn-after-delete", "continuation")).toBe(false);
    await expect(runtime.setBudget(SESSION_KEY, goal.goalId, 100))
      .rejects.toMatchObject({ code: "session_deletion_in_progress" });

    firstEffect.resolve();
    await runtime.drainSessionDeletion(SESSION_KEY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishOutbound).toHaveBeenCalledTimes(1);

    runtime.endSessionDeletion(SESSION_KEY);
    await expect(runtime.setBudget(SESSION_KEY, goal.goalId, 100))
      .resolves.toMatchObject({ status: "paused", tokenBudget: 100 });
  });
});

describe("GoalRuntime control and inbox arbitration", () => {
  it("executes the same request_id once and rejects conflicting concurrent controls", async () => {
    let releaseCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancelActiveTasks = vi.fn(async () => {
      await cancellation;
      return 1;
    });
    const { runtime } = createRuntime({ cancelActiveTasks });
    const goal = await createGoal(runtime);
    const request = {
      sessionKey: SESSION_KEY,
      requestId: "request-pause",
      goalId: goal.goalId,
      action: "pause" as const,
    };

    const first = runtime.control(request);
    const duplicate = runtime.control(request);
    await expect(runtime.control({ ...request, requestId: "request-clear", action: "clear" }))
      .resolves.toEqual({ ok: false, error: "goal_control_busy" });
    await expect(runtime.control({ ...request, action: "resume" }))
      .resolves.toEqual({ ok: false, error: "request_id_conflict" });
    releaseCancel();

    await expect(first).resolves.toEqual({ ok: true });
    await expect(duplicate).resolves.toEqual({ ok: true });
    expect(cancelActiveTasks).toHaveBeenCalledOnce();
    await expect(runtime.control(request)).resolves.toEqual({ ok: true });
    expect(cancelActiveTasks).toHaveBeenCalledOnce();
  });

  it("expires cached control results at the TTL boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime);
    await runtime.pause(SESSION_KEY, goal.goalId);
    const request = {
      sessionKey: SESSION_KEY,
      requestId: "ttl-budget",
      goalId: goal.goalId,
      action: "set_budget" as const,
      tokenBudget: 100,
    };

    await expect(runtime.control(request)).resolves.toEqual({ ok: true });
    const firstUpdatedAt = runtime.get(SESSION_KEY)?.updatedAt;
    vi.advanceTimersByTime(10 * 60 * 1000);
    await expect(runtime.control(request)).resolves.toEqual({ ok: true });

    expect(runtime.get(SESSION_KEY)?.updatedAt).not.toBe(firstUpdatedAt);
  });

  it("retains only the 32 newest completed control results", async () => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime);
    await runtime.pause(SESSION_KEY, goal.goalId);
    const first = {
      sessionKey: SESSION_KEY,
      requestId: "budget-0",
      goalId: goal.goalId,
      action: "set_budget" as const,
      tokenBudget: 100,
    };
    await runtime.control(first);
    for (let index = 1; index <= 32; index += 1) {
      await runtime.control({ ...first, requestId: `budget-${index}` });
    }
    const beforeRetry = runtime.get(SESSION_KEY)?.updatedAt;

    await runtime.control(first);

    expect(runtime.get(SESSION_KEY)?.updatedAt).not.toBe(beforeRetry);
  });

  it("drops control idempotence records when a Session is invalidated", async () => {
    const { runtime } = createRuntime();
    const goal = await createGoal(runtime);
    await runtime.pause(SESSION_KEY, goal.goalId);
    const request = {
      sessionKey: SESSION_KEY,
      requestId: "invalidate-budget",
      goalId: goal.goalId,
      action: "set_budget" as const,
      tokenBudget: 100,
    };
    await runtime.control(request);
    const beforeInvalidate = runtime.get(SESSION_KEY)?.updatedAt;

    runtime.invalidateSession(SESSION_KEY);
    await runtime.control(request);

    expect(runtime.get(SESSION_KEY)?.updatedAt).not.toBe(beforeInvalidate);
  });

  it("keeps a FIFO inbox, enforces its limit, and persists only JSON metadata", async () => {
    const { runtime } = createRuntime();
    await createGoal(runtime);
    for (let index = 0; index < 20; index += 1) {
      await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
        channel: "websocket",
        chatId: ROUTE.chatId,
        senderId: "user",
        content: `message-${index}`,
        metadata: {
          client_request_id: `request-${index}`,
          webui_request_digest: `digest-${index}`,
          webui: true,
          ignored_function: () => undefined,
        },
      }));
    }
    expect(runtime.inbox(SESSION_KEY).map((entry) => entry.content))
      .toEqual(Array.from({ length: 20 }, (_, index) => `message-${index}`));
    expect(runtime.inbox(SESSION_KEY)[0]?.metadata).not.toHaveProperty("ignored_function");

    await expectGoalError(runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      content: "overflow",
      metadata: {
        client_request_id: "request-overflow",
        webui_request_digest: "digest-overflow",
      },
    })), "goal_inbox_full");
  });

  it("persists an inbox user Turn and removes its entry in one atomic save", async () => {
    const { runtime, sessions } = createRuntime();
    await createGoal(runtime);
    await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      senderId: "user",
      content: "atomic inbox message",
      metadata: {
        client_request_id: "atomic-request",
        webui_request_digest: "atomic-digest",
      },
    }));
    const reserved = await runtime.reserveInboxEntry(SESSION_KEY, "turn-inbox");
    expect(reserved).not.toBeNull();

    await expect(runtime.persistGoalUserTurn(
      SESSION_KEY,
      "turn-inbox",
      ROUTE,
      (session) => {
        session.addMessage("user", "partial write");
        throw new Error("save preparation failed");
      },
    )).rejects.toThrow("save preparation failed");
    expect(runtime.inbox(SESSION_KEY)).toHaveLength(1);
    expect(sessions.get(SESSION_KEY)?.messages).toEqual([]);

    const sourceAwareRoute = {
      ...ROUTE,
      source: { kind: "tui" as const, channel: "websocket" },
    };
    await expect(runtime.persistGoalUserTurn(
      SESSION_KEY,
      "turn-inbox",
      sourceAwareRoute,
      (session, entry) => session.addMessage("user", entry?.content ?? ""),
    )).resolves.toMatchObject({ entry: { content: "atomic inbox message" } });
    expect(runtime.inbox(SESSION_KEY)).toHaveLength(0);
    expect(runtime.route(SESSION_KEY)).toEqual(sourceAwareRoute);
    expect(sessions.get(SESSION_KEY)?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "atomic inbox message" }),
    ]);
  });

  it("removes only an unreserved visible shared-queue inbox entry and persists the result", async () => {
    const { runtime, root } = createRuntime();
    const goal = await createGoal(runtime);
    for (const [id, content] of [["remove-me", "delete this"], ["keep-me", "keep this"]] as const) {
      await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
        channel: "websocket",
        chatId: ROUTE.chatId,
        senderId: "user",
        content,
        metadata: {
          client_request_id: id,
          webui_request_digest: `digest-${id}`,
          webui_queue_surface: "chat_composer",
          webui: true,
          queued_at: "2026-08-09T12:00:00.000Z",
          turn_source: { kind: "gui", channel: "websocket" },
        },
      }));
    }

    expect(runtime.inbox(SESSION_KEY)[0]?.metadata.webui_queue_surface).toBe("chat_composer");
    await expect(runtime.removeUnreservedInboxEntry(SESSION_KEY, "remove-me")).resolves.toBe("removed");
    expect(runtime.inbox(SESSION_KEY).map((entry) => entry.id)).toEqual(["keep-me"]);
    expect(runtime.get(SESSION_KEY)).toMatchObject({ goalId: goal.goalId, status: "active" });
    expect(new SessionManager(root).get(SESSION_KEY)?.metadata.goalTurnInbox)
      .toEqual([expect.objectContaining({ id: "keep-me" })]);

    runtime.releaseTurn(SESSION_KEY, "turn-create");
    await expect(runtime.reserveInboxEntry(SESSION_KEY, "turn-reserved"))
      .resolves.toMatchObject({ id: "keep-me", turnId: "turn-reserved" });
    await expect(runtime.removeUnreservedInboxEntry(SESSION_KEY, "keep-me")).resolves.toBe("reserved");
    await expect(runtime.removeUnreservedInboxEntry(SESSION_KEY, "missing")).resolves.toBe("missing");
    expect(runtime.inbox(SESSION_KEY)).toHaveLength(1);
  });

  it("journals, restores, and re-transfers one eligible Goal inbox queue item", async () => {
    const { runtime, root } = createRuntime();
    await createGoal(runtime);
    const clientRequestId = "12121212-1212-4212-8212-121212121212";
    await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      senderId: "user",
      content: "adjust the active goal turn",
      metadata: {
        client_request_id: clientRequestId,
        webui_request_digest: "goal-steer-digest",
        webui_queue_surface: "chat_composer",
        webui: true,
        queued_at: "2026-08-10T12:00:00.000Z",
      },
      sessionKeyOverride: SESSION_KEY,
      turnSource: { kind: "gui", channel: "websocket" },
    }));

    expect(runtime.inbox(SESSION_KEY)[0]?.metadata.turn_source).toEqual({
      kind: "gui",
      channel: "websocket",
    });

    await expect(runtime.beginQueueSteerTransfer(
      SESSION_KEY,
      clientRequestId,
      "turn-active",
      "chat_composer",
      ROUTE,
    )).resolves.toMatchObject({
      outcome: "transferred",
      transfer: {
        clientRequestId,
        expectedTurnId: "turn-active",
        store: "goal",
      },
    });
    expect(runtime.inbox(SESSION_KEY)).toEqual([]);
    expect(new SessionManager(root).get(SESSION_KEY)?.metadata.webui_queue_steer_transfers)
      .toEqual([expect.objectContaining({ clientRequestId, expectedTurnId: "turn-active" })]);

    await expect(runtime.restoreGoalQueueSteerTransfer(
      SESSION_KEY,
      clientRequestId,
      "2026-08-10T12:00:01.000Z",
    )).resolves.toMatchObject({ id: clientRequestId, turnId: null });
    await expect(runtime.beginQueueSteerTransfer(
      SESSION_KEY,
      clientRequestId,
      "turn-next",
      "chat_composer",
      ROUTE,
    )).resolves.toMatchObject({
      outcome: "transferred",
      transfer: { expectedTurnId: "turn-next" },
    });
    await runtime.completeQueueSteerTransfer(SESSION_KEY, clientRequestId);
    expect(runtime.queueSteerTransfers(SESSION_KEY)).toEqual([]);
  });

  it("recovers a legacy WebUI Goal inbox source while transferring it", async () => {
    const { runtime } = createRuntime();
    await createGoal(runtime);
    const clientRequestId = "23232323-2323-4232-8232-232323232323";
    await runtime.enqueueUserMessage(SESSION_KEY, new InboundMessage({
      channel: "websocket",
      chatId: ROUTE.chatId,
      senderId: "user",
      content: "legacy GUI adjustment",
      metadata: {
        client_request_id: clientRequestId,
        webui_request_digest: "legacy-goal-steer-digest",
        webui_queue_surface: "chat_composer",
        webui: true,
        queued_at: "2026-08-10T12:00:00.000Z",
      },
      sessionKeyOverride: SESSION_KEY,
    }));

    await expect(runtime.beginQueueSteerTransfer(
      SESSION_KEY,
      clientRequestId,
      "turn-active",
      "chat_composer",
      ROUTE,
    )).resolves.toMatchObject({
      outcome: "transferred",
      transfer: {
        descriptor: {
          source: { kind: "gui", channel: "websocket" },
        },
      },
    });
    expect(runtime.route(SESSION_KEY)).toEqual({
      ...ROUTE,
      source: { kind: "gui", channel: "websocket" },
    });
  });

  it("rejects missing WebUI dedupe fields and drops unsupported metadata", () => {
    expect(() => sanitizeGoalInboxMetadata("websocket", { webui: true }))
      .toThrowError(expect.objectContaining({ code: "goal_inbox_metadata_invalid" }));
    expect(sanitizeGoalInboxMetadata("slack", {
      message_id: "m1",
      reply_to: "root",
      unsupported: new Date(),
    })).toEqual({ message_id: "m1", reply_to: "root" });
    expect(sanitizeGoalInboxMetadata("websocket", {
      client_request_id: "request-1",
      webui_request_digest: "digest-1",
      queued_at: "2026-08-09T12:00:00.000Z",
      turn_source: { kind: "tui", channel: "websocket" },
    })).toEqual({
      client_request_id: "request-1",
      webui_request_digest: "digest-1",
      queued_at: "2026-08-09T12:00:00.000Z",
      turn_source: { kind: "tui", channel: "websocket" },
    });
    expect(() => sanitizeGoalInboxMetadata("websocket", {
      client_request_id: "request-1",
      webui_request_digest: "digest-1",
      queued_at: "not-a-date",
      turn_source: { kind: "tui", channel: "websocket" },
    })).toThrowError(expect.objectContaining({ code: "goal_inbox_metadata_invalid" }));
  });
});
