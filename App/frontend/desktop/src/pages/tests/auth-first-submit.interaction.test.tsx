// @vitest-environment happy-dom

import type { AccountLoginResultView, VerifyCodeInput } from "@memmy/local-api-contracts";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { resetAnalyticsContextForTests } from "../../analytics/analytics-context.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { LoginPage } from "../login-page.js";
import { TokenDetailPage } from "../token-detail-page.js";
import { WelcomePage } from "../welcome-page.js";

const mocks = vi.hoisted(() => ({
  clients: null as AppClients | null,
  state: null as AppState | null,
  channel: "phone" as "phone" | "email",
  verifyCode: vi.fn<(input: VerifyCodeInput) => Promise<AccountLoginResultView>>(),
  sendCode: vi.fn(async () => ({ resendAfterSec: 60 })),
  dispatch: vi.fn(),
  track: vi.fn(),
  resetSocialLogin: vi.fn()
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: mocks.clients, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch })
}));

vi.mock("../../app/account-channel.js", () => ({
  resolveDesktopAccountChannel: () => mocks.channel
}));

vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: mocks.track, ready: true })
}));

vi.mock("../../app/login-mode.js", () => ({
  persistLoginModeSelection: vi.fn(async () => undefined)
}));

vi.mock("../../components/use-social-login.js", () => ({
  useSocialLogin: () => ({
    pendingProvider: null,
    feedback: null,
    reset: mocks.resetSocialLogin,
    clearFeedback: vi.fn()
  })
}));

