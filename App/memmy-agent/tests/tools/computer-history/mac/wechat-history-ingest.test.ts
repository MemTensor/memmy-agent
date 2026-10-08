import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendWeChatMessagesToHistory } from "../../../../src/tools/computer-history/mac/wechat-history-ingest.js";
import type { WeChatMessageEvidence } from "../../../../src/tools/computer-history/mac/wechat-message-batch.js";

describe("unified WeChat History intake", () => {
  it("writes one canonical event and stays idempotent when the cursor has not advanced", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-history-"));
    try {
      const first = path.join(directory, "first", "events.jsonl");
      const next = path.join(directory, "next", "events.jsonl");
      fs.mkdirSync(path.dirname(first));
      fs.mkdirSync(path.dirname(next));
      const message: WeChatMessageEvidence = {
        source: "personal_wechat", accountFingerprint: "account", conversationId: "conversation",
        messageId: "account:conversation:server:1", senderId: "friend", direction: "unknown",
        chatKind: "unknown", chatName: null, senderName: null, fromSelf: null,
        createdAt: "2026-09-27T12:00:00Z", kind: "text", text: "见面时间改到十点",
        database: "message_0.db", localId: 1,
      };
      fs.writeFileSync(first, `${JSON.stringify({
        recordType: "human_event", eventType: "accessibility_snapshot", sequence: 7,
        timestamp: "2026-09-27T12:00:30Z",
        application: { bundleId: "com.tencent.xinWeChat" },
        ax: { mode: "fullTree", text: "AXStaticText|||||见面时间改到十点" },
      })}\n`);
      expect(appendWeChatMessagesToHistory(directory, first, [message])).toBe(1);
      expect(appendWeChatMessagesToHistory(directory, next, [message])).toBe(0);
      expect(fs.existsSync(next)).toBe(false);
      expect(JSON.parse(fs.readFileSync(first, "utf8").trim().split("\n")[1])).toMatchObject({
        eventType: "wechat_message", details: { messageId: message.messageId,
          text: message.text, windowObservationIds: ["ax:7:0:2"] },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
