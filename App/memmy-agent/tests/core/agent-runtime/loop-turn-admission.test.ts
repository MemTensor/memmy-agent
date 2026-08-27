import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { SessionManager } from "../../../src/core/session/manager.js";

const roots: string[] = [];

function makeLoop(): AgentLoop {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-turn-admission-"));
  roots.push(workspace);
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider: {
      generation: { maxTokens: 256 },
      getDefaultModel: () => "test-model",
    },
    workspace,
    model: "test-model",
  });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  return loop;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

async function startBlockedGoalTurn(
  loop: AgentLoop,
  {
    sessionKey,
    chatId,
    activeTurnId,
    sourceKind,
  }: {
    sessionKey: string;
    chatId: string;
    activeTurnId: string;
    sourceKind: "gui" | "tui";
  },
): Promise<{ releaseActive: () => void; running: Promise<void> }> {
  loop.sessions.getOrCreate(sessionKey);
  const source = { kind: sourceKind, channel: "websocket" } as const;
  const goal = await loop.goalRuntime.create({
    sessionKey,
    objective: "Keep working on the Goal",
    route: { channel: "websocket", chatId, source },
    turnId: "goal-create-turn",
  });
  loop.goalRuntime.releaseTurn(sessionKey, "goal-create-turn");
  while (loop.bus.outboundSize) await loop.bus.consumeOutbound();
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
    if (message.internal?.kind === "goal_continuation") {
      options.slot.acceptingSteer = true;
      await activeGate;
    }
    options.slot.stopReason = "completed";
    return null;
  }) as any;
  const running = loop.run();
  expect(loop.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
  await loop.bus.publishInbound(new InboundMessage({
    channel: "websocket",
    chatId,
    content: "Continue the Goal",
    metadata: { turn_id: activeTurnId },
    internal: {
      kind: "goal_continuation",
      goalId: goal.goalId,
      goalUpdatedAt: goal.updatedAt,
    },
    sessionKeyOverride: sessionKey,
    turnSource: source,
  }));
  await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
  return { releaseActive, running };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop Turn admission", () => {
  it("creates one FIFO Turn Slot for every default message, including the same route", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "A") await firstGate;
      return null;
    }) as any;

    const running = loop.run();
    for (const content of ["A", "B", "C"]) {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "telegram",
        chatId: "same-chat",
        senderId: "user",
        content,
      }));
      if (content === "A") await waitUntil(() => started.length === 1);
    }

    await waitUntil(() => (loop.turnSlots.get("telegram:same-chat")?.length ?? 0) === 3);
    const slots = loop.turnSlots.get("telegram:same-chat") as any[];
    expect(slots.map((slot) => slot.root.content)).toEqual(["A", "B", "C"]);
    expect(slots.map((slot) => slot.pendingSteer.size)).toEqual([0, 0, 0]);
    expect(new Set(slots.map((slot) => slot.turnId)).size).toBe(3);

    releaseFirst();
    await waitUntil(() => started.length === 3);
    await waitUntil(() => !loop.isSessionBusy("telegram:same-chat"));
    expect(started).toEqual(["A", "B", "C"]);
    loop.stop();
    await running;
  });

  it("steers only the active accepting Slot instead of the last queued Slot", async () => {
    const loop = makeLoop();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "turns",
      senderId: "user",
      content: "active",
      sessionKeyOverride: "cli:turns",
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get("cli:turns") as any[])?.[0]?.acceptingSteer === true);
    const activeTurnId = (loop.turnSlots.get("cli:turns") as any[])[0].turnId;
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "turns",
      senderId: "user",
      content: "queued",
      sessionKeyOverride: "cli:turns",
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get("cli:turns")?.length ?? 0) === 2);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "turns",
      senderId: "user",
      content: "correction",
      sessionKeyOverride: "cli:turns",
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(() => ((loop.turnSlots.get("cli:turns") as any[])?.[0]?.pendingSteer.size ?? 0) === 1);
    const slots = loop.turnSlots.get("cli:turns") as any[];
    expect(slots[0].pendingSteer.getNowait().content).toBe("correction");
    expect(slots[1].pendingSteer.size).toBe(0);
    slots[0].pendingSteer.put(new InboundMessage({
      channel: "websocket",
      chatId: "turns",
      senderId: "user",
      content: "correction",
      sessionKeyOverride: "cli:turns",
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy("cli:turns"));
    loop.stop();
    await running;
  });

  it("admits a TUI Steer into the active TUI-owned Goal Turn before the Goal inbox", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:tui-goal-steer";
    const chatId = "tui-goal-steer";
    const activeTurnId = "11111111-1111-4111-8111-111111111111";
    const clientRequestId = "12121212-1212-4212-8212-121212121212";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "Keep implementing the Goal",
      route: {
        channel: "websocket",
        chatId,
        source: { kind: "tui", channel: "websocket" },
      },
      turnId: "goal-create-turn",
    });
    loop.goalRuntime.releaseTurn(sessionKey, "goal-create-turn");
    while (loop.bus.outboundSize) await loop.bus.consumeOutbound();

    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.internal?.kind === "goal_continuation") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    expect(loop.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Continue the Goal",
      metadata: { turn_id: activeTurnId },
      internal: {
        kind: "goal_continuation",
        goalId: goal.goalId,
        goalUpdatedAt: goal.updatedAt,
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({ revision: 0, items: [] });

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Also verify the TUI path",
      media: ["/tmp/tui-goal-reference.png"],
      metadata: {
        client_request_id: clientRequestId,
        webui_request_digest: "tui-goal-steer-digest",
      },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(() => ((loop.turnSlots.get(sessionKey) as any[])?.[0]?.pendingSteer.size ?? 0) === 1);
    const slot = (loop.turnSlots.get(sessionKey) as any[])[0];
    expect(slot.pendingSteer.getNowait()).toMatchObject({
      content: "Also verify the TUI path",
      media: ["/tmp/tui-goal-reference.png"],
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
      metadata: {
        client_request_id: clientRequestId,
        turn_id: activeTurnId,
        turnId: activeTurnId,
      },
    });
    expect(loop.goalRuntime.inbox(sessionKey)).toEqual([]);
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({
      revision: 0,
      items: [],
      startedItems: [],
    });
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiMessageSteered)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          clientRequestId,
          turnId: activeTurnId,
        }),
      }),
    ]);
    expect(outbound.some((message) => message.metadata?.webuiMessageQueued)).toBe(false);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("queues Enter, stale TUI Steer, and slash TUI Steer once during an active Goal", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:tui-goal-fallback";
    const chatId = "tui-goal-fallback";
    const activeTurnId = "13131313-1313-4313-8313-131313131313";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "Keep the Goal queue ordered",
      route: {
        channel: "websocket",
        chatId,
        source: { kind: "tui", channel: "websocket" },
      },
      turnId: "goal-create-turn",
    });
    loop.goalRuntime.releaseTurn(sessionKey, "goal-create-turn");
    while (loop.bus.outboundSize) await loop.bus.consumeOutbound();

    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.internal?.kind === "goal_continuation") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    expect(loop.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Continue the Goal",
      metadata: { turn_id: activeTurnId },
      internal: {
        kind: "goal_continuation",
        goalId: goal.goalId,
        goalUpdatedAt: goal.updatedAt,
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);

    const messages = [
      new InboundMessage({
        channel: "websocket",
        chatId,
        content: "queue this with Enter",
        metadata: {
          webui: true,
          client_request_id: "14141414-1414-4414-8414-141414141414",
          webui_request_digest: "tui-goal-enter-digest",
        },
        sessionKeyOverride: sessionKey,
        turnSource: { kind: "tui", channel: "websocket" },
      }),
      new InboundMessage({
        channel: "websocket",
        chatId,
        content: "stale correction",
        metadata: {
          webui: true,
          client_request_id: "15151515-1515-4515-8515-151515151515",
          webui_request_digest: "tui-goal-stale-digest",
        },
        sessionKeyOverride: sessionKey,
        turnAdmission: "steer",
        expectedTurnId: "stale-turn-id",
        turnSource: { kind: "tui", channel: "websocket" },
      }),
      new InboundMessage({
        channel: "websocket",
        chatId,
        content: "/help",
        metadata: {
          webui: true,
          client_request_id: "16161616-1616-4616-8616-161616161616",
          webui_request_digest: "tui-goal-slash-digest",
        },
        sessionKeyOverride: sessionKey,
        turnAdmission: "steer",
        expectedTurnId: activeTurnId,
        turnSource: { kind: "tui", channel: "websocket" },
      }),
    ];
    for (const message of messages) await loop.bus.publishInbound(message);

    await waitUntil(() => loop.goalRuntime.inbox(sessionKey).length === messages.length);
    expect(loop.goalRuntime.inbox(sessionKey).map((entry) => entry.content)).toEqual([
      "queue this with Enter",
      "stale correction",
      "/help",
    ]);
    expect((loop.turnSlots.get(sessionKey) as any[])[0].pendingSteer.size).toBe(0);
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({
      revision: 3,
      items: [
        expect.objectContaining({ content: "queue this with Enter" }),
        expect.objectContaining({ content: "stale correction" }),
        expect.objectContaining({ content: "/help" }),
      ],
    });
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiMessageQueued)).toHaveLength(3);
    expect(outbound.some((message) => message.metadata?.webuiMessageSteered)).toBe(false);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("does not let a TUI Steer enter a GUI-owned Goal Turn", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:gui-owned-goal";
    const chatId = "gui-owned-goal";
    const activeTurnId = "19191919-1919-4919-8919-191919191919";
    const clientRequestId = "20202020-2020-4020-8020-202020202020";
    const { releaseActive, running } = await startBlockedGoalTurn(loop, {
      sessionKey,
      chatId,
      activeTurnId,
      sourceKind: "gui",
    });

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Do not inject this into the GUI Turn",
      metadata: {
        webui: true,
        client_request_id: clientRequestId,
        webui_request_digest: "gui-owned-goal-digest",
      },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(() => loop.goalRuntime.inbox(sessionKey).length === 1);
    expect(loop.goalRuntime.inbox(sessionKey)).toEqual([
      expect.objectContaining({ id: clientRequestId, content: "Do not inject this into the GUI Turn" }),
    ]);
    expect((loop.turnSlots.get(sessionKey) as any[])[0].pendingSteer.size).toBe(0);
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({ revision: 1 });
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiMessageQueued)).toHaveLength(1);
    expect(outbound.some((message) => message.metadata?.webuiMessageSteered)).toBe(false);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("queues TUI Goal Steer when the source channel mismatches or the Turn is settling", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:tui-goal-race";
    const chatId = "tui-goal-race";
    const activeTurnId = "21212121-2121-4121-8121-212121212121";
    const { releaseActive, running } = await startBlockedGoalTurn(loop, {
      sessionKey,
      chatId,
      activeTurnId,
      sourceKind: "tui",
    });

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Wrong trusted source channel",
      metadata: {
        webui: true,
        client_request_id: "22222222-2222-4222-8222-222222222222",
        webui_request_digest: "tui-goal-channel-digest",
      },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "cli" },
    }));
    await waitUntil(() => loop.goalRuntime.inbox(sessionKey).length === 1);

    const slot = (loop.turnSlots.get(sessionKey) as any[])[0];
    slot.acceptingSteer = false;
    slot.state = "settling";
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "The Turn is already settling",
      metadata: {
        webui: true,
        client_request_id: "23232323-2323-4323-8323-232323232323",
        webui_request_digest: "tui-goal-settling-digest",
      },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(() => loop.goalRuntime.inbox(sessionKey).length === 2);
    expect(loop.goalRuntime.inbox(sessionKey).map((entry) => entry.content)).toEqual([
      "Wrong trusted source channel",
      "The Turn is already settling",
    ]);
    expect(slot.pendingSteer.size).toBe(0);
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({ revision: 2 });
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiMessageQueued)).toHaveLength(2);
    expect(outbound.some((message) => message.metadata?.webuiMessageSteered)).toBe(false);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("degrades steer to queue when route or active state does not match", async () => {
    const loop = makeLoop();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;
    loop.unifiedSession = true;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "route-a",
      senderId: "user",
      content: "active",
    }));
    await waitUntil(() => (loop.turnSlots.get(UNIFIED_SESSION_KEY) as any[])?.[0]?.acceptingSteer === true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "route-b",
      senderId: "user",
      content: "wrong route",
      turnAdmission: "steer",
    }));

    await waitUntil(() => (loop.turnSlots.get(UNIFIED_SESSION_KEY)?.length ?? 0) === 2);
    const queued = (loop.turnSlots.get(UNIFIED_SESSION_KEY) as any[])[1];
    expect(queued.root.content).toBe("wrong route");
    expect(queued.root.turnAdmission).toBe("queue");
    expect(queued.pendingSteer.size).toBe(0);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(UNIFIED_SESSION_KEY));
    loop.stop();
    await running;
  });

  it("degrades a stale TUI Steer to exactly one shared Queue item", async () => {
    const loop = makeLoop();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      return null;
    }) as any;
    const sessionKey = "cli:stale-steer";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_stale",
      content: "active",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_stale",
      content: "stale correction",
      metadata: { client_request_id: "10101010-1010-4010-8010-101010101010" },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: "stale-turn-id",
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(async () => (await loop.getQueueSnapshot(sessionKey)).items.length === 1);
    expect((await loop.getQueueSnapshot(sessionKey))).toMatchObject({
      revision: 1,
      items: [{
        clientRequestId: "10101010-1010-4010-8010-101010101010",
        content: "stale correction",
        source: { kind: "tui", channel: "websocket" },
      }],
    });
    const queuedEvents = [];
    while (loop.bus.outboundSize) queuedEvents.push(await loop.bus.consumeOutbound());
    expect(queuedEvents.filter((message) => message.metadata?.webuiMessageQueued)).toHaveLength(1);
    expect(queuedEvents.some((message) => message.metadata?.webuiMessageSteered)).toBe(false);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("shares one FIFO and monotonic revision across GUI, TUI, and IM sources", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "active") await activeGate;
      return null;
    }) as any;
    const sessionKey = "cli:mixed-sources";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_mixed",
      content: "active",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => started.length === 1);
    expect(await loop.getQueueSnapshot(sessionKey)).toEqual({ revision: 0, items: [], startedItems: [] });

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_mixed",
      content: "from GUI",
      metadata: { client_request_id: "11111111-1111-4111-8111-111111111111" },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_mixed",
      content: "from TUI",
      metadata: { client_request_id: "22222222-2222-4222-8222-222222222222" },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await loop.bus.publishInbound(new InboundMessage({
      channel: "slack",
      chatId: "room",
      content: "from IM",
      timestamp: new Date("2020-01-01T00:00:00.000Z"),
      sessionKeyOverride: sessionKey,
    }));

    await waitUntil(async () => (await loop.getQueueSnapshot(sessionKey)).items.length === 3);
    const snapshot = await loop.getQueueSnapshot(sessionKey);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.items.map((item) => [item.content, item.source])).toEqual([
      ["from GUI", { kind: "gui", channel: "websocket" }],
      ["from TUI", { kind: "tui", channel: "websocket" }],
      ["from IM", { kind: "im", channel: "slack" }],
    ]);
    expect(snapshot.items.every((item, index, items) => (
      index === 0 || item.queuedAt > items[index - 1]!.queuedAt
    ))).toBe(true);
    expect(snapshot.items[2]?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);

    releaseActive();
    await waitUntil(() => started.length === 4);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(started).toEqual(["active", "from GUI", "from TUI", "from IM"]);
    const finalSnapshot = await loop.getQueueSnapshot(sessionKey);
    expect(finalSnapshot).toEqual({ revision: 6, items: [], startedItems: [] });
    const events = [];
    while (loop.bus.outboundSize) events.push(await loop.bus.consumeOutbound());
    expect(events.filter((message) => message.metadata?.webuiMessageQueued)
      .map((message) => message.metadata.queueRevision)).toEqual([1, 2, 3]);
    expect(events.filter((message) => message.metadata?.webuiMessageDequeued)
      .map((message) => message.metadata.queueRevision)).toEqual([4, 5, 6]);
    loop.stop();
    await running;
  });

  it("emits message_queued before a busy WebUI root is accepted", async () => {
    const loop = makeLoop();
    loop.unifiedSession = true;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "first") await firstGate;
      if (message.content === "second") {
        await loop.publishWebuiMessageAccepted(message, options.slot);
      }
      return null;
    }) as any;

    const running = loop.run();
    const requestSessionKey = "websocket:queued-ui";
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queued-ui",
      senderId: "user",
      content: "first",
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queued-ui",
      senderId: "user",
      content: "second",
      metadata: {
        webui: true,
        client_request_id: "11111111-1111-4111-8111-111111111111",
      },
      turnSource: { kind: "gui", channel: "websocket" },
    }));

    await waitUntil(() => loop.bus.outboundSize === 1);
    const queued = await loop.bus.consumeOutbound();
    expect(queued.metadata).toMatchObject({
      webuiMessageQueued: true,
      webuiRequestSessionKey: requestSessionKey,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
    });

    releaseFirst();
    await waitUntil(() => loop.bus.outboundSize >= 2);
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    const acceptedIndex = outbound.findIndex((message) => message.metadata?.webuiMessageAccepted);
    const runningIndex = outbound.findIndex((message) => message.metadata?.runStatus === "running");
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(runningIndex);
    await waitUntil(() => !loop.isSessionBusy(UNIFIED_SESSION_KEY));
    loop.stop();
    await running;
  });

  it("projects visible composer slots, removes only the selected queued Turn, and dequeues on start", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      started.push(message.content);
      if (message.content === "running") await firstGate;
      if (message.metadata?.client_request_id) {
        await loop.publishWebuiMessageAccepted(message, options.slot);
      }
      return null;
    }) as any;
    const cancelAll = vi.spyOn(loop, "cancelActiveTasks");
    const sessionKey = "websocket:visible-queue";
    const requests = [
      ["11111111-1111-4111-8111-111111111111", "first queued", "2026-08-09T12:00:01.000Z"],
      ["22222222-2222-4222-8222-222222222222", "remove queued", "2026-08-09T12:00:02.000Z"],
      ["33333333-3333-4333-8333-333333333333", "last queued", "2026-08-09T12:00:03.000Z"],
    ] as const;
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "visible-queue",
      senderId: "user",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    for (const [clientRequestId, content, timestamp] of requests) {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "visible-queue",
        senderId: "user",
        content,
        timestamp: new Date(timestamp),
        metadata: {
          webui: true,
          client_request_id: clientRequestId,
          webui_queue_surface: "chat_composer",
        },
      }));
    }
    await waitUntil(async () => (await loop.getWebuiQueueSnapshot(sessionKey)).items.length === 3);
    expect(await loop.getWebuiQueueSnapshot(sessionKey)).toMatchObject({ revision: 3 });
    expect((await loop.getWebuiQueueSnapshot(sessionKey)).items.map((item) => item.clientRequestId))
      .toEqual(requests.map(([id]) => id));
    await expect(loop.removeQueuedWebuiMessage(sessionKey, requests[1][0])).resolves.toMatchObject({
      outcome: "removed",
      revision: 4,
    });
    expect(cancelAll).not.toHaveBeenCalled();
    expect((await loop.getWebuiQueueSnapshot(sessionKey)).items.map((item) => item.clientRequestId))
      .toEqual([requests[0][0], requests[2][0]]);

    releaseFirst();
    await waitUntil(() => started.length === 3);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(started).toEqual(["running", "first queued", "last queued"]);
    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiQueueItem && message.metadata?.webuiMessageQueued))
      .toHaveLength(3);
    expect(outbound.filter((message) => message.metadata?.webuiMessageDequeued)
      .map((message) => message.metadata?.clientRequestId))
      .toEqual([requests[0][0], requests[2][0]]);
    expect(await loop.getWebuiQueueSnapshot(sessionKey)).toMatchObject({ revision: 6, items: [], startedItems: [] });
    expect(outbound.filter((message) => message.metadata?.webuiMessageQueued)
      .map((message) => message.metadata.queueRevision)).toEqual([1, 2, 3]);
    expect(outbound.filter((message) => message.metadata?.webuiMessageDequeued)
      .map((message) => message.metadata.queueRevision)).toEqual([5, 6]);
    loop.stop();
    await running;
  });

  it("cancels a visible queued Turn while its queue announcement is still publishing", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseRunning!: () => void;
    let releaseAnnouncement!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const announcementGate = new Promise<void>((resolve) => {
      releaseAnnouncement = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "running") await runningGate;
      return null;
    }) as any;
    const originalPublishOutbound = loop.bus.publishOutbound.bind(loop.bus);
    let announcementEntered = false;
    loop.bus.publishOutbound = vi.fn(async (message) => {
      if (message.metadata?.webuiMessageQueued && message.metadata?.webuiQueueItem) {
        announcementEntered = true;
        await announcementGate;
      }
      await originalPublishOutbound(message);
    });
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-gate",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-gate",
      content: "queued",
      metadata: {
        webui: true,
        client_request_id: "44444444-4444-4444-8444-444444444444",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(() => announcementEntered);
    releaseRunning();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["running"]);

    await expect(loop.removeQueuedWebuiMessage(
      "websocket:announcement-gate",
      "44444444-4444-4444-8444-444444444444",
    )).resolves.toMatchObject({ outcome: "removed" });

    releaseAnnouncement();
    await waitUntil(() => !loop.isSessionBusy("websocket:announcement-gate"));
    expect(started).toEqual(["running"]);
    expect(await loop.getWebuiQueueSnapshot("websocket:announcement-gate"))
      .toMatchObject({ items: [], startedItems: [] });
    loop.stop();
    await running;
  });

  it("drops a visible queued Turn when its queue announcement fails", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      started.push(message.content);
      if (message.content === "running") await runningGate;
      return null;
    }) as any;
    const originalPublishOutbound = loop.bus.publishOutbound.bind(loop.bus);
    loop.bus.publishOutbound = vi.fn(async (message) => {
      if (message.metadata?.webuiMessageQueued && message.metadata?.webuiQueueItem) {
        throw new Error("queue announcement failed");
      }
      await originalPublishOutbound(message);
    });
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-failure",
      content: "running",
    }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "announcement-failure",
      content: "must not start",
      metadata: {
        webui: true,
        client_request_id: "55555555-5555-4555-8555-555555555555",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(() => loop.bus.outboundSize > 0);
    const rejected = await loop.bus.consumeOutbound();
    expect(rejected.metadata).toMatchObject({
      webuiMessageRejected: true,
      clientRequestId: "55555555-5555-4555-8555-555555555555",
      reason: "turn_start_failed",
    });
    expect(await loop.getWebuiQueueSnapshot("websocket:announcement-failure"))
      .toMatchObject({ items: [], startedItems: [] });

    releaseRunning();
    await waitUntil(() => !loop.isSessionBusy("websocket:announcement-failure"));
    expect(started).toEqual(["running"]);
    loop.stop();
    await running;
  });

  it("publishes Goal inbox queued, accepted, and dequeued events at their distinct lifecycle boundaries", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:goal-queue";
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "keep working",
      tokenBudget: 1_000,
      route: { channel: "websocket", chatId: "goal-queue" },
      turnId: "turn-create",
    });
    while (loop.bus.outboundSize) await loop.bus.consumeOutbound();
    let releaseInboxTurn!: () => void;
    const inboxTurnGate = new Promise<void>((resolve) => {
      releaseInboxTurn = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      if (message.metadata?.client_request_id === clientRequestId) await inboxTurnGate;
      return null;
    }) as any;
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "goal-queue",
      content: "persisted inbox question",
      timestamp: new Date("2026-08-09T12:00:00.000Z"),
      metadata: {
        webui: true,
        client_request_id: clientRequestId,
        webui_request_digest: "goal-queue-digest",
        webui_queue_surface: "chat_composer",
      },
    }));
    await waitUntil(async () => (await loop.getWebuiQueueSnapshot(sessionKey)).items.length === 1);
    const beforeStart = [];
    while (loop.bus.outboundSize) beforeStart.push(await loop.bus.consumeOutbound());
    expect(beforeStart.filter((message) => (
      message.metadata?.webuiMessageQueued || message.metadata?.webuiMessageAccepted
    )).map((message) => (
      message.metadata?.webuiMessageQueued ? "queued" : "accepted"
    ))).toEqual(["queued", "accepted"]);

    loop.goalRuntime.releaseTurn(sessionKey, "turn-create");
    await (loop as any).dispatchNextGoalWork(sessionKey);
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    expect(await loop.getWebuiQueueSnapshot(sessionKey)).toMatchObject({
      items: [],
      startedItems: [expect.objectContaining({ clientRequestId })],
    });
    const afterStart = [];
    while (loop.bus.outboundSize) afterStart.push(await loop.bus.consumeOutbound());
    expect(afterStart.some((message) => (
      message.metadata?.webuiMessageDequeued
      && message.metadata?.clientRequestId === clientRequestId
    ))).toBe(true);

    releaseInboxTurn();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(loop.goalRuntime.get(sessionKey)).toMatchObject({ goalId: goal.goalId, status: "active" });
    loop.stop();
    await running;
  });

  it("converts deletion-barrier input to queue and emits one queued acknowledgement", async () => {
    const loop = makeLoop();
    loop.processMessageInternal = vi.fn(async () => null) as any;
    const sessionKey = "websocket:deletion";
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = loop.withSessionDeletionBarrier(
      sessionKey,
      () => deletionGate,
      async () => undefined,
    );
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "deletion",
      senderId: "user",
      content: "survive deletion",
      metadata: {
        webui: true,
        client_request_id: "22222222-2222-4222-8222-222222222222",
      },
      turnAdmission: "steer",
      turnSource: { kind: "gui", channel: "websocket" },
    }));

    await waitUntil(() => (loop.sessionDeletionQueues.get(sessionKey)?.length ?? 0) === 1);
    expect(loop.sessionDeletionQueues.get(sessionKey)?.[0]?.turnAdmission).toBe("queue");
    const queued = await loop.bus.consumeOutbound();
    expect(queued.metadata?.webuiMessageQueued).toBe(true);

    releaseDeletion();
    await deletion;
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    expect((loop.processMessageInternal as any).mock.calls[0][0].turnAdmission).toBe("queue");
    expect((loop.processMessageInternal as any).mock.calls).toHaveLength(1);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("rejects a queued WebUI root exactly once when Stop cancels it before acceptance", async () => {
    const loop = makeLoop();
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content !== "running") return null;
      await new Promise<void>((resolve) => {
        if (options.abortSignal.aborted) {
          resolve();
          return;
        }
        options.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    }) as any;
    const sessionKey = "websocket:cancel-queue";
    const clientRequestId = "33333333-3333-4333-8333-333333333333";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "cancel-queue",
      senderId: "user",
      content: "running",
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "cancel-queue",
      senderId: "user",
      content: "queued",
      metadata: { webui: true, client_request_id: clientRequestId },
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey)?.length ?? 0) === 2);
    await loop.cancelActiveTasks(sessionKey);
    await waitUntil(() => !loop.isSessionBusy(sessionKey));

    const outbound = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    expect(outbound.filter((message) => message.metadata?.webuiMessageQueueRemoved))
      .toEqual([expect.objectContaining({
        metadata: expect.objectContaining({
          clientRequestId,
          queueRevision: 2,
        }),
      })]);
    const rejections = outbound.filter((message) => message.metadata?.webuiMessageRejected);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].metadata).toMatchObject({
      clientRequestId,
      reason: "turn_queue_cancelled",
    });
    expect((loop.processMessageInternal as any).mock.calls).toHaveLength(1);
    loop.stop();
    await running;
  });

  it("acknowledges safe inline TUI commands and rejects broad TUI process controls", async () => {
    const loop = makeLoop();
    const cancelAll = vi.spyOn(loop, "cancelActiveTasks");
    const sessionKey = "cli:tui-inline-command";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_tui_inline",
      content: "/status",
      metadata: {
        client_request_id: "77777777-7777-4777-8777-777777777777",
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));

    await waitUntil(() => loop.bus.outboundSize >= 2);
    const statusMessages = [];
    while (loop.bus.outboundSize) statusMessages.push(await loop.bus.consumeOutbound());
    expect(statusMessages.some((message) => message.metadata?.webuiMessageAccepted)).toBe(true);
    expect(statusMessages.find((message) => message.content)?.metadata).toMatchObject({
      turn_source: { kind: "tui", channel: "websocket" },
    });

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_tui_inline",
      content: "/stop",
      metadata: {
        client_request_id: "88888888-8888-4888-8888-888888888888",
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => loop.bus.outboundSize >= 1);
    const rejected = await loop.bus.consumeOutbound();
    expect(rejected.metadata).toMatchObject({
      webuiMessageRejected: true,
      reason: "tui_targeted_control_required",
    });
    expect(cancelAll).not.toHaveBeenCalled();
    loop.stop();
    await running;
  });

  it("targets Stop to the exact active TUI Turn and never stops a GUI Turn", async () => {
    const loop = makeLoop();
    let releaseGui!: () => void;
    const guiGate = new Promise<void>((resolve) => {
      releaseGui = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "TUI running") {
        await new Promise<void>((resolve) => {
          if (options.abortSignal.aborted) resolve();
          else options.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (message.content === "GUI running") await guiGate;
      return null;
    }) as any;
    const sessionKey = "cli:targeted-stop";
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_stop",
      content: "TUI running",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 1);
    const tuiTurnId = (loop.turnSlots.get(sessionKey) as any[])[0].turnId;
    await expect(loop.stopExpectedTurn(sessionKey, "stale-id", "tui")).resolves.toBe("already_finished");
    expect(loop.isSessionBusy(sessionKey)).toBe(true);
    await expect(loop.stopExpectedTurn(sessionKey, tuiTurnId, "tui")).resolves.toBe("stopped");
    await waitUntil(() => !loop.isSessionBusy(sessionKey));

    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_stop",
      content: "GUI running",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.processMessageInternal as any).mock.calls.length === 2);
    const guiTurnId = (loop.turnSlots.get(sessionKey) as any[])[0].turnId;
    await expect(loop.stopExpectedTurn(sessionKey, guiTurnId, "tui")).resolves.toBe("not_owned");
    expect(loop.isSessionBusy(sessionKey)).toBe(true);
    releaseGui();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("persists a TUI command response with its source and Turn identity", async () => {
    const loop = makeLoop();
    const sessionKey = "cli:tui-command";
    const session = loop.sessions.getOrCreate(sessionKey);
    const source = { kind: "tui", channel: "websocket" } as const;
    const result = await loop.dispatchCommand(
      new InboundMessage({
        channel: "websocket",
        chatId: "ext_tui_command",
        content: "/help",
        metadata: {
          client_request_id: "66666666-6666-4666-8666-666666666666",
        },
        sessionKeyOverride: sessionKey,
        turnSource: source,
      }),
      session,
      sessionKey,
      null,
      "turn-tui-command",
    );

    expect(result).not.toBeNull();
    expect(session.messages).toHaveLength(2);
    expect(session.messages).toEqual([
      expect.objectContaining({
        role: "user",
        commandMessage: true,
        turn_id: "turn-tui-command",
        turn_source: source,
      }),
      expect.objectContaining({
        role: "assistant",
        commandMessage: true,
        turn_id: "turn-tui-command",
        turn_source: source,
      }),
    ]);
  });

  it("atomically moves an eligible GUI queue item into the active Turn once", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:queue-steer";
    const clientRequestId = "88888888-8888-4888-8888-888888888888";
    const session = loop.sessions.getOrCreate(sessionKey);
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
        const pending = options.pendingQueue.getNowait() as InboundMessage | undefined;
        if (pending) {
          session.addMessage("user", pending.content, {
            client_request_id: pending.metadata.client_request_id,
            turn_id: options.turnId,
          });
          loop.sessions.save(session, { fsync: true });
        }
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queue-steer",
      content: "active",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    const activeTurnId = (loop.turnSlots.get(sessionKey) as any[])[0].turnId as string;
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queue-steer",
      content: "please adjust",
      metadata: {
        client_request_id: clientRequestId,
        webui_queue_surface: "chat_composer",
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(async () => (await loop.getQueueSnapshot(sessionKey)).items.length === 1);

    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      activeTurnId,
    )).resolves.toMatchObject({
      outcome: "steered",
      revision: 2,
      turnId: activeTurnId,
      descriptor: {
        clientRequestId,
        queueSurface: "chat_composer",
        turnAdmission: "steer",
        turnId: activeTurnId,
      },
    });
    expect(await loop.getQueueSnapshot(sessionKey)).toMatchObject({
      revision: 2,
      items: [],
      startedItems: [{ clientRequestId, turnAdmission: "steer", turnId: activeTurnId }],
    });
    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      activeTurnId,
    )).resolves.toEqual({ outcome: "already_dequeued", revision: 2 });

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    expect(session.messages).toEqual([
      expect.objectContaining({
        role: "user",
        client_request_id: clientRequestId,
        turn_id: activeTurnId,
      }),
    ]);
    expect(loop.goalRuntime.queueSteerTransfers(sessionKey)).toEqual([]);
    loop.stop();
    await running;
  });

  it("steers a GUI Goal inbox item into a legacy continuation without source metadata", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:legacy-goal-steer";
    const chatId = "legacy-goal-steer";
    const clientRequestId = "78787878-7878-4878-8878-787878787878";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "Finish the legacy Goal",
      route: { channel: "websocket", chatId },
      turnId: "goal-create-turn",
    });
    loop.goalRuntime.releaseTurn(sessionKey, "goal-create-turn");
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.internal?.kind === "goal_continuation") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    const activeTurnId = "legacy-goal-active-turn";
    expect(loop.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Continue the Goal",
      metadata: { turn_id: activeTurnId },
      internal: {
        kind: "goal_continuation",
        goalId: goal.goalId,
        goalUpdatedAt: goal.updatedAt,
      },
      sessionKeyOverride: sessionKey,
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "put it on the desktop",
      metadata: {
        client_request_id: clientRequestId,
        webui_request_digest: "legacy-goal-steer-digest",
        webui_queue_surface: "chat_composer",
        webui: true,
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(() => loop.goalRuntime.inbox(sessionKey).length === 1);

    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      activeTurnId,
    )).resolves.toMatchObject({
      outcome: "steered",
      turnId: activeTurnId,
    });
    expect(loop.goalRuntime.route(sessionKey)).toEqual({
      channel: "websocket",
      chatId,
      source: { kind: "gui", channel: "websocket" },
    });

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("does not treat a source-less WebSocket turn outside the Goal route as steerable", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:legacy-goal-route-mismatch";
    const goalChatId = "goal-route";
    const otherChatId = "other-route";
    const clientRequestId = "89898989-8989-4898-8898-898989898989";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "Keep steering on the Goal route",
      route: { channel: "websocket", chatId: goalChatId },
      turnId: "goal-route-create-turn",
    });
    loop.goalRuntime.releaseTurn(sessionKey, "goal-route-create-turn");
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (_message: InboundMessage, _key, options: any) => {
      options.slot.acceptingSteer = true;
      await activeGate;
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    const activeTurnId = "legacy-goal-route-mismatch-turn";
    expect(loop.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: otherChatId,
      content: "A different source-less WebSocket turn",
      metadata: { turn_id: activeTurnId },
      internal: {
        kind: "goal_continuation",
        goalId: goal.goalId,
        goalUpdatedAt: goal.updatedAt,
      },
      sessionKeyOverride: sessionKey,
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    await loop.goalRuntime.enqueueUserMessage(sessionKey, new InboundMessage({
      channel: "websocket",
      chatId: otherChatId,
      content: "Do not steer this into the Goal",
      metadata: {
        client_request_id: clientRequestId,
        webui_request_digest: "legacy-goal-route-mismatch-digest",
        webui_queue_surface: "chat_composer",
        webui: true,
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));

    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      activeTurnId,
    )).resolves.toMatchObject({ outcome: "not_steerable" });
    await expect(loop.removeQueuedWebuiMessage(sessionKey, clientRequestId))
      .resolves.toMatchObject({ outcome: "removed" });

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("leaves stale, cross-surface, and slash queue items untouched", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:queue-steer-reject";
    loop.sessions.getOrCreate(sessionKey);
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      if (message.content === "active") {
        options.slot.acceptingSteer = true;
        await activeGate;
      }
      options.slot.stopReason = "completed";
      return null;
    }) as any;
    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queue-steer-reject",
      content: "active",
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(() => (loop.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);
    const activeTurnId = (loop.turnSlots.get(sessionKey) as any[])[0].turnId as string;
    const clientRequestId = "99999999-9999-4999-8999-999999999999";
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "queue-steer-reject",
      content: "/definitely-not-a-command",
      metadata: {
        client_request_id: clientRequestId,
        webui_queue_surface: "chat_composer",
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" },
    }));
    await waitUntil(async () => (await loop.getQueueSnapshot(sessionKey)).items.length === 1);

    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      activeTurnId,
    )).resolves.toEqual({ outcome: "not_steerable", revision: 1 });
    await expect(loop.steerQueuedWebuiMessage(
      sessionKey,
      clientRequestId,
      "stale-turn",
    )).resolves.toEqual({ outcome: "not_steerable", revision: 1 });
    expect((await loop.getQueueSnapshot(sessionKey)).items).toEqual([
      expect.objectContaining({ clientRequestId, queueSurface: "chat_composer" }),
    ]);

    releaseActive();
    await waitUntil(() => !loop.isSessionBusy(sessionKey));
    loop.stop();
    await running;
  });

  it("restores an unpersisted slot transfer as an ordinary queued Turn after restart", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-turn-admission-restart-"));
    roots.push(workspace);
    const sessions = new SessionManager(path.join(workspace, "sessions"));
    const sessionKey = "websocket:queue-steer-restart";
    const clientRequestId = "34343434-3434-4434-8434-343434343434";
    const session = sessions.getOrCreate(sessionKey);
    session.metadata.webui_queue_steer_transfers = [{
      clientRequestId,
      expectedTurnId: "56565656-5656-4656-8656-565656565656",
      store: "slot",
      descriptor: {
        clientRequestId,
        content: "recover me",
        media: [],
        queuedAt: "2026-08-10T12:00:00.000Z",
        sessionKey,
        source: { kind: "gui", channel: "websocket" },
        queueSurface: "chat_composer",
      },
      messageFields: {
        channel: "websocket",
        chatId: "queue-steer-restart",
        senderId: "user",
        content: "recover me",
        media: [],
        metadata: {
          client_request_id: clientRequestId,
          webui_request_digest: "restart-digest",
          webui_queue_surface: "chat_composer",
          turn_source: { kind: "gui", channel: "websocket" },
        },
        timestamp: "2026-08-10T12:00:00.000Z",
        sessionKey,
        turnSource: { kind: "gui", channel: "websocket" },
      },
    }];
    sessions.save(session, { fsync: true });
    const loop = new AgentLoop({
      bus: new MessageBus(),
      config: new Config({ memmyMemory: { enabled: false } }),
      provider: {
        generation: { maxTokens: 256 },
        getDefaultModel: () => "test-model",
      },
      workspace,
      sessionManager: sessions,
      model: "test-model",
    });
    loop.initializeRuntimeTools = vi.fn(async () => undefined);
    const received: InboundMessage[] = [];
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      received.push(message);
      options.slot.stopReason = "completed";
      return null;
    }) as any;
    let releaseQueueAnnouncement!: () => void;
    const queueAnnouncement = new Promise<void>((resolve) => {
      releaseQueueAnnouncement = resolve;
    });
    const publishQueued = vi.spyOn(loop, "publishWebuiMessageQueued")
      .mockImplementation(async () => queueAnnouncement);

    const running = loop.run();
    await waitUntil(() => publishQueued.mock.calls.length === 1);
    expect(received).toHaveLength(0);
    releaseQueueAnnouncement();
    await waitUntil(() => received.length === 1);
    expect(received[0]).toMatchObject({
      content: "recover me",
      turnAdmission: "queue",
    });
    expect(received[0]?.metadata).toMatchObject({
      client_request_id: clientRequestId,
      webui_queue_surface: "chat_composer",
    });
    expect(received[0]?.metadata.webui_queue_steer_origin).toBeUndefined();
    loop.stop();
    await running;
  });

  it("keeps direct, Slot-backed, and deletion-barrier Sessions out of auto-compaction", () => {
    const loop = makeLoop();
    loop.pendingQueues.set("cli:direct", {} as any);
    loop.turnSlots.set("telegram:chat", [{} as any]);
    loop.sessionDeletionQueues.set("websocket:deleting", []);

    expect(new Set((loop as any).busySessionKeysForAutoCompact())).toEqual(new Set([
      "cli:direct",
      "telegram:chat",
      "websocket:deleting",
    ]));
  });
});
