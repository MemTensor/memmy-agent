// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDeferredGuidanceStep, writeDeferredGuidanceStep, writeGuidanceCompleted } from "../../app/routes.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CampaignPromptHost } from "../campaign-prompt-host.js";
import { CampaignPrompt } from "../campaign-prompt.js";
import { NotificationToast } from "../notification-toast.js";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  appState: {
    state: {
      startup: { status: "ready" },
      navigation: { currentPath: "/main" },
      bootstrap: {
        app: { userMode: "account" as const },
        onboarding: { completed: false },
        lotteryStatus: {
          shouldShow: true,
          startAt: 1790121600000,
          endAt: 1790812800000,
          serverNow: 1790456789000,
          landingUrl: "https://remote.example/ignored"
        }
      },
      account: { userId: "user-1" as string | null },
      modelConfig: {
        catalog: {
          modelAssignments: {
            byok: { agent: { candidates: [] as string[] } }
          }
        }
      }
    }
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => mocks.appState
}));

vi.mock("../../utils/open-url.js", () => ({
  openExternalUrl: mocks.openExternalUrl
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("campaign and token credit prompts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    mocks.openExternalUrl.mockClear();
    mocks.appState.state.startup.status = "ready";
    mocks.appState.state.navigation.currentPath = "/main";
    mocks.appState.state.bootstrap.app.userMode = "account";
    mocks.appState.state.bootstrap.onboarding.completed = false;
    mocks.appState.state.account.userId = "user-1";
    mocks.appState.state.modelConfig.catalog.modelAssignments.byok.agent.candidates = [];
    writeGuidanceCompleted(window.localStorage);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllEnvs();
  });

  it("uses remote status only for eligibility and keeps the project activity URL", async () => {
    vi.stubEnv("MEMMY_APP_EDITION", "cn");
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "https://project-url.example");

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "去官网参与活动");
    expect(action).not.toBeUndefined();

    await act(async () => {
      action?.click();
    });

    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://project-url.example/activity/");
    expect(mocks.openExternalUrl).not.toHaveBeenCalledWith("https://remote.example/ignored");
  });

  it("waits for an account or BYOK login in the same session", async () => {
    mocks.appState.state.navigation.currentPath = "/welcome";
    mocks.appState.state.bootstrap.app.userMode = "unset";
    mocks.appState.state.account.userId = null;

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    mocks.appState.state.navigation.currentPath = "/main";
    mocks.appState.state.bootstrap.app.userMode = "account";
    mocks.appState.state.account.userId = "user-1";
    window.localStorage.removeItem("memmy.guidanceCompleted");
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    writeGuidanceCompleted(window.localStorage);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).toContain("去官网参与活动");
  });

  it("shows the prompt for BYOK after guidance, without a cloud account id", async () => {
    mocks.appState.state.bootstrap.app.userMode = "byok";
    mocks.appState.state.account.userId = null;
    mocks.appState.state.modelConfig.catalog.modelAssignments.byok.agent.candidates = ["local-agent"];
    window.localStorage.removeItem("memmy.guidanceCompleted");

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    writeGuidanceCompleted(window.localStorage);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });

    expect(document.body.textContent).toContain("去官网参与活动");
  });

  it("waits out setup pages and an in-progress guide, then shows once", async () => {
    mocks.appState.state.bootstrap.app.userMode = "byok";
    mocks.appState.state.account.userId = null;
    mocks.appState.state.navigation.currentPath = "/api-key";
    window.localStorage.removeItem("memmy.guidanceCompleted");

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    mocks.appState.state.navigation.currentPath = "/welcome";
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    mocks.appState.state.navigation.currentPath = "/main";
    mocks.appState.state.modelConfig.catalog.modelAssignments.byok.agent.candidates = ["local-agent"];
    mocks.appState.state.bootstrap.onboarding.completed = true;
    writeGuidanceCompleted(window.localStorage);
    writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");

    clearDeferredGuidanceStep(window.sessionStorage);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).toContain("去官网参与活动");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");
  });

  it("shows once for an account that already finished onboarding", async () => {
    window.localStorage.removeItem("memmy.guidanceCompleted");
    mocks.appState.state.bootstrap.onboarding.completed = true;

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).toContain("去官网参与活动");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CampaignPromptHost />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).not.toContain("去官网参与活动");
  });

  it("renders the large feature-update campaign dialog", () => {
    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="zh-CN">
            <CampaignPrompt onOpenSite={() => undefined} onDismiss={() => undefined} />
          </I18nProvider>
        </StrictMode>
      );
    });

    const dialog = document.body.querySelector(".campaign-intro-dialog");
    expect(dialog).not.toBeNull();
    expect(document.body.textContent).toContain("🥮 中秋限定 · 至 9.30");
    expect(document.body.textContent).toContain("中秋弹幕活动开始了");
    expect(document.body.textContent).toContain("🥮 中秋年年吃月饼");
    expect(document.body.textContent).toContain("🍙 饭团也可以是圆的");
    expect(document.body.textContent).toContain("吃完打卡评价还能领 Token");
    expect(document.body.textContent).toContain("去官网参与活动");
    expect(document.body.textContent).not.toContain("等下再来");
    expect(document.body.querySelector('[aria-label="关闭"]')).not.toBeNull();
    expect(document.body.querySelector(".campaign-intro-secondary")).toBeNull();
    expect(document.body.querySelector("img.campaign-intro-art")).not.toBeNull();
    expect(document.body.querySelector(".campaign-intro-moon")).toBeNull();
    expect(document.body.querySelector(".campaign-intro-mascot")).toBeNull();
    expect(document.body.querySelector(".campaign-intro-highlights")).toBeNull();
    expect(document.body.querySelector(".campaign-intro-demo")).toBeNull();
    expect(document.body.querySelector(".github-star-prompt")).toBeNull();
  });

  it("renders the overseas copy for the intl edition", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "intl");

    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="en-US">
            <CampaignPrompt onOpenSite={() => undefined} onDismiss={() => undefined} />
          </I18nProvider>
        </StrictMode>
      );
    });

    expect(document.body.textContent).toContain("Word is, the year's roundest moon is almost here.");
    expect(document.body.textContent).toContain("Our onigiri? Even rounder.");
    expect(document.body.textContent).toContain("Doubt it? Take a bite, leave a review, and grab some tokens.");
    expect(document.body.textContent).not.toContain("Mooncakes every Mid-Autumn");

    vi.unstubAllEnvs();
  });

  it("renders the overseas Chinese copy for the intl edition", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "intl");

    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="zh-CN">
            <CampaignPrompt onOpenSite={() => undefined} onDismiss={() => undefined} />
          </I18nProvider>
        </StrictMode>
      );
    });

    expect(document.body.textContent).toContain("听说，一年里最圆的月亮就要来了");
    expect(document.body.textContent).toContain("而我们的饭团？比它还圆");
    expect(document.body.textContent).not.toContain("中秋年年吃月饼");

    vi.unstubAllEnvs();
  });

  it("renders the token credit notice as title, amount, and close", () => {
    const htmlContainer = document.createElement("div");
    const toastRoot = createRoot(htmlContainer);
    const onDismiss = vi.fn();
    act(() => {
      toastRoot.render(
        <I18nProvider language="zh-CN">
          <NotificationToast
            variant="success"
            title="🎁 弹幕抽奖 Token 已到账"
            emphasis="+500,000"
            onDismiss={onDismiss}
          />
        </I18nProvider>
      );
    });

    expect(htmlContainer.querySelector(".memmy-notification--success")).not.toBeNull();
    expect(htmlContainer.querySelector(".memmy-notification__title")?.textContent).toBe("🎁 弹幕抽奖 Token 已到账");
    expect(htmlContainer.querySelector(".memmy-notification__emphasis")?.textContent).toBe("+500,000");
    expect(htmlContainer.querySelector(".memmy-notification__body")).toBeNull();
    expect(htmlContainer.querySelector(".memmy-notification__action")).toBeNull();

    const close = htmlContainer.querySelector('[aria-label="关闭"]');
    act(() => (close as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(htmlContainer.innerHTML).not.toContain("campaign-intro-primary");
    act(() => toastRoot.unmount());
  });
});
