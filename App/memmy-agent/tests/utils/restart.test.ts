import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeRestartNoticeFromEnv,
  createManagedRestartNotice,
  formatRestartCompletedMessage,
  MANAGED_RESTART_IPC_TYPE,
  parseManagedRestartNotice,
  RESTART_NOTIFY_CHANNEL_ENV,
  RESTART_NOTIFY_CHAT_ID_ENV,
  RESTART_NOTIFY_METADATA_ENV,
  RESTART_STARTED_AT_ENV,
  RestartNotice,
  setRestartNoticeToEnv,
  shouldShowCliRestartNotice,
} from "../../src/utils/restart.js";

const KEYS = [RESTART_NOTIFY_CHANNEL_ENV, RESTART_NOTIFY_CHAT_ID_ENV, RESTART_NOTIFY_METADATA_ENV, RESTART_STARTED_AT_ENV];

afterEach(() => {
  vi.useRealTimers();
  for (const key of KEYS) delete process.env[key];
});

describe("restart notice helpers", () => {
  it("round-trips restart notice through environment and consumes it once", () => {
    for (const key of KEYS) delete process.env[key];
    setRestartNoticeToEnv({ channel: "feishu", chatId: "oc_123" });
    const notice = consumeRestartNoticeFromEnv();
    expect(notice).toMatchObject({ channel: "feishu", chatId: "oc_123", metadata: {} });
    expect(notice?.startedAtRaw).toBeTruthy();
    expect(consumeRestartNoticeFromEnv()).toBeNull();
    for (const key of KEYS) expect(process.env[key]).toBeUndefined();
  });

  it("preserves metadata across env", () => {
    setRestartNoticeToEnv({
      channel: "slack",
      chatId: "C123",
      metadata: { slack: { thread_ts: "1700.42", channel_type: "channel" } },
    });
    expect(consumeRestartNoticeFromEnv()?.metadata).toEqual({ slack: { thread_ts: "1700.42", channel_type: "channel" } });
    expect(process.env[RESTART_NOTIFY_METADATA_ENV]).toBeUndefined();
  });

  it("clears stale metadata when none is provided", () => {
    process.env[RESTART_NOTIFY_METADATA_ENV] = '{"stale": true}';
    setRestartNoticeToEnv({ channel: "cli", chatId: "direct" });
    expect(process.env[RESTART_NOTIFY_METADATA_ENV]).toBeUndefined();
  });

  it("formats elapsed completion messages", () => {
    vi.setSystemTime(new Date(102_000));
    expect(formatRestartCompletedMessage("100.0")).toBe("Restart completed in 2.0s.");
  });

  it("filters CLI restart notices by session", () => {
    const notice = new RestartNotice({ channel: "cli", chatId: "direct", startedAtRaw: "100" });
    expect(shouldShowCliRestartNotice(notice, "cli:direct")).toBe(true);
    expect(shouldShowCliRestartNotice(notice, "cli:other")).toBe(false);
    expect(shouldShowCliRestartNotice(notice, "direct")).toBe(true);
    expect(shouldShowCliRestartNotice(new RestartNotice({ channel: "feishu", chatId: "oc_1", startedAtRaw: "100" }), "cli:direct")).toBe(false);
  });

  it("creates and validates the strict Desktop managed restart IPC envelope", () => {
    const notice = createManagedRestartNotice({
      channel: "websocket",
      chatId: "chat-1",
      startedAt: 123.5,
      metadata: { webui: true }
    });

    expect(parseManagedRestartNotice(notice)).toEqual({
      type: MANAGED_RESTART_IPC_TYPE,
      channel: "websocket",
      chatId: "chat-1",
      startedAt: "123.5",
      metadata: { webui: true }
    });
  });

  it("rejects malformed, oversized, and non-plain managed restart IPC", () => {
    const valid = {
      type: MANAGED_RESTART_IPC_TYPE,
      channel: "websocket",
      chatId: "chat-1",
      startedAt: "123.5",
      metadata: {}
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(parseManagedRestartNotice({ ...valid, extra: true })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, channel: "x".repeat(65) })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, chatId: "x".repeat(257) })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, startedAt: "" })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, startedAt: "not-a-number" })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, metadata: [] })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, metadata: { payload: "x".repeat(17 * 1024) } })).toBeNull();
    expect(parseManagedRestartNotice({ ...valid, metadata: cyclic })).toBeNull();
  });
});
