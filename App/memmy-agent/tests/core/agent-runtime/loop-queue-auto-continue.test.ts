import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";

const SESSION_KEY = "websocket:queue-auto-continue";
const CHAT_ID = "queue-auto-continue";
const SOURCE = { kind: "gui", channel: "websocket" } as const;
const IDS = { A: "request-a", B: "request-b", C: "request-c" } as const;
type Label = keyof typeof IDS;
type Ending = "complete" | "stop";
const cleanups: Array<() => Promise<void>> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function cancelledError(): Error {
  const error = new Error("task cancelled");
  error.name = "TaskCancelledError";
  return error;
}

async function startFixture(activeGoal: boolean) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-queue-auto-continue-"));
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider: { getDefaultModel: () => "test-model" } as any,
    workspace,
    model: "test-model",
  });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  const session = loop.sessions.getOrCreate(SESSION_KEY);
  const finish = { A: deferred(), B: deferred(), C: deferred() };
  const consume = deferred();
  const consumed = deferred();
  const started: Label[] = [];
  const completed: Label[] = [];
  const injected: string[] = [];
  let shouldConsume = false;

  // Retain the real scheduler, durable Goal inbox, queue transfers, injection
  // conversion, and cancellation. Gates replace only the work inside a turn.
  loop.processMessageInternal = vi.fn(async (message, _key, options: any) => {
    if (message.internal) throw new Error("Unexpected autonomous Goal continuation");
    const label = message.content as Label;
    const append = () => (loop as any).appendUserMessage(message, session, { turn_id: options.turnId });
    if (loop.goalRuntime.get(SESSION_KEY) || loop.goalRuntime.inbox(SESSION_KEY).some((entry) => entry.turnId === options.turnId)) {
      await loop.goalRuntime.persistGoalUserTurn(
        SESSION_KEY, options.turnId, { channel: "websocket", chatId: CHAT_ID, source: SOURCE }, append,
      );
    } else {
      append();
      loop.sessions.save(session);
    }
    // stateRun normally opens this admission window before invoking the runner.
    if (options.slot?.state === "running") options.slot.acceptingSteer = true;
    started.push(label);
    let injections: Record<string, any>[] = [];
    if (label === "A") {
      await Promise.race([finish.A.promise, consume.promise, aborted(options.abortSignal)]);
      if (shouldConsume && !options.abortSignal.aborted) {
        injections = await (loop as any).drainPendingQueue(options.pendingQueue, 3, SESSION_KEY);
        injected.push(...injections.map((entry) => entry.content));
        consumed.resolve();
        await Promise.race([finish.A.promise, aborted(options.abortSignal)]);
      }
    } else {
      await Promise.race([finish[label].promise, aborted(options.abortSignal)]);
    }
    if (options.abortSignal.aborted) throw cancelledError();
    loop.saveTurn(session, injections, 0);
    loop.clearPendingUserTurn(session);
    loop.sessions.save(session);
    completed.push(label);
    return null;
  });

  const running = loop.run();
  cleanups.push(async () => {
    loop.stop();
    for (const gate of Object.values(finish)) gate.resolve();
    consume.resolve();
    await loop.cancelActiveTasks(SESSION_KEY);
    await running;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function enqueue(label: Label) {
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket", chatId: CHAT_ID, content: label,
      sessionKeyOverride: SESSION_KEY, turnSource: SOURCE,
      metadata: {
        webui: true, client_request_id: IDS[label], webui_request_digest: `digest-${label}`,
        webui_queue_surface: "chat_composer",
      },
    }));
    if (label !== "A") {
      await waitUntil(async () => (await loop.getQueueSnapshot(SESSION_KEY)).items.some((item) => item.clientRequestId === IDS[label]));
    }
  }

  await enqueue("A");
  await waitUntil(() => started.length === 1);
  const turnId = loop.turnSlots.get(SESSION_KEY)![0].turnId;
  if (activeGoal) {
    await loop.goalRuntime.create({
      sessionKey: SESSION_KEY, objective: "Complete the queued user work",
      route: { channel: "websocket", chatId: CHAT_ID }, turnId,
    });
  }

  async function steerB() {
    await expect(loop.steerQueuedWebuiMessage(SESSION_KEY, IDS.B, turnId)).resolves.toMatchObject({ outcome: "steered" });
  }
  async function consumeB() {
    shouldConsume = true;
    consume.resolve();
    await consumed.promise;
    expect(injected).toEqual(["B"]);
  }
  async function endA(ending: Ending) {
    if (ending === "complete") finish.A.resolve();
    else await expect(loop.stopCurrentTurn(SESSION_KEY, turnId)).resolves.toBeGreaterThanOrEqual(1);
    if (activeGoal && ending === "stop") expect(loop.goalRuntime.get(SESSION_KEY)?.status).toBe("paused");
  }
  async function finishRemaining(expected: Label[], ending: Ending) {
    for (const label of expected) {
      await waitUntil(() => started.includes(label));
      // Check execution itself: a correctly sorted snapshot cannot hide C
      // actually starting before the recovered B.
      expect(started).toEqual(["A", ...expected.slice(0, expected.indexOf(label) + 1)]);
      finish[label].resolve();
      await waitUntil(() => completed.includes(label));
    }
    await waitUntil(() => !loop.isSessionBusy(SESSION_KEY));
    expect(started).toEqual(["A", ...expected]);
    expect(completed).toEqual([...(ending === "complete" ? ["A"] : []), ...expected]);
    expect((await loop.getQueueSnapshot(SESSION_KEY)).items).toEqual([]);
    expect(loop.goalRuntime.inbox(SESSION_KEY)).toEqual([]);
    expect(loop.goalRuntime.queueSteerTransfers(SESSION_KEY)).toEqual([]);
  }
  function usersFor(label: Label) {
    return session.messages.filter((message) => message.role === "user" && message.client_request_id === IDS[label]);
  }

  return { loop, started, completed, turnId, enqueue, steerB, consumeB, endA, finishRemaining, usersFor };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe.each([false, true])("queue automatic continuation with active Goal=%s", (activeGoal) => {
  it.each(["complete", "stop"] as const)("runs ordinary B then C after A %s", async (ending) => {
    const fixture = await startFixture(activeGoal);
    await fixture.enqueue("B");
    await fixture.enqueue("C");
    expect(fixture.started).toEqual(["A"]);
    await fixture.endA(ending);
    await fixture.finishRemaining(["B", "C"], ending);
    for (const label of ["A", "B", "C"] as const) expect(fixture.usersFor(label)).toHaveLength(1);
  });

  it.each(["complete", "stop"] as const)("runs unconsumed steered B before queued C after A %s", async (ending) => {
    const fixture = await startFixture(activeGoal);
    await fixture.enqueue("B");
    await fixture.steerB();
    await fixture.enqueue("C");
    expect(fixture.started).toEqual(["A"]);
    await fixture.endA(ending);
    await fixture.finishRemaining(["B", "C"], ending);
    expect(fixture.usersFor("B")).toHaveLength(1);
    expect(fixture.usersFor("C")).toHaveLength(1);
  });

  it.each(["complete", "stop"] as const)("does not rerun consumed B and continues queued C after A %s", async (ending) => {
    const fixture = await startFixture(activeGoal);
    await fixture.enqueue("B");
    await fixture.steerB();
    await fixture.consumeB();
    await fixture.enqueue("C");
    await fixture.endA(ending);
    await fixture.finishRemaining(["C"], ending);
    expect(fixture.usersFor("B")).toHaveLength(1);
    expect(fixture.usersFor("C")).toHaveLength(1);
    expect(fixture.started).not.toContain("B");
  });

  it("also preserves B and C when the targeted stopExpectedTurn API stops A", async () => {
    const fixture = await startFixture(activeGoal);
    await fixture.enqueue("B");
    await fixture.steerB();
    await fixture.enqueue("C");
    await expect(fixture.loop.stopExpectedTurn(SESSION_KEY, fixture.turnId, "gui")).resolves.toBe("stopped");
    await fixture.finishRemaining(["B", "C"], "stop");
  });
});
