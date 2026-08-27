import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

describe("Feishu bot mention detection", () => {
  it("matches the exact bot open id", () => {
    const channel = new FeishuChannel();
    channel.botOpenId = channel.botOpenId = "ou_bot";

    expect(channel.isBotMentioned({ mentions: [{ id: { open_id: "ou_bot" } }] })).toBe(true);
  });

  it("does not match a different bot", () => {
    const channel = new FeishuChannel();
    channel.botOpenId = channel.botOpenId = "ou_bot";

    expect(channel.isBotMentioned({ mentions: [{ id: { open_id: "ou_other" } }] })).toBe(false);
  });

  it("matches at-all mentions in message content", () => {
    const channel = new FeishuChannel();
    channel.botOpenId = channel.botOpenId = "ou_bot";

    expect(channel.isBotMentioned({ content: "@_all hello" })).toBe(true);
  });

  it("uses the open-id heuristic when bot id is unavailable", () => {
    const channel = new FeishuChannel();

    expect(channel.isBotMentioned({ mentions: [{ id: { open_id: "ou_abc" } }] })).toBe(true);
  });

  it("ignores user mentions in the fallback heuristic", () => {
    const channel = new FeishuChannel();

    expect(channel.isBotMentioned({ mentions: [{ id: { open_id: "ou_abc", user_id: "uid" } }] })).toBe(false);
  });

  it("returns false when there are no mentions", () => {
    const channel = new FeishuChannel();
    channel.botOpenId = channel.botOpenId = "ou_bot";

    expect(channel.isBotMentioned({ mentions: [] })).toBe(false);
  });
});
