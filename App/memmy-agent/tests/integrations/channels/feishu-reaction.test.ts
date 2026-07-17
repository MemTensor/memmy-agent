import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { FeishuChannel, FeishuConfig, FeishuStreamBuffer } from "../../../src/integrations/channels/feishu.js";

function reactionResponse(reactionId = "reaction_001", success = true): any {
  return {
    success: () => success,
    code: success ? 0 : 99999,
    msg: success ? "ok" : "error",
    data: success ? { reaction_id: reactionId } : null,
  };
}

function okResponse(): any {
  return { success: () => true, code: 0, data: {} };
}

function makeClient() {
  return {
    im: {
      v1: {
        message_reaction: {
          create: vi.fn(() => reactionResponse()),
          delete: vi.fn(() => okResponse()),
        },
      },
    },
    cardkit: {
      v1: {
        card_element: { content: vi.fn(() => okResponse()) },
        card: { settings: vi.fn(() => okResponse()) },
      },
    },
  };
}

function makeChannel(): FeishuChannel {
  const channel = new FeishuChannel(
    new FeishuConfig({
      enabled: true,
      appId: "cli_test",
      appSecret: "secret",
      allowFrom: ["*"],
    }),
    new MessageBus(),
  );
  channel.client = makeClient();
  channel.loop = null;
  return channel;
}

describe("Feishu reaction add sync", () => {
  it("returns reaction id on success", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.create = vi.fn(() => reactionResponse("rx_42"));

    expect(channel.addReactionSync("om_001", "THUMBSUP")).toBe("rx_42");
  });

  it("returns null when the add response fails", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.create = vi.fn(() => reactionResponse("rx_42", false));

    expect(channel.addReactionSync("om_001", "THUMBSUP")).toBeNull();
  });

  it("returns null when the add response has no data", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.create = vi.fn(() => ({ success: () => true, code: 0, data: null }));

    expect(channel.addReactionSync("om_001", "THUMBSUP")).toBeNull();
  });

  it("returns null when add reaction throws", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.create = vi.fn(() => {
      throw new Error("network error");
    });

    expect(channel.addReactionSync("om_001", "THUMBSUP")).toBeNull();
  });
});

describe("Feishu reaction add async", () => {
  it("returns reaction id from the sync helper", async () => {
    const channel = makeChannel();
    channel.addReactionSync = vi.fn(() => "rx_99");

    await expect(channel.addReaction("om_001", "EYES")).resolves.toBe("rx_99");
  });

  it("returns null when there is no client", async () => {
    const channel = makeChannel();
    channel.client = null;

    await expect(channel.addReaction("om_001", "THUMBSUP")).resolves.toBeNull();
  });
});

describe("Feishu reaction remove sync", () => {
  it("calls delete on successful removal", () => {
    const channel = makeChannel();

    channel.removeReactionSync("om_001", "rx_42");

    expect(channel.client.im.v1.message_reaction.delete).toHaveBeenCalledWith({ messageId: "om_001", reactionId: "rx_42" });
  });

  it("handles failed delete responses gracefully", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.delete = vi.fn(() => ({ success: () => false, code: 99999, msg: "not found" }));

    expect(() => channel.removeReactionSync("om_001", "rx_42")).not.toThrow();
    expect(channel.client.im.v1.message_reaction.delete).toHaveBeenCalledTimes(1);
  });

  it("handles delete exceptions gracefully", () => {
    const channel = makeChannel();
    channel.client.im.v1.message_reaction.delete = vi.fn(() => {
      throw new Error("network error");
    });

    expect(() => channel.removeReactionSync("om_001", "rx_42")).not.toThrow();
  });
});

describe("Feishu reaction remove async", () => {
  it("calls the sync remove helper", async () => {
    const channel = makeChannel();
    channel.removeReactionSync = vi.fn();

    await channel.removeReaction("om_001", "rx_42");

    expect(channel.removeReactionSync).toHaveBeenCalledWith("om_001", "rx_42");
  });

  it("does nothing without a client", async () => {
    const channel = makeChannel();
    channel.client = null;
    channel.removeReactionSync = vi.fn();

    await channel.removeReaction("om_001", "rx_42");

    expect(channel.removeReactionSync).not.toHaveBeenCalled();
  });

  it("does nothing with an empty reaction id", async () => {
    const channel = makeChannel();
    channel.removeReactionSync = vi.fn();

    await channel.removeReaction("om_001", "");

    expect(channel.removeReactionSync).not.toHaveBeenCalled();
  });

  it("does nothing with a null reaction id", async () => {
    const channel = makeChannel();
    channel.removeReactionSync = vi.fn();

    await channel.removeReaction("om_001", null);

    expect(channel.removeReactionSync).not.toHaveBeenCalled();
  });
});

