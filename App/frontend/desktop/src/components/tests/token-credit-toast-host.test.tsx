// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { NotificationCenterProvider } from "../notification-center.js";
import { TokenCreditToastHost } from "../token-credit-toast-host.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getLotteryReward: vi.fn(),
  ackLotteryReward: vi.fn(),
  getBootstrap: vi.fn(),
  appState: {
    state: {
      account: {
        userId: "user-1" as string | null
      }
    }
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({
    state: mocks.appState.state,
    dispatch: mocks.dispatch
  })
}));

vi.mock("../../app/providers.js", () => ({
  useOptionalApiClients: () => ({
    clients: {
      account: {
        getLotteryReward: mocks.getLotteryReward,
        ackLotteryReward: mocks.ackLotteryReward
      },
      bootstrap: {
        getBootstrap: mocks.getBootstrap
      }
    },
    setClients: () => undefined
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TokenCreditToastHost", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.getLotteryReward.mockReset();
    mocks.ackLotteryReward.mockReset();
    mocks.getBootstrap.mockReset();
    mocks.appState.state.account.userId = "user-1";
    mocks.ackLotteryReward.mockResolvedValue({ ok: true });
    mocks.getBootstrap.mockResolvedValue({
      tokenUsage: {
        planName: "体验 Token",
        totalTokens: 30_500_000,
        usedTokens: 0,
        remainingTokens: 30_500_000,
        expiresAt: null,
        lastSyncedAt: null,
        sceneUsages: []
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("coalesces startup and focus checks while a reward request is pending", async () => {
    let resolveReward: ((reward: { hasReward: false }) => void) | undefined;
    mocks.getLotteryReward.mockImplementation(() => new Promise((resolve) => {
      resolveReward = resolve;
    }));

    await renderHost(root);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(mocks.getLotteryReward).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReward?.({ hasReward: false });
    });
  });

  it("checks after login when the app started logged out", async () => {
    mocks.appState.state.account.userId = null;
    mocks.getLotteryReward.mockResolvedValue({ hasReward: false });

    await renderHost(root);
    expect(mocks.getLotteryReward).not.toHaveBeenCalled();

    mocks.appState.state.account.userId = "user-1";
    await renderHost(root);

    expect(mocks.getLotteryReward).toHaveBeenCalledTimes(1);
  });

  it("shows a reward once and acknowledges it only after manual close", async () => {
    mocks.getLotteryReward.mockResolvedValue({
      hasReward: true,
      drawId: "1",
      tokenAmount: 500_000
    });

    await renderHost(root);

    expect(document.body.textContent).toContain("🎁 弹幕抽奖 Token 已到账");
    expect(document.body.textContent).toContain("+500,000");
    expect(mocks.ackLotteryReward).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.body.querySelectorAll(".memmy-notification")).toHaveLength(1);

    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]');
    await act(async () => {
      close?.click();
    });

    expect(mocks.ackLotteryReward).toHaveBeenCalledWith({ drawId: "1" });
    expect(mocks.getBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "tokenUsage/updated" }));
  });

  it("still shows the startup reward after StrictMode replays effects", async () => {
    mocks.getLotteryReward.mockResolvedValue({
      hasReward: true,
      drawId: "strict-1",
      tokenAmount: 500_000
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <I18nProvider language="zh-CN">
            <NotificationCenterProvider>
              <TokenCreditToastHost />
            </NotificationCenterProvider>
          </I18nProvider>
        </StrictMode>
      );
    });

    expect(document.body.textContent).toContain("+500,000");
    expect(mocks.getLotteryReward).toHaveBeenCalledTimes(1);
  });
});

async function renderHost(root: Root): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider language="zh-CN">
        <NotificationCenterProvider>
          <TokenCreditToastHost />
        </NotificationCenterProvider>
      </I18nProvider>
    );
  });
}
