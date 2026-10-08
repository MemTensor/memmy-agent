import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWeChatBatch, WeChatMessageBatchReader } from "../../../../src/tools/computer-history/mac/wechat-message-batch.js";
import { WeChatHistoryConsentStore } from "../../../../src/tools/computer-history/mac/wechat-consent.js";

describe("personal WeChat History messages", () => {
  it("creates stable account-scoped identities and preserves message evidence", () => {
    const batch = {
      databaseCount: 1,
      nextCursor: { "message_0.db:Msg_0123456789abcdef0123456789abcdef": 2 },
      messages: [
        { database: "message_0.db", table: "Msg_0123456789abcdef0123456789abcdef",
          localId: 1, serverId: "88", messageType: 1, createdAtSeconds: 1790510000,
          senderId: "sender", bodyHex: Buffer.from("hello").toString("hex"),
          chatKind: "private", chatName: "小王", senderName: "自己", fromSelf: true },
        { database: "message_0.db", table: "Msg_0123456789abcdef0123456789abcdef",
          localId: 2, serverId: "0", messageType: 3, createdAtSeconds: 1790510001,
          senderId: null, bodyHex: "" },
      ],
    };
    const first = normalizeWeChatBatch(batch, "/account/a/db_storage");
    const repeated = normalizeWeChatBatch(batch, "/account/a/db_storage");
    const other = normalizeWeChatBatch(batch, "/account/b/db_storage");
    expect(first[0]).toMatchObject({
      source: "personal_wechat", text: "hello", kind: "text", senderId: "sender",
      direction: "self", chatKind: "private", chatName: "小王", senderName: "自己", fromSelf: true,
    });
    expect(first[1]).toMatchObject({ text: null, kind: "unsupported" });
    const file = normalizeWeChatBatch({
      databaseCount: 1,
      nextCursor: { "message_0.db:Msg_0123456789abcdef0123456789abcdef": 3 },
      messages: [{
        database: "message_0.db", table: "Msg_0123456789abcdef0123456789abcdef",
        localId: 3, serverId: "89", messageType: 25769803825, createdAtSeconds: 1790510002,
        senderId: "sender", bodyHex: Buffer.from("<title><![CDATA[note.txt]]></title>").toString("hex"),
        chatKind: "private", chatName: "小王", senderName: "自己", fromSelf: true,
      }],
    }, "/account/a/db_storage");
    expect(file[0]).toMatchObject({ text: "发了文件 note.txt", kind: "text" });
    expect(first.map((message) => message.messageId)).toEqual(repeated.map((message) => message.messageId));
    expect(first[0]?.messageId).not.toBe(other[0]?.messageId);
    expect(first[0]?.messageId).not.toBe(first[1]?.messageId);
  });

  it("acknowledges only increasing cursors while consent remains active", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-cursor-"));
    try {
      const consent = new WeChatHistoryConsentStore(path.join(directory, "consent", "consent.json"));
      const cursorFile = path.join(directory, "cursor.json");
      const reader = new WeChatMessageBatchReader({
        databaseRoot: "/unused/db_storage", keyFile: "/unused/keys.json", cursorFile,
        sqlcipherLibrary: "/unused/libsqlcipher.dylib", consent,
      });
      const table = "message_0.db:Msg_0123456789abcdef0123456789abcdef";
      expect(() => reader.acknowledge({ [table]: 1 }, "missing")).toThrow("revoked");
      const firstConsent = consent.grant().consentId!;
      reader.acknowledge({ [table]: 1 }, firstConsent);
      expect(fs.statSync(cursorFile).mode & 0o777).toBe(0o600);
      expect(() => reader.acknowledge({ [table]: 0 }, firstConsent)).toThrow("regressed");
      consent.revoke();
      const secondConsent = consent.grant().consentId!;
      expect(secondConsent).not.toBe(firstConsent);
      expect(() => reader.acknowledge({ [table]: 2 }, firstConsent)).toThrow("revoked");
      expect(JSON.parse(fs.readFileSync(cursorFile, "utf8"))[table]).toBe(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
