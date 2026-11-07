// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AccountNotificationHosts } from "../account-notification-hosts.js";
import { NotificationCenterProvider } from "../notification-center.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), getLotteryReward: vi.fn(), ackLotteryReward: vi.fn(),
  ensureTaskTokenGift: vi.fn(), ackTaskTokenGift: vi.fn(), getBootstrap: vi.fn(),
  state: {
    account: { userId: "user-1" as string | null },
    bootstrap: { app: { userMode: "account" }, onboarding: { completed: true } },
    startup: { status: "ready" }, navigation: { currentPath: "/main", windowVisible: true },
  },
}));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../app/providers.js", () => ({ useOptionalApiClients: () => ({ clients: {
  account: { getLotteryReward: mocks.getLotteryReward, ackLotteryReward: mocks.ackLotteryReward,
    ensureTaskTokenGift: mocks.ensureTaskTokenGift, ackTaskTokenGift: mocks.ackTaskTokenGift },
  bootstrap: { getBootstrap: mocks.getBootstrap },
} }) }));
vi.mock("../../app/use-guidance-progress.js", () => ({ useGuidanceDone: () => true }));
vi.mock("../history-launch-prompt-host.js", () => ({ HistoryLaunchPromptHost: () => null }));
vi.mock("../github-star-prompt-host.js", () => ({ GithubStarPromptHost: () => null }));
vi.mock("../task-token-gift-dialog.js", () => ({ TaskTokenGiftDialog: (props: { onClose(): void }) =>
  <button type="button" onClick={props.onClose}>Dismiss normal task gift</button> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Provider doubles are component test data, not real login or native-Electron evidence.
describe("AccountNotificationHosts", () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = async () => {
    await act(async () => { root.render(<I18nProvider language="zh-CN"><NotificationCenterProvider>
      <AccountNotificationHosts />
    </NotificationCenterProvider></I18nProvider>); });
  };
  const settle = async () => {
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); await Promise.resolve(); });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T20:00:00+08:00"));
    window.localStorage.clear();
    for (const fn of [mocks.dispatch, mocks.getLotteryReward, mocks.ackLotteryReward,
      mocks.ensureTaskTokenGift, mocks.ackTaskTokenGift, mocks.getBootstrap]) fn.mockReset();
    mocks.state.account.userId = "user-1";
    mocks.getLotteryReward.mockResolvedValue({ hasReward: true, drawId: "legacy-reward-fixture", tokenAmount: 500_000 });
    mocks.ackLotteryReward.mockResolvedValue({ ok: true });
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: false });
    mocks.ackTaskTokenGift.mockResolvedValue({ ok: true });
    mocks.getBootstrap.mockResolvedValue({ tokenUsage: { totalTokens: 22_000_000 } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); document.body.replaceChildren();
    vi.useRealTimers(); vi.restoreAllMocks();
  });

  it("never polls or acknowledges the ended reward across startup, focus, rerender and account changes", async () => {
    for (const user of ["user-1", "user-1", null, "user-2"]) {
      mocks.state.account.userId = user;
      await render();
      act(() => { window.dispatchEvent(new Event("focus")); });
      await settle();
      expect(mocks.getLotteryReward).not.toHaveBeenCalled();
      expect(mocks.ackLotteryReward).not.toHaveBeenCalled();
      expect(document.querySelector(".memmy-notification-stack")).toBeNull();
    }
  });

  it("retains the normal task gift and acknowledges only that grant on dismissal", async () => {
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: true, grantId: "valid-task-gift-fixture",
      audience: "existing", tokenAmount: 20_000_000, totalTokens: 22_000_000 });
    await render(); await settle();
    expect(mocks.ensureTaskTokenGift).toHaveBeenCalledOnce();
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    const close = container.querySelector<HTMLButtonElement>("button");
    expect(close?.textContent).toBe("Dismiss normal task gift");
    await act(async () => { close!.click(); await Promise.resolve(); });
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "valid-task-gift-fixture" });
    expect(mocks.getLotteryReward).not.toHaveBeenCalled();
    expect(mocks.ackLotteryReward).not.toHaveBeenCalled();
  });

  it("is the actual RuntimeApp notification composition", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app.tsx"), "utf8");
    expect(source).toContain("<AccountNotificationHosts />");
    expect(source).toContain('from "./components/account-notification-hosts.js"');
    expect(source).not.toContain("TokenCreditToastHost");
  });
});
