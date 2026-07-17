import { describe, expect, it } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { QQChannel, QQConfig } from "../../../src/integrations/channels/qq.js";

class FakeApi {
  c2cCalls: Record<string, any>[] = [];
  groupCalls: Record<string, any>[] = [];

  async postC2cMessage(payload: Record<string, any>): Promise<void> {
    this.c2cCalls.push(payload);
  }

  async postGroupMessage(payload: Record<string, any>): Promise<void> {
    this.groupCalls.push(payload);
  }
}

class FakeClient {
  api = new FakeApi();
}

describe("QQ ack messages", () => {
  it("publishes allowed inbound messages through the base channel path", async () => {
    const bus = new MessageBus();
    const channel = new QQChannel({ allowFrom: ["u1"] }, bus);

    await channel.handleMessage("u1", "chat", "hello", [], { messageId: "m1" });
    const inbound = await bus.consumeInbound();

    expect(inbound.channel).toBe("qq");
    expect(inbound.metadata.messageId).toBe("m1");
  });

  it("sends ack immediately for C2C messages and continues processing", async () => {
    const bus = new MessageBus();
    const channel = new QQChannel(new QQConfig({
      appId: "app",
      secret: "secret",
      allowFrom: ["*"],
      ackMessage: "Processing...",
    }), bus);
    channel.client = new FakeClient();

    await channel.onMessage({
      id: "msg1",
      content: "hello",
      author: { user_openid: "user1" },
      attachments: [],
    }, false);

    expect(channel.client.api.c2cCalls[0]).toMatchObject({
      content: "Processing...",
      openid: "user1",
      msg_id: "msg1",
      msg_type: 0,
    });
    const inbound = await bus.consumeInbound();
    expect(inbound.content).toBe("hello");
    expect(inbound.senderId).toBe("user1");
  });

  it("sends ack immediately for group messages and continues processing", async () => {
    const bus = new MessageBus();
    const channel = new QQChannel(new QQConfig({
      appId: "app",
      secret: "secret",
      allowFrom: ["*"],
      ackMessage: "Processing...",
    }), bus);
    channel.client = new FakeClient();

    await channel.onMessage({
      id: "msg2",
      content: "hello group",
      group_openid: "group123",
      author: { member_openid: "user1" },
      attachments: [],
    }, true);

    expect(channel.client.api.groupCalls[0]).toMatchObject({
      content: "Processing...",
      group_openid: "group123",
      msg_id: "msg2",
      msg_type: 0,
    });
    const inbound = await bus.consumeInbound();
    expect(inbound.content).toBe("hello group");
    expect(inbound.chatId).toBe("group123");
  });

  it("does not send ack when ackMessage is empty", async () => {
    const bus = new MessageBus();
    const channel = new QQChannel(new QQConfig({
      appId: "app",
      secret: "secret",
      allowFrom: ["*"],
      ackMessage: "",
    }), bus);
    channel.client = new FakeClient();

    await channel.onMessage({
      id: "msg3",
      content: "hello",
      author: { user_openid: "user1" },
      attachments: [],
    }, false);

    expect(channel.client.api.c2cCalls).toEqual([]);
    expect(channel.client.api.groupCalls).toEqual([]);
    const inbound = await bus.consumeInbound();
    expect(inbound.content).toBe("hello");
  });

  it("sends custom ack text", async () => {
    const custom = "正在处理中，请稍候...";
    const bus = new MessageBus();
    const channel = new QQChannel(new QQConfig({
      appId: "app",
      secret: "secret",
      allowFrom: ["*"],
      ackMessage: custom,
    }), bus);
    channel.client = new FakeClient();

    await channel.onMessage({
      id: "msg4",
      content: "test input",
      author: { user_openid: "user1" },
      attachments: [],
    }, false);

    expect(channel.client.api.c2cCalls[0].content).toBe(custom);
    const inbound = await bus.consumeInbound();
    expect(inbound.content).toBe("test input");
  });
});
