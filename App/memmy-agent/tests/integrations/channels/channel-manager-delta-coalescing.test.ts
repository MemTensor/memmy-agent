import { describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import { Config } from "../../../src/config/schema.js";

class MockChannel extends BaseChannel {
  override name = "mock";
  override displayName = "Mock";
  sendMock = vi.fn(async (msg: OutboundMessage) => undefined);
  sendDeltaMock = vi.fn(async (chatId: string, delta: string, metadata: Record<string, any>) => undefined);

  constructor(bus: MessageBus) {
    super({}, bus);
  }

  override async send(msg: OutboundMessage): Promise<void> {
    return this.sendMock(msg);
  }

  override async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    return this.sendDeltaMock(chatId, delta, metadata);
  }
}

function makeManager(): { bus: MessageBus; manager: ChannelManager; channel: MockChannel } {
  const bus = new MessageBus();
  const manager = new ChannelManager(new Config(), bus);
  manager.channels = {};
  const channel = new MockChannel(bus);
  manager.channels.mock = channel;
  return { bus, manager, channel };
}

async function publish(bus: MessageBus, init: { chatId?: string; content: string; metadata?: Record<string, any> }): Promise<void> {
  await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: init.chatId ?? "chat1", content: init.content, metadata: init.metadata ?? {} }));
}

async function dispatchOne(manager: ChannelManager, bus: MessageBus, pending: OutboundMessage[] = []): Promise<void> {
  let msg = pending.length ? pending.shift()! : await bus.consumeOutbound();
  if (msg.metadata.agentProgress) {
    if (msg.metadata.toolHint && !manager.shouldSendProgress(msg.channel, { toolHint: true })) return;
    if (!msg.metadata.toolHint && !manager.shouldSendProgress(msg.channel, { toolHint: false })) return;
  }
  if (msg.metadata.retryWait && msg.channel !== "websocket") return;
  if (msg.metadata.streamDelta && !msg.metadata.streamEnd) {
    const [merged, extra] = manager.coalesceStreamDeltas(msg);
    msg = merged;
    pending.push(...extra);
  }
  const channel = manager.channels[msg.channel];
  if (channel) await manager.sendWithRetry(channel, msg);
}

