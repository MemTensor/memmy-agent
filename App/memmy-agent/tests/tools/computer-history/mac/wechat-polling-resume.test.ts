import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Inert children: no desktop capture, real WeChat process or personal database.
class FixtureChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123456;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0);
    this.emit("close", 0, null);
    return true;
  }
}
const children = vi.hoisted(() => [] as FixtureChild[]);
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { const child = new FixtureChild(); children.push(child); return child; },
}));
vi.mock("../../../../src/tools/computer-history/mac/wechat-python.js", () => ({
  resolveMacWeChatPython: () => "/fixture/python3",
}));
vi.mock("../../../../src/tools/computer-history/win/python-runtime.js", () => ({
  resolveWindowsWeChatPython: () => ({ executable: "/fixture/python3", args: ["-B"] }),
}));
vi.mock("../../../../src/tools/computer-history/win/private-files.js", () => ({
  prepareWindowsWeChatState: () => {}, validateWindowsWeChatConsent: () => true,
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { mockMacConsentPermissions } from "../private-consent-fixture.js";
import {
  WeChatMessageBatchReader, WeChatReaderError, type WeChatMessageEvidence,
} from "../../../../src/tools/computer-history/mac/wechat-message-batch.js";

const table = "message_0.db:Msg_0123456789abcdef0123456789abcdef";
let root: string;
let cursorFile: string;
let consentFile: string;
let service: ComputerHistoryDemoService;
let rows: WeChatMessageEvidence[];

function makeService() {
  return new ComputerHistoryDemoService({
    recorderScript: path.join(root, "recorder.js"),
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "settings.json"),
    weChatConsentFile: consentFile,
    permissionReader: async () => ({ supported: true, accessibility: true, inputMonitoring: true }),
  });
}

function checkpoint(value: number) {
  fs.writeFileSync(cursorFile, JSON.stringify({ [table]: value }), { mode: 0o600 });
}
function position() {
  return JSON.parse(fs.readFileSync(cursorFile, "utf8"))[table] as number;
}
function events(): { eventType: string; details: { messageId: string } }[] {
  const directory = path.join(root, "recordings", "segments");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name, "events.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).filter((event) => event.eventType === "wechat_message") : [];
  });
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
function batch() {
  const saved = fs.existsSync(cursorFile) ? position() : null;
  const messages = saved === null ? [] : rows.filter((row) => row.localId > saved);
  return { messages, nextCursor: { [table]: Math.max(saved ?? 0, ...rows.map((row) => row.localId)) },
    consentId: JSON.parse(fs.readFileSync(consentFile, "utf8")).consentId as string };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T04:00:00Z"));
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  vi.spyOn(os, "release").mockReturnValue("26.0.0");
  children.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-resume-"));
  const state = path.join(root, "wechat");
  fs.mkdirSync(state, { mode: 0o700 });
  cursorFile = path.join(state, "cursor.json");
  consentFile = path.join(state, "consent.json");
  mockMacConsentPermissions(consentFile);
  const library = path.join(root, "sqlcipher.dylib");
  fs.writeFileSync(library, "inert fixture");
  fs.writeFileSync(path.join(root, "recorder.js"), "// inert fixture");
  fs.writeFileSync(path.join(state, "keys.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(state, "account.json"), JSON.stringify({
    databaseRoot: path.join(root, "wxid_fixture", "db_storage"),
  }), { mode: 0o600 });
  vi.stubEnv("MEMMY_SQLCIPHER_LIBRARY", library);
  rows = [9, 10, 11].map((id) => ({
    source: "personal_wechat", accountFingerprint: "fixture-account", conversationId: "fixture-chat",
    messageId: `fixture-account:server:${id}`, senderId: "fixture-sender", direction: "other",
    chatKind: "private", chatName: "fixture", senderName: "fixture", fromSelf: false,
    createdAt: `2026-10-10T03:43:${46 + id}Z`, kind: "text", text: `fixture message ${id}`,
    database: "message_0.db", localId: id,
  }));
  service = makeService();
  vi.spyOn(WeChatMessageBatchReader.prototype, "read").mockImplementation(async () => batch());
});
afterEach(async () => {
  await service.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(["darwin", "win32"] as const)("%s WeChat checkpoint resume", (platform) => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.mocked(os.release).mockReturnValue(platform === "darwin" ? "26.0.0" : "10.0.26100");
    service.setWeChatChatAccess(true);
  });

  it("writes pending rows 9-11 before acknowledging the saved position 8 on process startup", async () => {
    checkpoint(8);
    const acknowledge = WeChatMessageBatchReader.prototype.acknowledge;
    vi.spyOn(WeChatMessageBatchReader.prototype, "acknowledge").mockImplementation(function (this: WeChatMessageBatchReader, next, consent) {
      expect(events().map((event) => event.details.messageId)).toEqual(rows.map((row) => row.messageId));
      expect(position()).toBe(8);
      acknowledge.call(this, next, consent);
    });
    service.startObservation();
    await settle();
    expect(WeChatMessageBatchReader.prototype.read).toHaveBeenCalledWith();
    expect(position()).toBe(11);
  });

  it("skips preconnection rows only when no checkpoint exists, then reads the next message", async () => {
    service.startObservation();
    await settle();
    expect(position()).toBe(11);
    expect(events()).toEqual([]);
    rows.push({ ...rows[2]!, localId: 12, messageId: "fixture-account:server:12" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events().map((event) => event.details.messageId)).toEqual(["fixture-account:server:12"]);
    expect(position()).toBe(12);
  });

  it.each(["pause", "stop"])("resumes pending messages after %s without taking another baseline", async (action) => {
    checkpoint(8);
    rows = [];
    service.startObservation();
    await settle();
    if (action === "pause") await service.pauseObservation();
    else await service.stopObservation();
    rows = [{ source: "personal_wechat", accountFingerprint: "fixture-account", conversationId: "fixture-chat",
      messageId: "fixture-after-pause", senderId: null, direction: "unknown", chatKind: "unknown",
      chatName: null, senderName: null, fromSelf: null, createdAt: "2026-10-10T04:01:00Z",
      kind: "text", text: "pending while stopped", database: "message_0.db", localId: 9 }];
    if (action === "pause") service.resumeObservation();
    else service.startObservation();
    await settle();
    expect(events()).toHaveLength(1);
    expect(position()).toBe(9);
  });

  it("retries after a restart without duplicating rows already written before a failed acknowledgement", async () => {
    checkpoint(8);
    const acknowledge = vi.spyOn(WeChatMessageBatchReader.prototype, "acknowledge")
      .mockImplementationOnce(() => { throw new Error("fixture acknowledgement interrupted"); });
    service.startObservation();
    await settle();
    expect(position()).toBe(8);
    expect(events()).toHaveLength(3);
    await service.shutdown();
    service = makeService();
    service.startObservation();
    await settle();
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(position()).toBe(11);
    expect(events()).toHaveLength(3);
  });

  it("preserves the checkpoint and the connection while history intake keeps failing", async () => {
    checkpoint(8);
    const append = fs.appendFileSync;
    const failing = vi.spyOn(fs, "appendFileSync").mockImplementation((file, data, options) => {
      if (String(data).includes('"wechat_message"')) throw new Error("fixture history write interrupted");
      return append(file, data, options);
    });
    service.startObservation();
    await settle();
    expect(position()).toBe(8);
    expect(events()).toEqual([]);
    expect(service.snapshot().wechat).toMatchObject({ connection: "connected", error: null });
    for (let poll = 2; poll <= 4; poll++) await vi.advanceTimersByTimeAsync(15_000);
    expect(position()).toBe(8);
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "wechat_reader_unavailable" });
    failing.mockRestore();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(position()).toBe(11);
    expect(service.snapshot().wechat).toMatchObject({ connection: "connected", error: null });
  });

  it("keeps the connection through a slow read but reports rejected keys at once", async () => {
    checkpoint(8);
    vi.mocked(WeChatMessageBatchReader.prototype.read)
      .mockRejectedValueOnce(new WeChatReaderError("reader_timeout"))
      .mockRejectedValueOnce(new WeChatReaderError("database_key_rejected"));
    service.startObservation();
    await settle();
    expect(service.snapshot().wechat).toMatchObject({ connection: "connected", error: null });
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "reader_timeout", phase: "reading" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "wechat_keys_outdated" });
    expect(position()).toBe(8);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(position()).toBe(11);
    expect(service.snapshot().wechat).toMatchObject({ connection: "connected", error: null });
  });

  it("rejects an old in-flight read after an explicit connection finishes", async () => {
    checkpoint(8);
    const oldBatch = batch();
    let resolve!: (value: typeof oldBatch) => void;
    vi.mocked(WeChatMessageBatchReader.prototype.read).mockImplementationOnce(() =>
      new Promise((done) => { resolve = done; }));
    service.startObservation();
    service.connectWeChat();
    children.at(-1)!.emit("close", 0, null);
    resolve(oldBatch);
    await settle();
    expect(position()).toBe(8);
    expect(events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(position()).toBe(11);
    expect(events()).toHaveLength(3);
  });
});
