import { describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";

class MockWebSocketChannel extends BaseChannel {
  override name = "websocket";
  override displayName = "WebSocket";
  sendMock = vi.fn(async (msg: OutboundMessage) => undefined);

  constructor(bus: MessageBus) {
    super({}, bus);
  }

  override async send(msg: OutboundMessage): Promise<void> {
    return this.sendMock(msg);
  }
}

async function dispatchOne(manager: ChannelManager, bus: MessageBus): Promise<void> {
  const msg = await bus.consumeOutbound();
  if (msg.metadata?.agentProgress) {
    if (msg.metadata?.toolHint && !manager.shouldSendProgress(msg.channel, { toolHint: true })) return;
    if (!msg.metadata?.toolHint && !manager.shouldSendProgress(msg.channel)) return;
  }
  if (msg.metadata?.retryWait && msg.channel !== "websocket") return;
  const channel = manager.channels[msg.channel];
  if (channel) await manager.sendWithRetry(channel, msg);
}

describe("ChannelManager retry wait routing", () => {
  it("allows retry_wait messages to reach the websocket channel", async () => {
    const bus = new MessageBus();
    const manager = new ChannelManager({ channels: { sendMaxRetries: 1 } }, bus);
    manager.channels = {};
    const channel = new MockWebSocketChannel(bus);
    manager.channels.websocket = channel;

    await bus.publishOutbound(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "Model request failed, retrying attempt 2 in 2s...",
      metadata: { retryWait: true, turn_id: "turn-1" },
    }));

    await dispatchOne(manager, bus);

    expect(channel.sendMock).toHaveBeenCalledOnce();
    const sent = channel.sendMock.mock.calls[0][0];
    expect(sent.content).toBe("Model request failed, retrying attempt 2 in 2s...");
    expect(sent.metadata).toMatchObject({ retryWait: true, turn_id: "turn-1" });
  });
});