describe("ChannelManager delta coalescing", () => {
  it("sends a single delta as-is", async () => {
    const { bus, manager, channel } = makeManager();
    await publish(bus, { content: "Hello", metadata: { streamDelta: true } });

    await dispatchOne(manager, bus);

    expect(channel.sendDeltaMock).toHaveBeenCalledOnce();
    expect(channel.sendDeltaMock).toHaveBeenCalledWith("chat1", "Hello", { streamDelta: true });
  });

  it("coalesces multiple consecutive deltas for the same chat", async () => {
    const { bus, manager } = makeManager();
    for (const text of ["Hello", " ", "world", "!"]) await publish(bus, { content: text, metadata: { streamDelta: true } });

    const first = await bus.consumeOutbound();
    const [merged, pending] = manager.coalesceStreamDeltas(first);

    expect(merged.content).toBe("Hello world!");
    expect(merged.metadata.streamDelta).toBe(true);
    expect(pending).toEqual([]);
  });

  it("does not coalesce deltas for different chats", async () => {
    const { bus, manager } = makeManager();
    await publish(bus, { chatId: "chat1", content: "Hello", metadata: { streamDelta: true } });
    await publish(bus, { chatId: "chat2", content: "World", metadata: { streamDelta: true } });

    const [merged, pending] = manager.coalesceStreamDeltas(await bus.consumeOutbound());

    expect(merged.content).toBe("Hello");
    expect(merged.chatId).toBe("chat1");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ chatId: "chat2", content: "World" });
  });

  it("includes stream_end metadata when the ending delta is coalesced", async () => {
    const { bus, manager } = makeManager();
    await publish(bus, { content: "Hello", metadata: { streamDelta: true } });
    await publish(bus, { content: " world", metadata: { streamDelta: true, streamEnd: true } });

    const [merged, pending] = manager.coalesceStreamDeltas(await bus.consumeOutbound());

    expect(merged.content).toBe("Hello world");
    expect(merged.metadata.streamEnd).toBe(true);
    expect(pending).toEqual([]);
  });

  it("stops coalescing at the first non-matching boundary", async () => {
    const { bus, manager } = makeManager();
    await publish(bus, { content: "Hello", metadata: { streamDelta: true, streamId: "seg-1" } });
    await publish(bus, { content: "", metadata: { streamEnd: true, streamId: "seg-1" } });
    await publish(bus, { content: "world", metadata: { streamDelta: true, streamId: "seg-2" } });

    const [merged, pending] = manager.coalesceStreamDeltas(await bus.consumeOutbound());

    expect(merged.content).toBe("Hello");
    expect(merged.metadata.streamEnd).toBeUndefined();
    expect(pending).toHaveLength(1);
    expect(pending[0].metadata.streamEnd).toBe(true);
    expect(pending[0].metadata.streamId).toBe("seg-1");
    expect((await bus.consumeOutbound()).metadata.streamId).toBe("seg-2");
  });

  it("preserves non-delta messages in the pending list", async () => {
    const { bus, manager } = makeManager();
    await publish(bus, { content: "Delta", metadata: { streamDelta: true } });
    await publish(bus, { content: "Final message", metadata: {} });

    const [merged, pending] = manager.coalesceStreamDeltas(await bus.consumeOutbound());

    expect(merged.content).toBe("Delta");
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("Final message");
    expect(pending[0].metadata.streamDelta).toBeUndefined();
  });

  it("stops coalescing when the queue is empty", async () => {
    const { bus, manager } = makeManager();
    await publish(bus, { content: "Only message", metadata: { streamDelta: true } });

    const [merged, pending] = manager.coalesceStreamDeltas(await bus.consumeOutbound());

    expect(merged.content).toBe("Only message");
    expect(pending).toEqual([]);
  });

  it("dispatch coalesces deltas and leaves pending regular messages", async () => {
    const { bus, manager, channel } = makeManager();
    const pending: OutboundMessage[] = [];
    await publish(bus, { content: "A", metadata: { streamDelta: true } });
    await publish(bus, { content: "B", metadata: { streamDelta: true } });
    await publish(bus, { content: "Final", metadata: {} });

    await dispatchOne(manager, bus, pending);

    expect(channel.sendDeltaMock).toHaveBeenCalledWith("chat1", "AB", { streamDelta: true });
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("Final");
  });

  it("progress visibility uses global defaults", () => {
    const { manager } = makeManager();

    expect(manager.shouldSendProgress("mock", { toolHint: false })).toBe(true);
    expect(manager.shouldSendProgress("mock", { toolHint: true })).toBe(false);
  });

  it("progress visibility uses channel overrides", () => {
    const { manager, channel } = makeManager();
    channel.sendProgress = false;
    channel.sendToolHints = true;

    expect(manager.shouldSendProgress("mock", { toolHint: false })).toBe(false);
    expect(manager.shouldSendProgress("mock", { toolHint: true })).toBe(true);
  });

  it("progress visibility returns false for missing channels", () => {
    const { manager } = makeManager();

    expect(manager.shouldSendProgress("nonexistent", { toolHint: false })).toBe(false);
    expect(manager.shouldSendProgress("nonexistent", { toolHint: true })).toBe(false);
  });

  it("resolveBoolOverride handles camelCase object sections", () => {
    const { manager } = makeManager();

    expect(manager.resolveBoolOverride({}, "sendProgress", true)).toBe(true);
    expect(manager.resolveBoolOverride({ sendProgress: false }, "sendProgress", true)).toBe(false);
    expect(manager.resolveBoolOverride({ sendProgress: "false" }, "sendProgress", true)).toBe(true);
  });

  it("resolveBoolOverride handles model-like objects", () => {
    const { manager } = makeManager();
    class FakeSection {
      sendProgress = false;
      sendToolHints = true;
    }

    expect(manager.resolveBoolOverride(new FakeSection(), "sendProgress", true)).toBe(false);
    expect(manager.resolveBoolOverride(new FakeSection(), "sendToolHints", false)).toBe(true);
    expect(manager.resolveBoolOverride(new FakeSection(), "unknownKey", true)).toBe(true);
  });

  it("channel overrides can drop progress messages", async () => {
    const { bus, manager, channel } = makeManager();
    channel.sendProgress = false;
    await publish(bus, { content: "thinking", metadata: { agentProgress: true } });
    await publish(bus, { content: "final answer", metadata: {} });

    await dispatchOne(manager, bus);
    await dispatchOne(manager, bus);

    expect(channel.sendMock).toHaveBeenCalledOnce();
    expect(channel.sendMock.mock.calls[0][0].content).toBe("final answer");
  });

  it("channel overrides can enable tool hints", async () => {
    const { bus, manager, channel } = makeManager();
    channel.sendToolHints = true;
    await publish(bus, { content: "read_file(foo.ts)", metadata: { agentProgress: true, toolHint: true } });

    await dispatchOne(manager, bus);

    expect(channel.sendMock).toHaveBeenCalledOnce();
    expect(channel.sendMock.mock.calls[0][0].content).toBe("read_file(foo.ts)");
  });

  it("drops retry_wait messages for non-websocket channels", async () => {
    const { bus, manager, channel } = makeManager();
    await publish(bus, { content: "Model request failed, retry in 1s (attempt 1).", metadata: { retryWait: true } });
    await publish(bus, { content: "final answer", metadata: {} });

    await dispatchOne(manager, bus);
    await dispatchOne(manager, bus);

    expect(channel.sendMock).toHaveBeenCalledOnce();
    const sent = channel.sendMock.mock.calls[0][0];
    expect(sent.content).toBe("final answer");
    expect(sent.metadata.retryWait).toBeUndefined();
  });
});