vi.mock("../../components/mascot/memmy.js", () => ({ Memmy: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each([
  ["WelcomePage", WelcomePage],
  ["LoginPage", LoginPage],
  ["TokenDetailPage", TokenDetailPage]
] as const)("%s first login submission", (_name, Page) => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.channel = "phone";
    mocks.verifyCode.mockReset();
    mocks.verifyCode.mockResolvedValue(unauthenticatedLoginResult());
    mocks.clients = { account: { sendCode: mocks.sendCode, verifyCode: mocks.verifyCode } } as unknown as AppClients;
    mocks.state = {
      ...createInitialAppState(),
      bootstrap: {
        promotions: { invitation: { enabled: true }, loginBanner: true, agentChatTokenTotal: 2_000_000 }
      } as AppState["bootstrap"]
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    mocks.clients = null;
    mocks.state = null;
    resetAnalyticsContextForTests();
    vi.useRealTimers();
  });

  it("submits manually entered values on the first click while resend is counting down", async () => {
    await renderPage(Page);
    await enterValue(field("identifier"), "13800138000");
    await click(button("获取验证码"));
    await enterValue(field("code"), "123456");

    expect(button("60s 后重发").disabled).toBe(true);
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());

    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith(phoneInput());
  });

  it.each(["", "  INVITE1  "])("reads visible native input values before React receives change events (invite %j)", async (inviteCode) => {
    await renderPage(Page);
    await enterValue(field("identifier"), "13800138000");
    await click(button("获取验证码"));
    // Simulate a native value update without synthesizing an input/change event.
    // This establishes the form-state mismatch; it does not emulate a platform's
    // actual autofill implementation.
    setNativeValue(field("identifier"), "13900139000");
    setNativeValue(field("code"), " 123456 ");
    setNativeValue(field("inviteCode"), inviteCode);

    expect(field("code").value).toBe(" 123456 ");
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());

    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith({
      ...phoneInput(),
      phoneNumber: "13900139000",
      ...(inviteCode ? { invitationCode: "INVITE1" } : {})
    });
    // Form submission synchronizes React state, so the next countdown render
    // preserves the visible code rather than clearing it back to stale props.
    await act(async () => vi.advanceTimersByTime(1000));
    expect(field("code").value).toBe(" 123456 ");
  });

  it("allows login with no invitation input when the promotion is disabled", async () => {
    mocks.state!.bootstrap!.promotions.invitation.enabled = false;
    await renderPage(Page);
    expect(container.querySelector('input[name="inviteCode"]')).toBeNull();
    setNativeValue(field("identifier"), "13800138000");
    setNativeValue(field("code"), "123456");
    await click(submitButton());

    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith(phoneInput());
  });

  it("reads email values from the international form without waiting for a change event", async () => {
    mocks.channel = "email";
    await renderPage(Page);
    expect(field("identifier").type).toBe("email");
    setNativeValue(field("identifier"), " person@example.com ");
    setNativeValue(field("code"), "123456");
    await click(submitButton());

    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith({
      channel: "email",
      email: "person@example.com",
      verificationCode: "123456",
      loginSource: "Memmy"
    });
  });

  it("uses the submitted invitation value for signup analytics after authentication", async () => {
    mocks.verifyCode.mockResolvedValue({
      session: {
        authenticated: true,
        isNewUser: true,
        profile: {
          userId: "offline-test-user",
          email: null,
          phoneNumber: "13800138000",
          nickname: "Test user",
          avatarUrl: null,
          planType: null,
          hasFinishedGuide: false,
          region: null,
          registeredAt: null
        }
      },
      invitationResult: { status: "success", inviteeRewardTokens: 50_000 }
    });
    await renderPage(Page);
    setNativeValue(field("identifier"), "13800138000");
    setNativeValue(field("code"), "123456");
    setNativeValue(field("inviteCode"), "INVITE1");
    await click(submitButton());

    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith({ ...phoneInput(), invitationCode: "INVITE1" });
    expect(mocks.track).toHaveBeenCalledWith({
      name: "signup_completed",
      params: { method: "phone", is_new_user: true, user_mode: "account", invite_code_provided: true },
      consentTier: "basic"
    });
  });

  it("shows a missing code error instead of silently disabling a completed identifier", async () => {
    await renderPage(Page);
    await enterValue(field("identifier"), "13800138000");
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());

    expect(mocks.verifyCode).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("请输入验证码");
    expect(submitButton().disabled).toBe(false);
  });

  it("shows pending feedback, blocks repeat submission, and enables retry after a request fails", async () => {
    const request = deferred<AccountLoginResultView>();
    mocks.verifyCode.mockImplementationOnce(() => request.promise);
    await renderPage(Page);
    await enterValue(field("identifier"), "13800138000");
    await enterValue(field("code"), "123456");
    await act(async () => {
      submitButton().click();
      // A second submit can arrive before React commits the disabled state.
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(submitButton().textContent).toBe("登录中…");
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute("aria-busy")).toBe("true");
    await click(submitButton());
    // Also cover an explicit submit event while the native button is disabled.
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.verifyCode).toHaveBeenCalledTimes(1);

    await act(async () => request.reject(new Error("offline test failure")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("登录失败，请检查验证码后重试");
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe("登录 / 注册");
    expect(submitButton().hasAttribute("aria-busy")).toBe(false);
    await click(submitButton());
    expect(mocks.verifyCode).toHaveBeenCalledTimes(2);
  });

  it("shows an unavailable client error rather than returning silently", async () => {
    mocks.clients = null;
    await renderPage(Page);
    setNativeValue(field("identifier"), "13800138000");
    setNativeValue(field("code"), "123456");
    await click(submitButton());

    expect(mocks.verifyCode).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("登录服务尚未就绪，请稍后重试");
    expect(submitButton().disabled).toBe(false);
  });

  async function renderPage(Component: ComponentType) {
    await act(async () => root.render(<I18nProvider language="zh-CN"><Component /></I18nProvider>));
  }

  function field(name: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(input).not.toBeNull();
    return input!;
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label);
    expect(found).toBeDefined();
    return found!;
  }

  function submitButton(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  }
});

async function enterValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setNativeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

function phoneInput(): VerifyCodeInput {
  return { channel: "phone", phoneNumber: "13800138000", verificationCode: "123456", loginSource: "Memmy" };
}

function unauthenticatedLoginResult(): AccountLoginResultView {
  return { session: { authenticated: false }, invitationResult: { status: "not_provided" } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
