import { describe, expect, it } from "vitest";
import { AsyncQueue, InboundMessage, MessageBus, OutboundMessage } from "../../src/core/runtime-messages/index.js";

describe("bus event models", () => {
  it("normalizes outbound reply targets to replyTo", () => {
    const camel = new OutboundMessage({ channel: "websocket", chatId: "c1", content: "hello", replyTo: "m1" });
    const snake = new OutboundMessage({ channel: "websocket", chatId: "c1", content: "hello", reply_to: "m2" });

    expect(camel.replyTo).toBe("m1");
    expect(snake.replyTo).toBe("m2");
  });

  it("computes inbound sessionKey from the latest override", () => {
    const msg = new InboundMessage({ channel: "telegram", chatId: "c1", content: "hello" });

    expect(msg.sessionKey).toBe("telegram:c1");

    msg.sessionKeyOverride = "telegram:c1:thread";
    expect(msg.sessionKey).toBe("telegram:c1:thread");

    msg.sessionKey = "explicit:key";
    expect(msg.sessionKey).toBe("telegram:c1:thread");

    msg.sessionKeyOverride = null;
    expect(msg.sessionKey).toBe("explicit:key");
  });

  it("keeps sessionKey enumerable for object spread and JSON serialization", () => {
    const msg = new InboundMessage({ channel: "telegram", chatId: "c1", content: "hello", sessionKeyOverride: "thread:key" });

    expect({ ...msg }).toMatchObject({ sessionKey: "thread:key" });
    expect(JSON.parse(JSON.stringify(msg))).toMatchObject({ sessionKey: "thread:key" });
    expect(JSON.parse(JSON.stringify(msg))).not.toHaveProperty("explicitSessionKey");
  });

  it("records inbound arrival timestamps and accepts explicit timestamp values", () => {
    const before = Date.now();
    const generated = new InboundMessage({ channel: "websocket", chatId: "c1", content: "hello" });
    const after = Date.now();
    const explicit = new InboundMessage({
      channel: "websocket",
      chatId: "c1",
      content: "hello",
      timestamp: "2026-06-04T01:02:03.000Z",
    });

    expect(generated.timestamp).toBeInstanceOf(Date);
    expect(generated.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(generated.timestamp.getTime()).toBeLessThanOrEqual(after);
    expect(explicit.timestamp.toISOString()).toBe("2026-06-04T01:02:03.000Z");
  });
});

describe("AsyncQueue", () => {
  it("removes aborted waiters so later messages are not consumed by abandoned gets", async () => {
    const queue = new AsyncQueue<string>();
    const controller = new AbortController();
    const abandoned = expect(queue.get(controller.signal)).rejects.toThrow("cancelled");
    const active = queue.get();

    controller.abort(new Error("cancelled"));
    await abandoned;

    queue.put("next");

    await expect(active).resolves.toBe("next");
  });

  it("returns undefined as a valid queued item from get", async () => {
    const queue = new AsyncQueue<undefined>();

    queue.put(undefined);

    await expect(queue.get()).resolves.toBeUndefined();
  });
});

describe("MessageBus", () => {
  it("passes cancellation signals through inbound consumers", async () => {
    const bus = new MessageBus();
    const controller = new AbortController();
    const abandoned = expect(bus.nextInbound(controller.signal)).rejects.toThrow("cancelled");
    const active = bus.nextInbound();

    controller.abort(new Error("cancelled"));
    await abandoned;

    const msg = new InboundMessage({ channel: "websocket", chatId: "c1", content: "hello" });
    await bus.publishInbound(msg);

    await expect(active).resolves.toBe(msg);
  });
});
