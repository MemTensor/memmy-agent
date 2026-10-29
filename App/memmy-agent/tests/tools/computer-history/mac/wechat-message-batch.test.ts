import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeWeChatBatch, WeChatMessageBatchReader, WeChatReaderError,
} from "../../../../src/tools/computer-history/mac/wechat-message-batch.js";
import { WeChatHistoryConsentStore } from "../../../../src/tools/computer-history/mac/wechat-consent.js";

const MESSAGE_TABLE = "Msg_0123456789abcdef0123456789abcdef";
const CURSOR_KEY = `message_0.db:${MESSAGE_TABLE}`;
const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createReadFixture(malformedResponse = false, names: unknown = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wechat-read-"));
  fixtureDirectories.push(directory);
  const cursorFile = path.join(directory, "cursor.json");
  const invocationFile = path.join(directory, "invocation.json");
  const keyFile = path.join(directory, "fixture-config.json");
  const helper = path.join(directory, "reader.cjs");
  fs.writeFileSync(keyFile, JSON.stringify({ cursorFile, invocationFile, malformedResponse, names }));
  fs.writeFileSync(helper, `
const fs = require("node:fs");
const [mode, ...args] = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const config = JSON.parse(fs.readFileSync(argument("--keys"), "utf8"));
const cursorArgument = argument("--cursor");
const since = argument("--since");
fs.writeFileSync(config.invocationFile, JSON.stringify({ mode, cursorArgument: cursorArgument ?? null, ...(since ? { since } : {}) }));
const table = "message_0.db:Msg_0123456789abcdef0123456789abcdef";
let cursor = {};
if (mode === "poll") {
  if (cursorArgument !== config.cursorFile) throw new Error("cursor argument missing or incorrect");
  cursor = JSON.parse(fs.readFileSync(cursorArgument, "utf8"));
  if (!cursor || Array.isArray(cursor) || typeof cursor !== "object"
    || Object.values(cursor).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("invalid cursor");
  }
} else if (mode !== "baseline" || cursorArgument !== undefined) {
  throw new Error("invalid baseline arguments");
}
const nextLocalId = mode === "baseline" ? 8 : (cursor[table] ?? 0) + 1;
process.stdout.write(JSON.stringify({
  databaseCount: 1,
  nextCursor: { [table]: nextLocalId },
  messages: mode === "baseline" ? [] : [{
    database: "message_0.db", table: "Msg_0123456789abcdef0123456789abcdef",
    localId: nextLocalId, serverId: config.malformedResponse ? 99 : "9223372036854775807",
    messageType: 1, createdAtSeconds: config.createdAtSeconds ?? 1790510000, senderId: "fixture-sender",
    bodyHex: Buffer.from("new fixture message").toString("hex"),
  }],
  ...(config.names ? { names: config.names } : {}),
}));
`);
  const consent = new WeChatHistoryConsentStore(path.join(directory, "consent", "consent.json"));
  const consentId = consent.grant().consentId!;
  const options = {
    databaseRoot: path.join(directory, "db_storage"), keyFile, cursorFile,
    sqlcipherLibrary: "builtin", python: process.execPath, helper, consent,
  };
  return {
    cursorFile, invocationFile, consentId, options,
    reader: new WeChatMessageBatchReader(options),
    invocation: () => JSON.parse(fs.readFileSync(invocationFile, "utf8")),
  };
}

