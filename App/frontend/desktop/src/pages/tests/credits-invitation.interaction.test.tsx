// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import usageStyles from "../settings-token-usage.module.css";
import { mockBootstrap } from "./fixtures/bootstrap.js";
vi.mock("../credits-in-app.js", () => ({ CreditsSettingsPanel: ({ invitationContent }: { invitationContent: ReactNode }) => <>{invitationContent}</> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each([4, 0])("keeps the original invitation card with real code and %s remaining slots", async remaining => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const getInvitation = vi.fn();
  const invitationSummary = vi.fn(async () => ({ invitationCode: "MEMMY-ABC123", rule: { inviterReward: "200.00", inviteeReward: "200.00", validDays: 30, dailyLimit: 5 }, todayRewarded: 1, todayRemaining: remaining, totalRewarded: "200.00" }));
  const invitations = vi.fn();
  const state = appReducer(appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings")), appActions.accountUpdated({ userId: "7", email: "test@example.invalid" }));
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><SettingsPageView state={state} dispatch={vi.fn()} activeTab="tokens"
      accountClient={{ getInvitation } as never} creditsClient={{ invitationSummary, invitations } as never}
      update={{ appVersion: "test", phase: "idle", preparedUpdatePath: null, downloadProgress: null, feedback: null, requestInlineAction: vi.fn(), requestPrimaryAction: vi.fn() }} /></I18nProvider>));
    expect(host.textContent).toContain("MEMMY-ABC123");
    expect(host.querySelector<HTMLElement>(`.${usageStyles.invitationCard}`)?.style.marginBottom).toBe("24px");
    expect(host.textContent).toContain(remaining ? "好友注册成功后，双方各得 200 积分" : "今日邀请已满，明天再来");
    expect(getInvitation).not.toHaveBeenCalled(); expect(invitationSummary).toHaveBeenCalledTimes(1);
    expect(invitations).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "下一页")).toBe(false);
  } finally { act(() => root.unmount()); host.remove(); }
});
