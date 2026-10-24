import { describe, expect, it } from "vitest";
import { correlateWeChatWindowEvidence } from "../../../../src/tools/computer-history/mac/wechat-message-correlation.js";
import type { WeChatMessageEvidence } from "../../../../src/tools/computer-history/mac/wechat-message-batch.js";

const base: WeChatMessageEvidence = {
  source: "personal_wechat", accountFingerprint: "account-a", conversationId: "chat-a",
  messageId: "account-a:chat-a:server:1", senderId: "friend", direction: "unknown",
  chatKind: "unknown", chatName: null, senderName: null, fromSelf: null,
  createdAt: "2026-09-27T12:00:00.000Z", kind: "text", text: "好的",
  database: "message_0.db", localId: 1,
};

describe("WeChat source correlation", () => {
  it("keeps one canonical message and adds unique window provenance", () => {
    const result = correlateWeChatWindowEvidence([base, base], [
      { observationId: "ax:1", observedAt: "2026-09-27T12:00:15.000Z", text: "好的" },
      { observationId: "ax:1", observedAt: "2026-09-27T12:00:15.000Z", text: "好的" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].windowObservationIds).toEqual(["ax:1"]);
  });

  it("does not associate ambiguous or unrelated window text", () => {
    const other = { ...base, messageId: "account-a:chat-b:server:2", conversationId: "chat-b" };
    const candidates = [
      { observationId: "ambiguous", observedAt: "2026-09-27T12:00:15.000Z", text: "好的" },
      { observationId: "old", observedAt: "2026-09-27T15:00:00.000Z", text: "好的" },
      { observationId: "wrong-account", observedAt: "2026-09-27T12:00:15.000Z",
        text: "好的", accountFingerprint: "account-z" },
      { observationId: "resolved", observedAt: "2026-09-27T12:00:15.000Z",
        text: "好的", conversationId: "chat-b" },
    ];
    const result = correlateWeChatWindowEvidence([base, other], candidates);
    expect(result.map((row) => row.windowObservationIds)).toEqual([[], ["resolved"]]);
  });
});
