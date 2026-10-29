// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AuthCodeForm } from "../auth-code-form.js";
import { useVerificationCodeAuth, type UseVerificationCodeAuthResult } from "../use-verification-code-auth.js";

const mocks = vi.hoisted(() => ({ sendCode: vi.fn(), verifyCode: vi.fn(), track: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: { account: mocks } }) }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: mocks.track }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let auth: UseVerificationCodeAuthResult;
let channel: "phone" | "email";
let language = "zh-CN";
const identifier = () => channel === "phone" ? "13800138000" : "test@example.com";
function Harness() {
  auth = useVerificationCodeAuth();
  return <AuthCodeForm identifier={identifier()} identifierType={channel} code=""
    onIdentifierChange={() => undefined} onCodeChange={() => undefined}
    onSendCode={() => void auth.sendCode(channel, identifier())} onSubmit={() => undefined}
    sendCodeDisabled={auth.sendCodeDisabled} sendCodeLabel={auth.sendCodeLabel} feedback={auth.feedback} />;
}
async function render() {
  await act(async () => root.render(<I18nProvider language={language}><Harness /></I18nProvider>));
}
const sendButton = () => container.querySelector<HTMLButtonElement>('button[type="button"]')!;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.sendCode.mockReset().mockResolvedValue({ ok: true, resendAfterSec: 60 });
  mocks.verifyCode.mockReset();
  channel = "phone"; language = "zh-CN";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("verification code network failures", () => {
  it.each(["phone", "email"] as const)("shows a request failure and prevents immediate %s retries", async (value) => {
    channel = value;
    mocks.sendCode.mockRejectedValueOnce(new ApiRequestError("The operation was aborted due to timeout", 500, "internal"));
    await render();
    await act(async () => sendButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("验证码请求失败，请在倒计时结束后重试");
    expect(sendButton().disabled).toBe(true);
    expect(auth.countdown).toBe(60);
    await act(async () => auth.sendCode(channel, identifier()));
    expect(mocks.sendCode).toHaveBeenCalledTimes(1);
    // The code input and login remain usable if delivery actually succeeded.
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(sendButton().disabled).toBe(false);
    expect(auth.feedback).toBeNull();
    expect(mocks.sendCode).toHaveBeenCalledTimes(1);
    await act(async () => sendButton().click());
    expect(mocks.sendCode).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("handles a renderer fetch failure without displaying technical details", async () => {
    language = "en-US";
    mocks.sendCode.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(); await act(async () => sendButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection failed. Check your network and retry after the countdown.");
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(sendButton().disabled).toBe(true);
  });

  it.each([
    ["server error", new ApiRequestError("database connection failed", 500, "internal"), "验证码请求失败，请在倒计时结束后重试"],
    ["unavailable service", new ApiRequestError("upstream unavailable", 503, "internal"), "验证码请求失败，请在倒计时结束后重试"],
    ["network failure", new TypeError("Failed to fetch"), "连接失败，请检查网络并在倒计时结束后重试"],
    ["timeout", new DOMException("request timed out", "TimeoutError"), "验证码请求超时，请在倒计时结束后重试"],
    ["aborted request", new DOMException("request aborted", "AbortError"), "验证码请求中断，请在倒计时结束后重试"],
    ["HTTP timeout", new ApiRequestError("Request Timeout", 408), "验证码请求超时，请在倒计时结束后重试"],
    ["gateway timeout", new ApiRequestError("Gateway Timeout", 504), "验证码请求超时，请在倒计时结束后重试"]
  ])("gives actionable feedback for %s without claiming delivery status", async (_name, error, message) => {
    mocks.sendCode.mockRejectedValueOnce(error);
    await render(); await act(async () => sendButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(auth.countdown).toBe(60);
    expect(sendButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(sendButton().disabled).toBe(false);
    expect(mocks.sendCode).toHaveBeenCalledTimes(1);
  });

  it.each(["phone", "email"] as const)("backs off on %s throttling", async (value) => {
    channel = value;
    mocks.sendCode.mockRejectedValue(new ApiRequestError("upstream throttled", 429, "rate_limited"));
    await render(); await act(async () => sendButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("请求过于频繁");
    expect(container.textContent).not.toContain("upstream throttled");
    expect(auth.countdown).toBe(60);
    expect(sendButton().disabled).toBe(true);
  });

  it("does not delay a corrected request after a definitive validation failure", async () => {
    mocks.sendCode.mockRejectedValueOnce(new ApiRequestError("invalid identifier", 400, "invalid_argument"));
    await render(); await act(async () => sendButton().click());
    expect(auth.countdown).toBe(0);
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(mocks.sendCode).toHaveBeenCalledTimes(2);
  });

  it("blocks duplicate calls before React commits the sending state", async () => {
    let finish!: (result: { ok: true; resendAfterSec: number }) => void;
    mocks.sendCode.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const send = auth.sendCode;
    let first!: Promise<void>; let second!: Promise<void>;
    await act(async () => { first = send(channel, identifier()); second = send(channel, identifier()); });
    const count = mocks.sendCode.mock.calls.length;
    await act(async () => { finish({ ok: true, resendAfterSec: 60 }); });
    expect(count).toBe(1);
    await Promise.all([first, second]);
  });

  it("ignores a stale network error after switching interaction", async () => {
    let reject!: (error: Error) => void;
    mocks.sendCode.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = auth.sendCode(channel, identifier()); });
    await act(async () => { auth.resetInteractionState(); });
    await act(async () => { reject(new TypeError("Failed to fetch")); await pending; });
    expect(auth.feedback).toBeNull(); expect(auth.countdown).toBe(0); expect(sendButton().disabled).toBe(false);
  });

  it("uses the server's remaining retry delay after reopening the page", async () => {
    mocks.sendCode.mockRejectedValueOnce(new ApiRequestError("retry later", 429, "rate_limited", null, 17));
    await render(); await act(async () => sendButton().click());
    expect(auth.countdown).toBe(17);
    await act(async () => { vi.advanceTimersByTime(17_000); });
    expect(auth.countdown).toBe(0);
    expect(auth.feedback).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(mocks.sendCode).toHaveBeenCalledTimes(1);
  });

  it.each(["focus", "visibilitychange"])("reconciles the deadline on %s after suspended timers", async (event) => {
    mocks.sendCode.mockRejectedValueOnce(new ApiRequestError("timeout", 504, "internal"));
    await render(); await act(async () => sendButton().click());
    vi.setSystemTime(Date.now() + 61_000);
    await act(async () => { (event === "focus" ? window : document).dispatchEvent(new Event(event)); });
    expect(auth.countdown).toBe(0);
    expect(sendButton().disabled).toBe(false);
    expect(auth.feedback).toBeNull();
    expect(mocks.sendCode).toHaveBeenCalledTimes(1);
    await act(async () => sendButton().click());
    expect(mocks.sendCode).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer login error when the resend countdown expires", async () => {
    mocks.sendCode.mockRejectedValueOnce(new ApiRequestError("timeout", 504, "internal"));
    mocks.verifyCode.mockRejectedValueOnce(new ApiRequestError("invalid verification code", 400, "invalid_argument"));
    await render(); await act(async () => sendButton().click());
    await act(async () => { await auth.login(channel, identifier(), "123456"); });
    expect(mocks.verifyCode).toHaveBeenCalledTimes(1);
    expect(auth.feedback?.text).toContain("验证码错误");
    const loginFeedback = auth.feedback;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(auth.feedback).toBe(loginFeedback);
    expect(sendButton().disabled).toBe(false);
  });
});
