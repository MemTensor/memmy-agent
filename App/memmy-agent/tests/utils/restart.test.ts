import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeRestartNoticeFromEnv,
  formatRestartCompletedMessage,
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
});
