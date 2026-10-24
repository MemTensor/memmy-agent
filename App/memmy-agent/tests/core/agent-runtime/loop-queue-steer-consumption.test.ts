import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, TurnContext } from "../../../src/core/agent-runtime/loop.js";
import { Tool, type ToolExecutionContext } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const SESSION_KEY = "websocket:queue-consumption";
const CHAT_ID = "queue-consumption";
const SOURCE = { kind: "gui", channel: "websocket" } as const;
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
const roots: string[] = [];
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("queue cancellation did not settle")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function untilAborted(signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

class ControlledProvider extends LLMProvider {
  readonly first = deferred();
  readonly followup = deferred();
  readonly requests: Array<Record<string, any>> = [];

  constructor(readonly mode: "request" | "tool" | "complete") { super(); }
  getDefaultModel() { return "test-model"; }
  override async chatWithRetry(args: any): Promise<LLMResponse> {
    this.requests.push(args);
    if (this.requests.length === 1) {
      await this.first.promise;
      return new LLMResponse({ content: "I will apply the queued changes." });
    }
    if (this.mode === "tool") {
      return new LLMResponse({
        content: "Applying the changes now.",
        toolCalls: [new ToolCallRequest({ id: "apply-change", name: "apply_change" })],
        finishReason: "tool_calls",
      });
    }
    await this.followup.promise;
    return new LLMResponse({ content: "Changes applied." });
  }
  override async chat(args: any) { return this.chatWithRetry(args); }
}

class BlockedTool extends Tool {
  started = false;
  get name() { return "apply_change"; }
  get description() { return "Apply the requested change in the test fixture."; }
  get parameters() { return { type: "object", properties: {} }; }
  async execute(_params: any, context?: ToolExecutionContext) {
    this.started = true;
    await untilAborted(context?.abortSignal);
    return "interrupted";
  }
}

function makeLoop(workspace: string, provider: ControlledProvider, sessions?: SessionManager) {
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider,
    workspace,
    sessionManager: sessions,
    model: "test-model",
  });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  return loop;
}

async function startFixture(store: "slot" | "goal", mode: "request" | "tool" | "complete") {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-queue-consumption-"));
  roots.push(workspace);
  const provider = new ControlledProvider(mode);
  const loop = makeLoop(workspace, provider);
  const session = loop.sessions.getOrCreate(SESSION_KEY);
  const tool = new BlockedTool();
  const tools = new ToolRegistry();
  tools.register(tool);
  const recovered: string[] = [];
  const releaseRecovered = deferred();
  const queued = vi.spyOn(loop, "publishWebuiMessageQueued");
  const accepted = vi.spyOn(loop, "publishWebuiMessageAccepted");

  // Keep admission, injection, runner, cancellation, save, and finalization real.
  // Only replace prompt construction and machine initialization with a small context.
  loop.processMessageInternal = vi.fn(async (message, _key, options: any) => {
    if (message.content !== "active") {
      recovered.push(String(message.metadata.client_request_id));
      await Promise.race([untilAborted(options.abortSignal), releaseRecovered.promise]);
      return null;
    }
    session.addMessage("user", "active", { turn_id: options.turnId, turn_source: SOURCE });
    loop.sessions.save(session);
    const ctx = new TurnContext({ msg: message, sessionKey: SESSION_KEY, session, turnId: options.turnId, slot: options.slot });
    ctx.initialMessages = [{ role: "system", content: "Follow the user instructions." }, { role: "user", content: "active" }];
    ctx.pendingQueue = options.pendingQueue;
    ctx.abortSignal = options.abortSignal;
    ctx.boundary = options.boundary;
    ctx.tools = tools;
    ctx.userPersistedEarly = true;
    await loop.stateRun(ctx);
    await loop.stateSave(ctx);
    return null;
  });

  const running = loop.run();
  cleanups.push(async () => {
    provider.first.resolve();
    provider.followup.resolve();
    releaseRecovered.resolve();
    loop.stop();
    await loop.cancelActiveTasks(SESSION_KEY);
    await running;
  });
  await loop.bus.publishInbound(new InboundMessage({
    channel: "websocket", chatId: CHAT_ID, content: "active", sessionKeyOverride: SESSION_KEY, turnSource: SOURCE,
  }));
  await waitUntil(() => provider.requests.length === 1);
  const turnId = (loop.turnSlots.get(SESSION_KEY) as any[])[0].turnId as string;

  async function enqueue(index: 0 | 1) {
    const message = new InboundMessage({
      channel: "websocket", chatId: CHAT_ID, content: `queued change ${index + 1}`,
      sessionKeyOverride: SESSION_KEY, turnSource: SOURCE,
      metadata: {
        webui: true, client_request_id: IDS[index], webui_request_digest: `digest-${index}`,
        webui_queue_surface: "chat_composer",
      },
    });
    if (store === "goal") await loop.goalRuntime.enqueueUserMessage(SESSION_KEY, message);
    else {
      await loop.bus.publishInbound(message);
      await waitUntil(async () => (await loop.getQueueSnapshot(SESSION_KEY)).items.some((item) => item.clientRequestId === IDS[index]));
    }
    await expect(loop.steerQueuedWebuiMessage(SESSION_KEY, IDS[index], turnId)).resolves.toMatchObject({ outcome: "steered" });
  }

  return { loop, session, provider, turnId, tool, queued, accepted, recovered, enqueue };
}

