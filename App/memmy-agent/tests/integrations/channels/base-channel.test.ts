import { describe, expect, it } from "vitest";
import { InboundMessage, MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { approveCode, clearStore, generateCode, PAIRING_CODE_META_KEY } from "../../../src/integrations/channel-auth/index.js";

class DummyChannel extends BaseChannel {
  name = "dummy";
  sent: OutboundMessage[] = [];

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class StreamingChannel extends DummyChannel {
  async sendDelta(): Promise<void> {}
}

class ReasoningChannel extends DummyChannel {
  reasoningDeltas: any[] = [];
  reasoningEnds: any[] = [];

  async sendReasoningDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    this.reasoningDeltas.push([chatId, delta, metadata]);
  }

  async sendReasoningEnd(chatId: string, metadata: Record<string, any> = {}): Promise<void> {
    this.reasoningEnds.push([chatId, metadata]);
  }
}

describe("BaseChannel permissions and inbound handling", () => {
  it("requires exact allowFrom matches and supports star plus pairing fallback", () => {
    clearStore();
    const channel = new DummyChannel({ allowFrom: ["allow@email.com"] }, new MessageBus());

    expect(channel.isAllowed("allow@email.com")).toBe(true);
    expect(channel.isAllowed("attacker|allow@email.com")).toBe(false);
    expect(new DummyChannel({ allowFrom: ["*"] }, new MessageBus()).isAllowed("anyone")).toBe(true);
    expect(new DummyChannel({ allowFrom: null }, new MessageBus()).isAllowed("alice")).toBe(false);

    const code = generateCode("dummy", "paired");
    approveCode(code);
    expect(new DummyChannel({ allowFrom: [] }, new MessageBus()).isAllowed("paired")).toBe(true);
  });

  it("supports object allowFrom aliases", () => {
    expect(new DummyChannel({ allowFrom: ["alice"] }, new MessageBus()).isAllowed("alice")).toBe(true);
  });

  it("denies empty object allowFrom lists", () => {
    expect(new DummyChannel({ allowFrom: [] }, new MessageBus()).isAllowed("alice")).toBe(false);
  });

  it("handles null allowFrom values", () => {
    expect(new DummyChannel({ allowFrom: null }, new MessageBus()).isAllowed("alice")).toBe(false);
    expect(new DummyChannel({ allowFrom: null }, new MessageBus()).isAllowed("alice")).toBe(false);
  });

  it("denies unknown senders when pairing fallback does not approve them", () => {
    clearStore();
    const code = generateCode("dummy", "paired");
    approveCode(code);
    const channel = new DummyChannel({ allowFrom: [] }, new MessageBus());

    expect(channel.isAllowed("paired")).toBe(true);
    expect(channel.isAllowed("unknown")).toBe(false);
  });

  it("sends pairing codes in DMs and ignores unapproved group messages", async () => {
    clearStore();
    const channel = new DummyChannel({ allowFrom: [] }, new MessageBus());

    await channel.handleMessage("stranger", "chat1", "hello", [], {}, null, true);
    expect(channel.sent).toHaveLength(1);
    const code = channel.sent[0].metadata[PAIRING_CODE_META_KEY];
    expect(code).toBeTruthy();
    expect(channel.sent[0].content).toContain(code);

    const group = new DummyChannel({ allowFrom: [] }, new MessageBus());
    await group.handleMessage("stranger", "chat1", "hello", [], {}, null, false);
    expect(group.sent).toEqual([]);
  });

  it("publishes allowed inbound messages and marks streaming-capable channels", async () => {
    const bus = new MessageBus();
    const channel = new StreamingChannel({ allowFrom: ["alice"], streaming: true }, bus);

    await channel.handleMessage("alice", "chat1", "hello", ["/tmp/a.png"], { x: 1 }, "custom:key");
    const msg: InboundMessage = await bus.consumeInbound();

    expect(msg.content).toBe("hello");
    expect(msg.media).toEqual(["/tmp/a.png"]);
    expect(msg.metadata).toMatchObject({ x: 1, wantsStream: true });
    expect(msg.sessionKey).toBe("custom:key");
  });

  it("one-shot reasoning expands to reasoning delta plus end without throwing", async () => {
    const channel = new ReasoningChannel({}, new MessageBus());

    await channel.sendReasoning(new OutboundMessage({ channel: "dummy", chatId: "c1", content: "thinking", metadata: {} }));

    expect(channel.reasoningDeltas[0][1]).toBe("thinking");
    expect(channel.reasoningEnds).toHaveLength(1);
  });
});
