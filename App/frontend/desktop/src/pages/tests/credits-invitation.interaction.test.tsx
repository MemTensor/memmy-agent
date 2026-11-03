// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
vi.mock("../credits-in-app.js", () => ({ CreditsSettingsPanel: ({ invitationContent }: { invitationContent: ReactNode }) => <>{invitationContent}</> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("reuses the invitation card with cloud rules and paged masked records", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const getInvitation = vi.fn();
  const invitationSummary = vi.fn(async () => ({ invitationCode: "MEMMY-ABC123", rule: { inviterReward: "200.00", inviteeReward: "200.00", validDays: 30, dailyLimit: 5 }, todayRewarded: 1, todayRemaining: 4, totalRewarded: "200.00" }));
  const row = { inviteeMask: "13****78", registeredAt: "2026-11-03T00:00:00+08:00", qualifiedAt: "2026-11-03T00:00:00+08:00", inviterGrant: "200.00", inviteeGrant: "200.00", status: "REWARDED" };
  const invitations = vi.fn().mockResolvedValueOnce({ items: [row], hasMore: true, nextCursor: "next" }).mockResolvedValueOnce({ items: [{ ...row, inviteeMask: "te****id" }], hasMore: false, nextCursor: null });
  const state = appReducer(appReducer(createInitialAppState(), appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings")), appActions.accountUpdated({ userId: "7", email: "test@example.invalid" }));
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><SettingsPageView state={state} dispatch={vi.fn()} activeTab="tokens"
      accountClient={{ getInvitation } as never} creditsClient={{ invitationSummary, invitations } as never}
      update={{ appVersion: "test", phase: "idle", preparedUpdatePath: null, downloadProgress: null, feedback: null, requestInlineAction: vi.fn(), requestPrimaryAction: vi.fn() }} /></I18nProvider>));
    expect(host.textContent).toContain("MEMMY-ABC123"); expect(host.textContent).toContain("30 天有效"); expect(host.textContent).toContain("4/5");
    expect(host.textContent).toContain("13****78"); expect(host.textContent).toContain("已到账"); expect(getInvitation).not.toHaveBeenCalled();
    const next = [...host.querySelectorAll("button")].find(button => button.textContent === "下一页"); expect(next).toBeTruthy();
    await act(async () => next!.click()); expect(invitations).toHaveBeenLastCalledWith({ cursor: "next" }); expect(host.textContent).toContain("te****id");
  } finally { act(() => root.unmount()); host.remove(); }
});