function usersFor(session: { messages: Record<string, any>[] }, id: string) {
  return session.messages.filter((message) => message.role === "user" && message.client_request_id === id);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.each(["slot", "goal"] as const)("queued message consumption from %s", (store) => {
  it.each(["request", "tool"] as const)("keeps both consumed messages when stopped during a %s", async (mode) => {
    const fixture = await startFixture(store, mode);
    await fixture.enqueue(0);
    await fixture.enqueue(1);
    fixture.queued.mockClear();
    fixture.provider.first.resolve();
    await waitUntil(() => mode === "tool" ? fixture.tool.started : fixture.provider.requests.length === 2);
    expect(fixture.provider.requests[1]?.messages.filter((message: any) => /^queued change [12]$/.test(message.content)).map((message: any) => message.content))
      .toEqual(["queued change 1", "queued change 2"]);
    const diskSession = new SessionManager(fixture.loop.sessions.root).get(SESSION_KEY)!;
    expect(diskSession.metadata.webui_queue_steer_transfers).toEqual(IDS.map((id) => expect.objectContaining({
      clientRequestId: id, consumedAt: expect.any(String),
    })));

    await expect(fixture.loop.stopExpectedTurn(SESSION_KEY, fixture.turnId, "gui")).resolves.toBe("stopped");
    for (const id of IDS) {
      expect(usersFor(fixture.session, id)).toHaveLength(1);
      expect(usersFor(fixture.session, id)[0]).toMatchObject({ turn_id: fixture.turnId, turn_source: SOURCE });
    }
    expect(fixture.queued).not.toHaveBeenCalled();
    expect(fixture.recovered).toEqual([]);
    expect(fixture.loop.goalRuntime.queueSteerTransfers(SESSION_KEY)).toEqual([]);
    expect(fixture.accepted.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([...IDS]);
  });

  it("restores only a second message that was not consumed before Stop", async () => {
    const fixture = await startFixture(store, "request");
    await fixture.enqueue(0);
    fixture.provider.first.resolve();
    await waitUntil(() => fixture.provider.requests.length === 2);
    await fixture.enqueue(1);
    fixture.queued.mockClear();

    await fixture.loop.stopExpectedTurn(SESSION_KEY, fixture.turnId, "gui");
    expect(usersFor(fixture.session, IDS[0])).toHaveLength(1);
    expect(usersFor(fixture.session, IDS[1])).toHaveLength(0);
    expect(fixture.queued.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([IDS[1]]);
    expect(fixture.accepted.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([IDS[0]]);
    expect(fixture.recovered).not.toContain(IDS[0]);
    await expect(withTimeout(fixture.loop.cancelActiveTasks(SESSION_KEY))).resolves.toBeGreaterThanOrEqual(0);
  });

  it("saves each consumed user once on normal completion", async () => {
    const fixture = await startFixture(store, "complete");
    await fixture.enqueue(0);
    await fixture.enqueue(1);
    fixture.queued.mockClear();
    fixture.provider.first.resolve();
    await waitUntil(() => fixture.provider.requests.length === 2);
    fixture.provider.followup.resolve();
    await waitUntil(() => !fixture.loop.isSessionBusy(SESSION_KEY));

    for (const id of IDS) expect(usersFor(fixture.session, id)).toHaveLength(1);
    expect(fixture.queued).not.toHaveBeenCalled();
    expect(fixture.recovered).toEqual([]);
    expect(fixture.loop.goalRuntime.queueSteerTransfers(SESSION_KEY)).toEqual([]);
  });

  it("keeps the first injection when persisting consumption of the second fails", async () => {
    const fixture = await startFixture(store, "request");
    await fixture.enqueue(0);
    await fixture.enqueue(1);
    const markConsumed = fixture.loop.goalRuntime.markQueueSteerTransferConsumed.bind(fixture.loop.goalRuntime);
    vi.spyOn(fixture.loop.goalRuntime, "markQueueSteerTransferConsumed").mockImplementation(async (...args) => {
      if (args[1] === IDS[1]) throw new Error("injected marker write failure");
      return markConsumed(...args);
    });
    fixture.queued.mockClear();
    fixture.provider.first.resolve();
    await waitUntil(() => fixture.provider.requests.length === 2);
    expect(fixture.provider.requests[1]?.messages.filter((message: any) => /^queued change [12]$/.test(message.content)).map((message: any) => message.content))
      .toEqual(["queued change 1"]);
    const diskSession = new SessionManager(fixture.loop.sessions.root).get(SESSION_KEY)!;
    const transfers = diskSession.metadata.webui_queue_steer_transfers;
    expect(transfers.find((transfer: any) => transfer.clientRequestId === IDS[0])?.consumedAt).toEqual(expect.any(String));
    expect(transfers.find((transfer: any) => transfer.clientRequestId === IDS[1])?.consumedAt).toBeUndefined();

    await fixture.loop.stopExpectedTurn(SESSION_KEY, fixture.turnId, "gui");
    expect(usersFor(fixture.session, IDS[0])).toHaveLength(1);
    expect(usersFor(fixture.session, IDS[1])).toHaveLength(0);
    expect(fixture.queued.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([IDS[1]]);
    expect(fixture.accepted.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([IDS[0]]);
  });

  it("restores a message whose conversion into an injection fails", async () => {
    const fixture = await startFixture(store, "complete");
    await fixture.enqueue(0);
    fixture.queued.mockClear();
    vi.spyOn(fixture.loop.context, "buildUserContent").mockImplementation(() => {
      throw new Error("injected message conversion failure");
    });
    fixture.provider.first.resolve();
    await waitUntil(() => fixture.queued.mock.calls.length === 1);
    expect(usersFor(fixture.session, IDS[0])).toHaveLength(0);
    expect(fixture.queued.mock.calls.map(([message]) => message.metadata.client_request_id)).toEqual([IDS[0]]);
    expect(fixture.accepted).not.toHaveBeenCalled();
  });

  it("recovers a durable consumed transfer after restart as a user, without requeueing it", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-consumed-restart-"));
    roots.push(workspace);
    const sessionRoot = path.join(workspace, "sessions");
    const sessions = new SessionManager(sessionRoot);
    const session = sessions.getOrCreate(SESSION_KEY);
    session.metadata.webui_queue_steer_transfers = [{
      clientRequestId: IDS[0], expectedTurnId: "original-turn", store,
      consumedAt: "2026-10-09T01:00:01.000Z",
      descriptor: {
        clientRequestId: IDS[0], content: "already acted on", media: [],
        queuedAt: "2026-10-09T01:00:00.000Z", sessionKey: SESSION_KEY,
        source: SOURCE, queueSurface: "chat_composer",
      },
      messageFields: {
        channel: "websocket", chatId: CHAT_ID, senderId: "user", content: "already acted on", media: [],
        metadata: { webui: true, client_request_id: IDS[0], webui_request_digest: "restart-digest", webui_queue_surface: "chat_composer", turn_source: SOURCE },
        timestamp: "2026-10-09T01:00:00.000Z", sessionKey: SESSION_KEY, turnSource: SOURCE,
      },
    }];
    sessions.save(session, { fsync: true });
    const restoredSessions = new SessionManager(sessionRoot);
    const loop = makeLoop(workspace, new ControlledProvider("complete"), restoredSessions);
    const queued = vi.spyOn(loop, "publishWebuiMessageQueued");
    const scheduled = vi.spyOn(loop as any, "scheduleRecoveredQueueSlot").mockImplementation(() => undefined);
    const accepted = vi.spyOn(loop, "publishWebuiMessageAccepted");

    await (loop as any).recoverQueueSteerTransfers();
    const restored = restoredSessions.get(SESSION_KEY)!;
    expect(usersFor(restored, IDS[0])).toEqual([expect.objectContaining({
      content: "already acted on", turn_id: "original-turn", turn_source: SOURCE,
      webui_request_digest: "restart-digest",
    })]);
    expect(queued).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(loop.goalRuntime.inbox(SESSION_KEY)).toEqual([]);
    expect(loop.goalRuntime.queueSteerTransfers(SESSION_KEY)).toEqual([]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(usersFor(new SessionManager(sessionRoot).get(SESSION_KEY)!, IDS[0])).toHaveLength(1);
  });
});