describe("personal WeChat History messages", () => {
  it("creates stable account-scoped identities and preserves message evidence", () => {
    const batch: Parameters<typeof normalizeWeChatBatch>[0] = {
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

  it("baselines only before the first acknowledged checkpoint, then resumes polling", async () => {
    const fixture = createReadFixture();
    const baseline = await fixture.reader.read();
    expect(fixture.invocation()).toEqual({ mode: "baseline", cursorArgument: null });
    expect(baseline).toEqual({ messages: [], nextCursor: { [CURSOR_KEY]: 8 }, consentId: fixture.consentId });
    expect(fs.existsSync(fixture.cursorFile)).toBe(false);

    fixture.reader.acknowledge(baseline.nextCursor, baseline.consentId);
    const savedCursor = fs.readFileSync(fixture.cursorFile, "utf8");
    const restarted = new WeChatMessageBatchReader(fixture.options);
    const polled = await restarted.read();
    expect(fixture.invocation()).toEqual({ mode: "poll", cursorArgument: fixture.cursorFile });
    expect(polled.messages.map((message) => message.localId)).toEqual([9]);
    expect(polled.nextCursor).toEqual({ [CURSOR_KEY]: 9 });
    expect(fs.readFileSync(fixture.cursorFile, "utf8")).toBe(savedCursor);
  });

  it("keeps the consent boundary after a delayed first successful baseline", async () => {
    const fixture = createReadFixture();
    const consentedAt = Date.parse(JSON.parse(fs.readFileSync(fixture.options.consent.filePath, "utf8")).consentedAt);
    await new WeChatMessageBatchReader({ ...fixture.options, baselineFromConsent: true }).read();
    expect(fixture.invocation()).toEqual({ mode: "baseline", cursorArgument: null, since: String(Math.ceil(consentedAt / 1000)) });

    const stale = { ...JSON.parse(fs.readFileSync(fixture.options.consent.filePath, "utf8")),
      consentedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
    fs.writeFileSync(fixture.options.consent.filePath, JSON.stringify(stale), { mode: 0o600 });
    await new WeChatMessageBatchReader({ ...fixture.options, baselineFromConsent: true }).read();
    expect(fixture.invocation()).toEqual({ mode: "baseline", cursorArgument: null,
      since: String(Math.ceil(Date.parse(stale.consentedAt) / 1000)) });

    const accountStart = Math.ceil(Date.parse(stale.consentedAt) / 1000) + 3_600;
    await new WeChatMessageBatchReader({ ...fixture.options, baselineFromConsent: true,
      baselineSince: accountStart }).read();
    expect(fixture.invocation()).toEqual({ mode: "baseline", cursorArgument: null,
      since: String(accountStart) });

    fs.writeFileSync(fixture.cursorFile, `${JSON.stringify({ [CURSOR_KEY]: 8 })}\n`, { mode: 0o600 });
    await new WeChatMessageBatchReader({ ...fixture.options, baselineFromConsent: true }).read();
    expect(fixture.invocation()).toEqual({ mode: "poll", cursorArgument: fixture.cursorFile });
  });

  it("does not persist out-of-order messages older than consent while advancing the cursor", async () => {
    const fixture = createReadFixture();
    const consentedAt = Date.parse(fixture.options.consent.read().consentedAt!);
    const since = Math.ceil(consentedAt / 1000);
    fs.writeFileSync(fixture.cursorFile, `${JSON.stringify({ [CURSOR_KEY]: 8 })}\n`, { mode: 0o600 });
    const config = JSON.parse(fs.readFileSync(fixture.options.keyFile, "utf8"));
    fs.writeFileSync(fixture.options.keyFile, JSON.stringify({ ...config, createdAtSeconds: since - 1 }));
    const reader = new WeChatMessageBatchReader({ ...fixture.options, baselineFromConsent: true,
      baselineSince: since });
    const excluded = await reader.read();
    expect(excluded.messages).toEqual([]);
    expect(excluded.nextCursor).toEqual({ [CURSOR_KEY]: 9 });
    reader.acknowledge(excluded.nextCursor, excluded.consentId);

    fs.writeFileSync(fixture.options.keyFile, JSON.stringify({ ...config, createdAtSeconds: since + 1 }));
    const included = await reader.read();
    expect(included.messages.map((message) => message.localId)).toEqual([10]);
  });

  it.each([{}, { [CURSOR_KEY]: 8 }])("polls an existing cursor %j without acknowledging the read", async (cursor) => {
    const fixture = createReadFixture();
    const savedCursor = `${JSON.stringify(cursor)}\n`;
    fs.writeFileSync(fixture.cursorFile, savedCursor, { mode: 0o600 });
    const batch = await fixture.reader.read();
    expect(fixture.invocation()).toEqual({ mode: "poll", cursorArgument: fixture.cursorFile });
    const previous = (cursor as Record<string, number>)[CURSOR_KEY] ?? 0;
    expect(batch.nextCursor).toEqual({ [CURSOR_KEY]: previous + 1 });
    expect(batch.messages[0]).toMatchObject({ localId: previous + 1, text: "new fixture message" });
    expect(batch.messages[0]?.messageId).toBe(`${batch.messages[0]?.accountFingerprint}:${MESSAGE_TABLE}:server:9223372036854775807`);
    expect(fs.readFileSync(fixture.cursorFile, "utf8")).toBe(savedCursor);
  });

  it("surfaces the freshest resolved names when the reader provides them", async () => {
    const names = { chats: { "7689": { display: "群聊123", kind: "group" } }, people: { wxid_a: "张三" } };
    const fixture = createReadFixture(false, names);
    fs.writeFileSync(fixture.cursorFile, `${JSON.stringify({ [CURSOR_KEY]: 8 })}\n`, { mode: 0o600 });
    const batch = await fixture.reader.read();
    expect(batch.names).toEqual(names);
  });

  it("omits names when the reader does not provide them", async () => {
    const fixture = createReadFixture();
    fs.writeFileSync(fixture.cursorFile, `${JSON.stringify({ [CURSOR_KEY]: 8 })}\n`, { mode: 0o600 });
    const batch = await fixture.reader.read();
    expect(batch).not.toHaveProperty("names");
  });

  it("rejects malformed message rows without advancing an existing checkpoint", async () => {
    const fixture = createReadFixture(true);
    const savedCursor = `${JSON.stringify({ [CURSOR_KEY]: 8 })}\n`;
    fs.writeFileSync(fixture.cursorFile, savedCursor, { mode: 0o600 });
    await expect(fixture.reader.read()).rejects.toThrow("invalid WeChat message row");
    expect(fixture.invocation()).toEqual({ mode: "poll", cursorArgument: fixture.cursorFile });
    expect(fs.readFileSync(fixture.cursorFile, "utf8")).toBe(savedCursor);
  });

  it.each(["{invalid-json", JSON.stringify({ [CURSOR_KEY]: "8" })])(
    "fails with a corrupt cursor without replacing it: %s", async (savedCursor) => {
      const fixture = createReadFixture();
      fs.writeFileSync(fixture.cursorFile, savedCursor, { mode: 0o600 });
      await expect(fixture.reader.read()).rejects.toThrow("WeChat local reader failed");
      expect(fixture.invocation()).toEqual({ mode: "poll", cursorArgument: fixture.cursorFile });
      expect(fs.readFileSync(fixture.cursorFile, "utf8")).toBe(savedCursor);
    },
  );

  it("keeps only the reader's stable failure category, never its output", async () => {
    const fixture = createReadFixture();
    const helper = path.join(path.dirname(fixture.cursorFile), "failing-reader.cjs");
    fs.writeFileSync(helper, `
process.stdout.write("private fixture message");
process.stderr.write("private fixture message\\n" + JSON.stringify({ error: "database_key_rejected" }) + "\\n");
process.exit(2);
`);
    const failure = await new WeChatMessageBatchReader({ ...fixture.options, helper }).read()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WeChatReaderError);
    expect(failure).toMatchObject({ category: "database_key_rejected", message: "WeChat local reader failed" });
    expect(JSON.stringify(failure)).not.toContain("private fixture message");
  });

  it("rejects a dangling cursor symlink without launching the reader or replacing the link", async () => {
    const fixture = createReadFixture();
    const missingTarget = `${fixture.cursorFile}.missing`;
    fs.symlinkSync(missingTarget, fixture.cursorFile, "file");
    expect(fs.existsSync(fixture.cursorFile)).toBe(false);

    await expect(fixture.reader.read()).rejects.toThrow("WeChat cursor is unreadable");
    expect(() => fixture.reader.acknowledge({ [CURSOR_KEY]: 8 }, fixture.consentId)).toThrow("WeChat cursor is unreadable");
    expect(fs.existsSync(fixture.invocationFile)).toBe(false);
    expect(fs.lstatSync(fixture.cursorFile).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fixture.cursorFile)).toBe(missingTarget);
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it("rejects a cursor directory without launching the reader or replacing its contents", async () => {
    const fixture = createReadFixture();
    fs.mkdirSync(fixture.cursorFile);
    fs.writeFileSync(path.join(fixture.cursorFile, "retained.txt"), "fixture contents");

    await expect(fixture.reader.read()).rejects.toThrow("WeChat cursor is unreadable");
    expect(() => fixture.reader.acknowledge({ [CURSOR_KEY]: 8 }, fixture.consentId)).toThrow("WeChat cursor is unreadable");
    expect(fs.existsSync(fixture.invocationFile)).toBe(false);
    expect(fs.lstatSync(fixture.cursorFile).isDirectory()).toBe(true);
    expect(fs.readdirSync(fixture.cursorFile)).toEqual(["retained.txt"]);
    expect(fs.readFileSync(path.join(fixture.cursorFile, "retained.txt"), "utf8")).toBe("fixture contents");
  });
});
