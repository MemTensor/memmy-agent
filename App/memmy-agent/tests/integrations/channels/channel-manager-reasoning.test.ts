import { describe, expect, it } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";

class MockChannel extends BaseChannel {
  name = "mock";
  sent: OutboundMessage[] = [];
  deltas: any[] = [];
  reasoningDeltas: any[] = [];
  reasoningEnds: any[] = [];

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    this.deltas.push([chatId, delta, metadata]);
  }
  async sendReasoningDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    this.reasoningDeltas.push([chatId, delta, metadata]);
  }
  async sendReasoningEnd(chatId: string, metadata: Record<string, any> = {}): Promise<void> {
    this.reasoningEnds.push([chatId, metadata]);
  }
}

async function pumpUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ChannelManager reasoning and dispatch routing", () => {
  it("routes stream, reasoning, and regular frames through their channel primitives", async () => {
    const channel = new MockChannel({}, new MessageBus());

    await ChannelManager.sendOnce(channel, new OutboundMessage({ channel: "mock", chatId: "c", content: "delta", metadata: { streamDelta: true } }));
    await ChannelManager.sendOnce(channel, new OutboundMessage({ channel: "mock", chatId: "c", content: "why", metadata: { reasoningDelta: true } }));
    await ChannelManager.sendOnce(channel, new OutboundMessage({ channel: "mock", chatId: "c", content: "final", metadata: {} }));

    expect(channel.deltas[0][1]).toBe("delta");
    expect(channel.reasoningDeltas[0][1]).toBe("why");
    expect(channel.sent[0].content).toBe("final");
  });

  it("filters progress, retry-wait, and duplicate origin replies during dispatch", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager({ channels: { sendProgress: true, sendToolHints: false, sendMaxRetries: 1 } }, bus);
    const channel = new MockChannel({}, bus);
    manager.channels.mock = channel;
    channel.sendProgress = false;

    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "thinking", metadata: { agentProgress: true } }));
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "retry", metadata: { retryWait: true } }));
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "same text", metadata: { originMessageId: "m1" } }));
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: " same   text ", metadata: { originMessageId: "m1" } }));

    const task = manager.dispatchOutbound();
    await pumpUntil(() => channel.sent.length === 1);

    expect(channel.sent.map((msg) => msg.content)).toEqual(["same text"]);
    void task;
  });

  it("routes reasoning only when the channel opts in", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager(bus);
    const channel = new MockChannel({}, bus);
    manager.channels.mock = channel;
    channel.showReasoning = false;

    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "hidden", metadata: { reasoningDelta: true } }));
    const task = manager.dispatchOutbound();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.reasoningDeltas).toEqual([]);

    channel.showReasoning = true;
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "shown", metadata: { reasoningDelta: true } }));
    await pumpUntil(() => channel.reasoningDeltas.length === 1);
    expect(channel.reasoningDeltas[0][1]).toBe("shown");
    void task;
  });

  it("routes reasoning end frames through the reasoning end primitive", async () => {
    const channel = new MockChannel({}, new MessageBus());

    await ChannelManager.sendOnce(channel, new OutboundMessage({
      channel: "mock",
      chatId: "c1",
      content: "",
      metadata: { agentProgress: true, reasoningEnd: true, streamId: "r1" },
    }));

    expect(channel.reasoningEnds).toHaveLength(1);
    expect(channel.reasoningEnds[0][0]).toBe("c1");
    expect(channel.reasoningDeltas).toEqual([]);
    expect(channel.sent).toEqual([]);
  });

  it("expands legacy one-shot reasoning into a delta plus end pair", async () => {
    const channel = new MockChannel({}, new MessageBus());

    await ChannelManager.sendOnce(channel, new OutboundMessage({
      channel: "mock",
      chatId: "c1",
      content: "one-shot reasoning",
      metadata: { agentProgress: true, reasoning: true },
    }));

    expect(channel.reasoningDeltas.map(([, delta]) => delta)).toEqual(["one-shot reasoning"]);
    expect(channel.reasoningEnds).toHaveLength(1);
  });

  it("dispatches reasoning delta and end frames when the channel opts in", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager(bus);
    const channel = new MockChannel({}, bus);
    manager.channels.mock = channel;
    channel.showReasoning = true;

    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "first ", metadata: { agentProgress: true, reasoningDelta: true, streamId: "r1" } }));
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "second", metadata: { agentProgress: true, reasoningDelta: true, streamId: "r1" } }));
    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "", metadata: { agentProgress: true, reasoningEnd: true, streamId: "r1" } }));

    const task = manager.dispatchOutbound();
    await pumpUntil(() => channel.reasoningDeltas.length === 2 && channel.reasoningEnds.length === 1);

    expect(channel.reasoningDeltas.map(([, delta]) => delta)).toEqual(["first ", "second"]);
    expect(channel.reasoningEnds).toHaveLength(1);
    void task;
  });

  it("drops reasoning for unknown channels without touching registered channels", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager(bus);
    const channel = new MockChannel({}, bus);
    manager.channels.mock = channel;

    await bus.publishOutbound(new OutboundMessage({ channel: "ghost", chatId: "c1", content: "nobody home", metadata: { agentProgress: true, reasoningDelta: true } }));
    const task = manager.dispatchOutbound();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(channel.reasoningDeltas).toEqual([]);
    expect(channel.sent).toEqual([]);
    void task;
  });

  it("keeps BaseChannel reasoning primitives no-op safe", async () => {
    const channel = new BaseChannel({}, new MessageBus());

    await expect(channel.sendReasoningDelta("c", "x")).resolves.toBeUndefined();
    await expect(channel.sendReasoningEnd("c")).resolves.toBeUndefined();
    await expect(channel.sendReasoning(new OutboundMessage({ channel: "base", chatId: "c", content: "x", metadata: {} }))).resolves.toBeUndefined();
  });

  it("routes reasoning independently of sendProgress", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager(bus);
    const channel = new MockChannel({}, bus);
    manager.channels.mock = channel;
    channel.sendProgress = false;
    channel.showReasoning = true;

    await bus.publishOutbound(new OutboundMessage({ channel: "mock", chatId: "c1", content: "still surfaces", metadata: { agentProgress: true, reasoningDelta: true } }));
    const task = manager.dispatchOutbound();
    await pumpUntil(() => channel.reasoningDeltas.length === 1);

    expect(channel.reasoningDeltas[0][1]).toBe("still surfaces");
    void task;
  });

  it("resolves progress settings and exposes status", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new MockChannel({}, manager.bus);
    manager.register(channel);

    expect(manager.shouldSendProgress("mock", { toolHint: false })).toBe(true);
    expect(manager.shouldSendProgress("mock", { toolHint: true })).toBe(false);
    expect(manager.resolveBoolOverride({ sendProgress: false }, "sendProgress", true)).toBe(false);
    expect(manager.getStatus()).toEqual({ mock: { enabled: true, running: false, lastError: null } });
    expect(manager.enabledChannels).toEqual(["mock"]);
  });
});
