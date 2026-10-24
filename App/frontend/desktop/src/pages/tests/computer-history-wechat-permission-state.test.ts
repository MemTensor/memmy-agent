// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWeChatPermissionReturn, readWeChatPermissionReturn, rememberWeChatPermissionReturn, shouldReturnToWeChatSettings, WECHAT_PERMISSION_RETURN_KEY } from "../memory/computer-history-wechat-permission-state.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => { delete window.memmy; vi.useRealTimers(); });

describe("WeChat permission settings return", () => {
  it("distinguishes a process restart from a page reload and can be consumed once", async () => {
    const session = vi.fn().mockResolvedValue("old-process");
    window.memmy = { getComputerHistoryPermissionSessionId: session } as unknown as NonNullable<Window["memmy"]>;
    await rememberWeChatPermissionReturn();
    expect(await shouldReturnToWeChatSettings()).toBe(false);
    session.mockResolvedValue("new-process");
    expect(await shouldReturnToWeChatSettings()).toBe(true);
    clearWeChatPermissionReturn();
    expect(await shouldReturnToWeChatSettings()).toBe(false);
  });

  it("expires abandoned setup instead of taking over a later launch", async () => {
    vi.useFakeTimers();
    await rememberWeChatPermissionReturn();
    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    expect(readWeChatPermissionReturn()).toBeNull();
    expect(window.localStorage.getItem(WECHAT_PERMISSION_RETURN_KEY)).toBeNull();
    expect(await shouldReturnToWeChatSettings()).toBe(false);
  });

  it.each(["broken json", JSON.stringify({ createdAt: "yesterday" }), JSON.stringify({ createdAt: Date.now() + 60_000 })])("ignores invalid saved state %s", (value) => {
    window.localStorage.setItem(WECHAT_PERMISSION_RETURN_KEY, value);
    expect(readWeChatPermissionReturn()).toBeNull();
  });
});