describe("Feishu stream-end reaction cleanup", () => {
  it("scopes stream buffers by message id", async () => {
    const channel = makeChannel();
    channel.createStreamingCardSync = vi.fn(() => null);

    await channel.sendDelta("oc_chat1", "first", { message_id: "om_first" });
    await channel.sendDelta("oc_chat1", "second", { message_id: "om_second" });

    expect(channel.streamBuffers.om_first.text).toBe("first");
    expect(channel.streamBuffers.om_second.text).toBe("second");
    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
  });

  it("removes tracked reactions on final stream end", async () => {
    const channel = makeChannel();
    channel.streamBuffers.om_001 = new FeishuStreamBuffer({ text: "Done", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.reactionIds.om_001 = "rx_42";
    channel.removeReaction = vi.fn(async () => undefined);

    await channel.sendDelta("oc_chat1", "", { streamEnd: true, message_id: "om_001" });

    expect(channel.removeReaction).toHaveBeenCalledWith("om_001", "rx_42");
    expect(channel.reactionIds.om_001).toBeUndefined();
  });

  it("does not remove reactions when message id is missing", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = new FeishuStreamBuffer({ text: "Done", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.removeReaction = vi.fn(async () => undefined);

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.removeReaction).not.toHaveBeenCalled();
  });

  it("does not remove reactions when the reaction id is missing", async () => {
    const channel = makeChannel();
    channel.streamBuffers.om_001 = new FeishuStreamBuffer({ text: "Done", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.removeReaction = vi.fn(async () => undefined);

    await channel.sendDelta("oc_chat1", "", { streamEnd: true, message_id: "om_001" });

    expect(channel.removeReaction).not.toHaveBeenCalled();
  });

  it("does not remove reactions when both ids are missing", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = new FeishuStreamBuffer({ text: "Done", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.removeReaction = vi.fn(async () => undefined);

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.removeReaction).not.toHaveBeenCalled();
  });

  it("does not remove reactions when the delta is not a stream end", async () => {
    const channel = makeChannel();
    channel.createStreamingCardSync = vi.fn(() => null);
    channel.removeReaction = vi.fn(async () => undefined);

    await channel.sendDelta("oc_chat1", "more text", { message_id: "om_001", reaction_id: "rx_42" });

    expect(channel.removeReaction).not.toHaveBeenCalled();
  });

  it("keeps the active reaction while a stream is resuming", async () => {
    const channel = makeChannel();
    channel.config.doneEmoji = "DONE";
    channel.streamBuffers.om_001 = new FeishuStreamBuffer({ text: "partial", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.reactionIds.om_001 = "rx_42";
    channel.removeReaction = vi.fn(async () => undefined);
    channel.addReaction = vi.fn(async () => "done_rx");

    await channel.sendDelta("oc_chat1", "", { streamEnd: true, resuming: true, message_id: "om_001" });

    expect(channel.removeReaction).not.toHaveBeenCalled();
    expect(channel.addReaction).not.toHaveBeenCalled();
    expect(channel.reactionIds.om_001).toBe("rx_42");
  });

  it("adds the done emoji only on the final stream end", async () => {
    const channel = makeChannel();
    channel.config.doneEmoji = "DONE";
    channel.streamBuffers.om_001 = new FeishuStreamBuffer({ text: "partial", cardId: "card_1", sequence: 3, lastEdit: 0 });
    channel.reactionIds.om_001 = "rx_42";
    channel.removeReaction = vi.fn(async () => undefined);
    channel.addReaction = vi.fn(async () => "done_rx");

    await channel.sendDelta("oc_chat1", "", { streamEnd: true, resuming: true, message_id: "om_001" });
    expect(channel.removeReaction).not.toHaveBeenCalled();
    expect(channel.addReaction).not.toHaveBeenCalled();

    channel.streamBuffers.om_001 = new FeishuStreamBuffer({ text: "final", cardId: "card_1", sequence: 5, lastEdit: 0 });
    await channel.sendDelta("oc_chat1", "", { streamEnd: true, resuming: false, message_id: "om_001" });

    expect(channel.removeReaction).toHaveBeenCalledWith("om_001", "rx_42");
    expect(channel.addReaction).toHaveBeenCalledWith("om_001", "DONE");
  });
});
