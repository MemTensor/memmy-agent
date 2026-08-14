// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AccountClient } from "../../api/account-client.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsPage invitation banner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage()
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows the per-person reward amount delivered by the promotion bootstrap", async () => {
    const invitationResponse = {
      enabled: true,
      invitationCode: "MEMMY-A1B2C3",
      usedInviteSlotsToday: 0,
      dailySuccessLimit: 5,
      remainingInvitesToday: 5,
      dailyLimitReached: false
    };
    const accountClient: AccountClient = {
      sendCode: vi.fn(),
      verifyCode: vi.fn(),
      getInvitation: vi.fn(async () => invitationResponse),
      updateProfile: vi.fn(),
      markGuideFinished: vi.fn(),
      logout: vi.fn(),
      getSession: vi.fn()
    };
    const bootstrap = {
      ...mockBootstrap,
      app: {
        ...mockBootstrap.app,
        userMode: "account" as const,
        language: "zh-CN" as const
      },
      promotions: {
        loginBanner: true,
        improvementGift: true,
        improvementGiftRewardTokens: 1_000_000,
        applyMore: true,
        agentChatTokenTotal: 2_000_000,
        invitation: {
          enabled: true,
          inviterRewardTokens: 765_432,
          inviteeRewardTokens: 765_432,
          dailySuccessLimit: 5
        }
      }
    };
    const bootstrapped = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(bootstrap, "/settings")
    );
    const state = appReducer(
      bootstrapped,
      appActions.accountUpdated({
        email: "invite@example.com",
        phoneNumber: null,
        registeredAt: "2026-08-03T00:00:00.000Z"
      })
    );

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={state}
            dispatch={vi.fn()}
            accountClient={accountClient}
            update={{
              appVersion: "1.0.5",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "好友注册成功后，双方各获得 765,432 Token"
    );
    expect(container.textContent).not.toContain(
      "好友注册成功后，双方都会获得奖励 Token"
    );
    const inviteTitle = [...container.querySelectorAll("p")]
      .find((element) => element.textContent === "邀请好友，享更多额度");
    const invitationBanner = inviteTitle?.parentElement?.parentElement;
    const tokenUsageSection = container.querySelector("#token-usage");
    expect(invitationBanner?.nextElementSibling).toBe(tokenUsageSection);
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
