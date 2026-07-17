import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { OutboundMessage } from "../../../src/core/runtime-messages/events.js";
import { WebSocketChannel, publishRuntimeModelUpdate } from "../../../src/integrations/channels/websocket.js";
import { issueToken, issueTokenOk, WsMessage, WsTestClient } from "./ws-test-client.js";

const running: WebSocketChannel[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((channel) => channel.stop()));
});

async function startChannel(config: Record<string, any> = {}): Promise<{ bus: MessageBus; channel: WebSocketChannel; port: number }> {
  const bus = new MessageBus();
  const channel = new WebSocketChannel(
    { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false, ...config },
    bus,
  );
  running.push(channel);
  await channel.start();
  const address = (channel as any).server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  return { bus, channel, port: address.port };
}

async function withClient<T>(port: number, clientId: string, fn: (client: WsTestClient) => Promise<T>, path = "/", token = ""): Promise<T> {
  const client = new WsTestClient(`ws://127.0.0.1:${port}${path}`, { clientId, token });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function expectConnectRejected(port: number, path = "/", clientId = "bad", token = ""): Promise<void> {
  const client = new WsTestClient(`ws://127.0.0.1:${port}${path}`, { clientId, token });
  await expect(client.connect()).rejects.toThrow(/WebSocket connection/);
}

async function nextInbound(bus: MessageBus) {
  return await Promise.race([
    bus.nextInbound(),
    new Promise<never>((resolve, reject) => {
      void resolve;
      return setTimeout(() => reject(new Error("timed out waiting for inbound message")), 1000);
    }),
  ]);
}

describe("WebSocket integration", () => {
  it("publishes runtime model update events onto the websocket outbound channel", () => {
    const bus = new MessageBus();

    publishRuntimeModelUpdate(bus, "openai/gpt-4.1", "fast");
    const event = bus.outbound.getNowait();

    expect(event?.channel).toBe("websocket");
    expect(event?.chatId).toBe("*");
    expect(event?.content).toBe("");
    expect(event?.metadata).toEqual({
      runtimeModelUpdated: true,
      model: "openai/gpt-4.1",
      model_preset: "fast",
    });
  });

  it("broadcasts runtime model updates to attached websocket connections", async () => {
    const bus = new MessageBus();
    const channel = new WebSocketChannel({ enabled: true, allowFrom: ["*"] }, bus);
    const ws = { send: vi.fn(async (raw: string) => undefined) };
    channel.attachConnection(ws, "chat-1");

    publishRuntimeModelUpdate(bus, "openai/gpt-4.1", "fast");
    await channel.send(bus.outbound.getNowait()!);

    const payload = JSON.parse(ws.send.mock.calls[0][0]);
    expect(payload).toEqual({
      event: "runtime_model_updated",
      model_name: "openai/gpt-4.1",
      model_preset: "fast",
    });
  });

  it("wraps raw websocket client messages with runtime helper compatible accessors", () => {
    const msg = new WsMessage("message", {
      event: "message",
      text: "hello",
      chat_id: "chat-1",
      client_id: "client-1",
      media: ["a.png"],
      reply_to: "parent",
      stream_id: "stream-1",
    });

    expect(msg.text).toBe("hello");
    expect(msg.chatId).toBe("chat-1");
    expect(msg.clientId).toBe("client-1");
    expect(msg.media).toEqual(["a.png"]);
    expect(msg.replyTo).toBe("parent");
    expect(msg.streamId).toBe("stream-1");
  });

  it("sends ready event fields", async () => {
    const { port } = await startChannel();

    await withClient(port, "c1", async (client) => {
      const ready = await client.recvReady();
      expect(ready.event).toBe("ready");
      expect(ready.chatId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ready.clientId).toBe("c1");
    });
  });

  it("generates an anonymous client id when none is supplied", async () => {
    const { port } = await startChannel();
    const client = new WsTestClient(`ws://127.0.0.1:${port}/`, { clientId: "" });
    await client.connect();
    try {
      expect((await client.recvReady()).clientId).toMatch(/^anon-/);
    } finally {
      await client.close();
    }
  });

  it("assigns a unique chat id to each connection", async () => {
    const { port } = await startChannel();

    await withClient(port, "a", async (c1) => {
      await withClient(port, "b", async (c2) => {
        expect((await c1.recvReady()).chatId).not.toBe((await c2.recvReady()).chatId);
      });
    });
  });

  it("forwards inbound plain text to the bus", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "p", async (client) => {
      const ready = await client.recvReady();
      await client.sendText("hello world");
      const inbound = await nextInbound(bus);
      expect(inbound.channel).toBe("websocket");
      expect(inbound.senderId).toBe("p");
      expect(inbound.chatId).toBe(ready.chatId);
      expect(inbound.content).toBe("hello world");
    });
  });

  it("uses a JSON content field as inbound content", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "j", async (client) => {
      await client.recvReady();
      await client.sendJson({ content: "structured" });
      expect((await nextInbound(bus)).content).toBe("structured");
    });
  });

  it("uses JSON text and message fields as inbound content", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "x", async (client) => {
      await client.recvReady();
      await client.sendJson({ text: "via text" });
      expect((await nextInbound(bus)).content).toBe("via text");
      await client.sendJson({ message: "via message" });
      expect((await nextInbound(bus)).content).toBe("via message");
    });
  });

  it("ignores empty payloads", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "e", async (client) => {
      await client.recvReady();
      await client.sendText("   ");
      await client.sendJson({});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bus.inbound.size).toBe(0);
    });
  });

  it("preserves inbound message order", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "o", async (client) => {
      await client.recvReady();
      for (let i = 0; i < 5; i += 1) await client.sendText(`msg-${i}`);
      const received = [];
      for (let i = 0; i < 5; i += 1) received.push((await nextInbound(bus)).content);
      expect(received).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    });
  });

  it("sends outbound messages to the matching client", async () => {
    const { channel, port } = await startChannel();

    await withClient(port, "r", async (client) => {
      const ready = await client.recvReady();
      await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: "reply" }));
      expect((await client.recvMessage()).text).toBe("reply");
    });
  });

  it("tags tool hints and generic progress messages with a kind", async () => {
    const { channel, port } = await startChannel();

    await withClient(port, "h", async (client) => {
      const ready = await client.recvReady();
      await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: "hi" }));
      expect((await client.recvMessage()).raw.kind).toBeUndefined();

      await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: 'weather("get")', metadata: { agentProgress: true, toolHint: true } }));
      const hint = await client.recvMessage();
      expect(hint.raw.kind).toBe("tool_hint");
      expect(hint.text).toBe('weather("get")');

      await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: "thinking...", metadata: { agentProgress: true } }));
      expect((await client.recvMessage()).raw.kind).toBe("progress");
    });
  });

  it("sends outbound media and reply metadata", async () => {
    const { channel, port } = await startChannel();

    await withClient(port, "m", async (client) => {
      const ready = await client.recvReady();
      const outbound = new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: "img", media: ["/tmp/a.png"], replyTo: "m1" });
      await channel.send(outbound);
      const msg = await client.recvMessage();
      expect(msg.text).toBe("img");
      expect(msg.media).toEqual(["/tmp/a.png"]);
      expect(msg.replyTo).toBe("m1");
    });
  });

  it("streams deltas and a stream end event", async () => {
    const { channel, port } = await startChannel({ streaming: true });

    await withClient(port, "s", async (client) => {
      const chatId = (await client.recvReady()).chatId!;
      for (const part of ["Hello", " ", "world", "!"]) {
        await channel.sendDelta(chatId, part, { streamDelta: true, streamId: "s1" });
      }
      await channel.sendDelta(chatId, "", { streamEnd: true, streamId: "s1" });

      const messages = await client.collectStream();
      expect(messages.filter((msg) => msg.event === "delta").map((msg) => msg.text).join("")).toBe("Hello world!");
      expect(messages.filter((msg) => msg.event === "stream_end")).toHaveLength(1);
    });
  });

  it("keeps interleaved streams separated by stream id", async () => {
    const { channel, port } = await startChannel({ streaming: true });

    await withClient(port, "i", async (client) => {
      const chatId = (await client.recvReady()).chatId!;
      await channel.sendDelta(chatId, "A1", { streamDelta: true, streamId: "sa" });
      await channel.sendDelta(chatId, "B1", { streamDelta: true, streamId: "sb" });
      await channel.sendDelta(chatId, "A2", { streamDelta: true, streamId: "sa" });
      await channel.sendDelta(chatId, "", { streamEnd: true, streamId: "sa" });
      await channel.sendDelta(chatId, "B2", { streamDelta: true, streamId: "sb" });
      await channel.sendDelta(chatId, "", { streamEnd: true, streamId: "sb" });

      const messages = await client.recvN(6);
      expect(messages.filter((msg) => msg.event === "delta" && msg.streamId === "sa").map((msg) => msg.text).join("")).toBe("A1A2");
      expect(messages.filter((msg) => msg.event === "delta" && msg.streamId === "sb").map((msg) => msg.text).join("")).toBe("B1B2");
    });
  });

  it("keeps independent sessions isolated", async () => {
    const { channel, port } = await startChannel();

    await withClient(port, "u1", async (c1) => {
      await withClient(port, "u2", async (c2) => {
        const r1 = await c1.recvReady();
        const r2 = await c2.recvReady();
        await channel.send(new OutboundMessage({ channel: "websocket", chatId: r1.chatId!, content: "for-u1" }));
        expect((await c1.recvMessage()).text).toBe("for-u1");
        await channel.send(new OutboundMessage({ channel: "websocket", chatId: r2.chatId!, content: "for-u2" }));
        expect((await c2.recvMessage()).text).toBe("for-u2");
      });
    });
  });

  it("cleans up disconnected clients before sending to an orphaned chat", async () => {
    const { channel, port } = await startChannel();
    let chatId = "";

    await withClient(port, "tmp", async (client) => {
      chatId = (await client.recvReady()).chatId!;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await channel.send(new OutboundMessage({ channel: "websocket", chatId, content: "orphan" }));
    expect(channel.subscriptions.has(chatId)).toBe(false);
  });

  it("accepts a static websocket token", async () => {
    const { port } = await startChannel({ token: "secret" });

    await withClient(port, "a", async (client) => {
      expect((await client.recvReady()).clientId).toBe("a");
    }, "/", "secret");
  });

  it("rejects an invalid static websocket token", async () => {
    const { port } = await startChannel({ token: "correct" });
    await expectConnectRejected(port, "/", "b", "wrong");
  });

  it("supports token issue and one-time websocket token flow", async () => {
    const { port } = await startChannel({
      path: "/ws",
      tokenIssuePath: "/auth/token",
      tokenIssueSecret: "s",
      websocketRequiresToken: true,
    });

    const [, status] = await issueToken("127.0.0.1", port, "/auth/token");
    expect(status).toBe(401);
    const token = await issueTokenOk("127.0.0.1", port, "/auth/token", "s");

    await expectConnectRejected(port, "/ws", "x");
    await withClient(port, "ok", async (client) => {
      expect((await client.recvReady()).clientId).toBe("ok");
    }, "/ws", token);
    await expectConnectRejected(port, "/ws", "r", token);
  });

  it("accepts a configured websocket path", async () => {
    const { port } = await startChannel({ path: "/my-chat" });

    await withClient(port, "p", async (client) => {
      expect((await client.recvReady()).event).toBe("ready");
    }, "/my-chat");
  });

  it("rejects the wrong websocket path", async () => {
    const { port } = await startChannel({ path: "/ws" });
    await expectConnectRejected(port, "/wrong", "x");
  });

  it("normalizes a trailing slash on the websocket path", async () => {
    const { port } = await startChannel({ path: "/ws" });

    await withClient(port, "s", async (client) => {
      expect((await client.recvReady()).event).toBe("ready");
    }, "/ws/");
  });

  it("handles large inbound messages", async () => {
    const { bus, port } = await startChannel();
    const big = "x".repeat(100_000);

    await withClient(port, "big", async (client) => {
      await client.recvReady();
      await client.sendText(big);
      expect((await nextInbound(bus)).content).toBe(big);
    });
  });

  it("round-trips unicode text", async () => {
    const { bus, channel, port } = await startChannel();
    const text = "\u4f60\u597d\u4e16\u754c \ud83c\udf0d \u65e5\u672c\u8a9e\u30c6\u30b9\u30c8";

    await withClient(port, "u", async (client) => {
      const ready = await client.recvReady();
      await client.sendText(text);
      expect((await nextInbound(bus)).content).toBe(text);
      await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: text }));
      expect((await client.recvMessage()).text).toBe(text);
    });
  });

  it("handles rapid-fire inbound and outbound messages", async () => {
    const { bus, channel, port } = await startChannel();

    await withClient(port, "r", async (client) => {
      const ready = await client.recvReady();
      for (let i = 0; i < 50; i += 1) await client.sendText(`in-${i}`);
      const inbound = [];
      for (let i = 0; i < 50; i += 1) inbound.push((await nextInbound(bus)).content);
      expect(inbound).toEqual([...Array(50).keys()].map((i) => `in-${i}`));

      for (let i = 0; i < 50; i += 1) {
        await channel.send(new OutboundMessage({ channel: "websocket", chatId: ready.chatId!, content: `out-${i}` }));
      }
      const received = [];
      for (let i = 0; i < 50; i += 1) received.push((await client.recvMessage()).text);
      expect(received).toEqual([...Array(50).keys()].map((i) => `out-${i}`));
    });
  });

  it("treats invalid JSON as plain text", async () => {
    const { bus, port } = await startChannel();

    await withClient(port, "j", async (client) => {
      await client.recvReady();
      await client.sendText("{broken json");
      expect((await nextInbound(bus)).content).toBe("{broken json");
    });
  });
});
