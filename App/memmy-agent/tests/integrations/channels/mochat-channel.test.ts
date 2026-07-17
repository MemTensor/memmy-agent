import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { MochatChannel, MochatConfig } from "../../../src/integrations/channels/mochat.js";

const socketMocks = vi.hoisted(() => {
  const sockets: any[] = [];
  const io = vi.fn((url: string, options: Record<string, any>) => {
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const onceHandlers: Record<string, Array<(...args: any[]) => any>> = {};
    const socket: any = {
      url,
      options,
      acks: {} as Record<string, any>,
      emits: [] as any[],
      disconnected: false,
      on: vi.fn((event: string, callback: (...args: any[]) => any) => {
        (handlers[event] ??= []).push(callback);
        return socket;
      }),
      once: vi.fn((event: string, callback: (...args: any[]) => any) => {
        (onceHandlers[event] ??= []).push(callback);
        return socket;
      }),
      timeout: vi.fn(() => socket),
      emit: vi.fn((event: string, payload: any, callback?: (...args: any[]) => void) => {
        socket.emits.push([event, payload]);
        if (callback) callback(socket.acks[event] ?? { result: true });
        return socket;
      }),
      disconnect: vi.fn(() => {
        socket.disconnected = true;
      }),
      async trigger(event: string, ...args: any[]) {
        for (const callback of handlers[event] ?? []) await callback(...args);
        const once = onceHandlers[event] ?? [];
        delete onceHandlers[event];
        for (const callback of once) await callback(...args);
      },
    };
    sockets.push(socket);
    return socket;
  });
  return { io, sockets };
});

vi.mock("socket.io-client", () => ({ io: socketMocks.io }));

function channel(config: Record<string, any>, bus = new MessageBus()): MochatChannel {
  return new MochatChannel(new MochatConfig({
    clawToken: "claw-token",
    allowFrom: ["user-1"],
    refreshIntervalMs: 60_000,
    retryDelayMs: 60_000,
    socketConnectTimeoutMs: 1000,
    ...config,
  }), bus);
}

async function waitForSocket(): Promise<any> {
  for (let i = 0; i < 50; i += 1) {
    if (socketMocks.sockets[0]) return socketMocks.sockets[0];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("socket.io client was not created");
}

afterEach(() => {
  vi.useRealTimers();
  socketMocks.io.mockClear();
  socketMocks.sockets.splice(0);
});

describe("MochatChannel runtime", () => {
  it("connects Socket.IO, subscribes configured targets, and forwards session events", async () => {
    const bus = new MessageBus();
    const ch = channel({ sessions: ["session_1"], panels: ["panel_1"], socketUrl: "https://socket.example" }, bus);
    ch.socketFactory = socketMocks.io;

    const start = ch.start();
    const socket = await waitForSocket();
    socket.acks["com.claw.im.subscribeSessions"] = {
      result: true,
      data: { sessions: [{ sessionId: "session_1", cursor: 1, events: [] }] },
    };
    socket.acks["com.claw.im.subscribePanels"] = { result: true };
    await socket.trigger("connect");
    await start;

    expect(socketMocks.io).toHaveBeenCalledWith("https://socket.example", expect.objectContaining({
      path: "/socket.io",
      transports: ["websocket"],
      auth: { token: "claw-token" },
    }));
    expect(socket.emits[0]).toMatchObject(["com.claw.im.subscribeSessions", { sessionIds: ["session_1"], limit: 100 }]);
    expect(socket.emits[1]).toEqual(["com.claw.im.subscribePanels", { panelIds: ["panel_1"] }]);
    expect(ch.wsReady).toBe(true);

    await socket.trigger("claw.session.events", {
      sessionId: "session_1",
      cursor: 2,
      events: [
        {
          seq: 2,
          type: "message.add",
          timestamp: "2026-06-04T00:00:00.000Z",
          payload: { author: "user-1", messageId: "m1", content: "hello" },
        },
      ],
    });

    const inbound = await bus.nextInbound();
    expect(inbound.channel).toBe("mochat");
    expect(inbound.chatId).toBe("session_1");
    expect(inbound.senderId).toBe("user-1");
    expect(inbound.content).toBe("hello");

    await ch.stop();
  });

  it("starts session fallback watch workers when Socket.IO cannot connect", async () => {
    vi.useFakeTimers();
    const bus = new MessageBus();
    const ch = channel({ sessions: ["session_1"] }, bus);
    ch.http = {
      post: vi.fn(async (url: string) => {
        expect(url).toContain("/api/claw/sessions/watch");
        return {
          code: 200,
          data: {
            sessionId: "session_1",
            cursor: 2,
            events: [
              {
                seq: 2,
                type: "message.add",
                timestamp: "2026-06-04T00:00:00.000Z",
                payload: { author: "user-1", messageId: "m2", content: "fallback hello" },
              },
            ],
          },
        };
      }),
    };

    ch.startSocketClient = vi.fn(async () => false);
    await ch.start();
    ch.coldSessions.delete("session_1");

    expect(ch.fallbackMode).toBe(true);
    expect(ch.sessionFallbackWorkers.has("session_1")).toBe(true);
    await vi.runOnlyPendingTimersAsync();

    const inbound = await bus.nextInbound();
    expect(inbound.content).toBe("fallback hello");
    expect(ch.http.post).toHaveBeenCalledWith(expect.stringContaining("/api/claw/sessions/watch"), expect.objectContaining({
      json: expect.objectContaining({ sessionId: "session_1" }),
    }));

    await ch.stop();
  });

  it("refreshes auto-discovered sessions and panels before fallback worker startup", async () => {
    const ch = channel({ sessions: ["*"], panels: ["*"] });
    const post = vi.fn(async (url: string) => {
      if (url.includes("/api/claw/sessions/list")) {
        return { code: 200, data: { sessions: [{ sessionId: "session_2", converseId: "conv_2" }] } };
      }
      if (url.includes("/api/claw/groups/get")) {
        return { code: 200, data: { panels: [{ id: "panel_2", type: 0 }] } };
      }
      return { code: 200, data: {} };
    });
    ch.http = { post };
    ch.startSocketClient = vi.fn(async () => false);

    await ch.start();

    expect(ch.sessionSet.has("session_2")).toBe(true);
    expect(ch.panelSet.has("panel_2")).toBe(true);
    expect(ch.sessionByConverse.conv_2).toBe("session_2");
    expect(ch.sessionFallbackWorkers.has("session_2")).toBe(true);
    expect(ch.panelFallbackWorkers.has("panel_2")).toBe(true);

    await ch.stop();
  });
});
