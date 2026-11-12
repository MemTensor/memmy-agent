// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimCollabLaunchPrompt,
  markCollabLaunchPromptSeen,
  readCollabLaunchPromptSeen,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen,
} from "../../app/collab-launch-prompt-state.js";
import { featureAnnouncementSeenKey } from "../../app/task-token-gift-prompt.js";
import { TaskTokenGiftPromptHost } from "../task-token-gift-prompt-host.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  ensureTaskTokenGift: vi.fn(),
  ackTaskTokenGift: vi.fn(),
  getBootstrap: vi.fn(),
  state: {
    account: { userId: "user-1" as string | null },
    bootstrap: { app: { userMode: "account" }, onboarding: { completed: true } },
    startup: { status: "ready" },
    navigation: { currentPath: "/main", windowVisible: true }
  }
}));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../app/providers.js", () => ({ useOptionalApiClients: () => ({ clients: {
  account: { ensureTaskTokenGift: mocks.ensureTaskTokenGift, ackTaskTokenGift: mocks.ackTaskTokenGift },
  bootstrap: { getBootstrap: mocks.getBootstrap }
} }) }));
vi.mock("../../app/use-guidance-progress.js", () => ({ useGuidanceDone: () => true }));
vi.mock("../task-token-gift-dialog.js", () => ({ TaskTokenGiftDialog: (props: { onClose(): void }) =>
  <button type="button" onClick={props.onClose}>Dismiss gift notice</button> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TaskTokenGiftPromptHost", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T20:00:00+08:00"));
    window.localStorage.clear();
    resetCollabLaunchPromptRuntime();
    mocks.dispatch.mockReset();
    mocks.ensureTaskTokenGift.mockReset();
    mocks.ackTaskTokenGift.mockReset();
    mocks.getBootstrap.mockReset();
    mocks.state.account.userId = "user-1";
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: true, grantId: "v125_task_token_gift_20m",
      audience: "existing", tokenAmount: 20_000_000, totalTokens: 22_000_000 });
    mocks.ackTaskTokenGift.mockResolvedValue({ ok: true });
    mocks.getBootstrap.mockResolvedValue({ tokenUsage: { totalTokens: 22_000_000 } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    resetCollabLaunchPromptRuntime();
    document.body.replaceChildren();
    vi.useRealTimers(); vi.restoreAllMocks();
  });

  it("automatically ensures the grant and only acknowledges after the notice closes", async () => {
    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); });
    expect(mocks.ensureTaskTokenGift).toHaveBeenCalledOnce();
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Dismiss gift notice");
    await act(async () => { button!.click(); await Promise.resolve(); });
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "v125_task_token_gift_20m" });
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBe("1");
  });

  it("shows new users the feature pages without a gift page, and acknowledges on close", async () => {
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: true, grantId: "v125_task_token_gift_20m",
      audience: "new", tokenAmount: 20_000_000, totalTokens: 20_000_000 });
    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); });
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Dismiss gift notice");
    await act(async () => { button!.click(); await Promise.resolve(); });
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "v125_task_token_gift_20m" });
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBe("1");
  });

  it("acknowledges a new user's grant after the feature window without opening a dialog", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00+08:00"));
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: true, grantId: "v125_task_token_gift_20m",
      audience: "new", tokenAmount: 20_000_000, totalTokens: 20_000_000 });
    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "v125_task_token_gift_20m" });
  });

  it("does not request or offer a gift while signed out", async () => {
    mocks.state.account.userId = null;
    await act(async () => { root.render(<TaskTokenGiftPromptHost />); vi.advanceTimersByTime(1000); });
    expect(mocks.ensureTaskTokenGift).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });

  it.each([true, false])("credits the gift but defers its notice for the run claimed by collaboration (carousel open: %s)", async (open) => {
    claimCollabLaunchPrompt();
    markCollabLaunchPromptSeen(window.localStorage);
    setCollabLaunchPromptOpen(open);

    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });

    expect(mocks.ensureTaskTokenGift).toHaveBeenCalled();
    expect(mocks.getBootstrap).toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "tokenUsage/updated",
      tokenUsage: { totalTokens: 22_000_000 },
    }));
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBeNull();
    expect(readCollabLaunchPromptSeen(window.localStorage)).toBe(true);
  });

  it("still credits and acknowledges a new user's grant with no visible pages after the feature window when collaboration claimed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00+08:00"));
    mocks.ensureTaskTokenGift.mockResolvedValue({ hasGift: true, grantId: "v125_task_token_gift_20m",
      audience: "new", tokenAmount: 20_000_000, totalTokens: 20_000_000 });
    claimCollabLaunchPrompt();
    setCollabLaunchPromptOpen(true);

    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.ensureTaskTokenGift).toHaveBeenCalled();
    expect(mocks.getBootstrap).toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "tokenUsage/updated",
      tokenUsage: { totalTokens: 22_000_000 },
    }));
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "v125_task_token_gift_20m" });
    expect(container.querySelector("button")).toBeNull();
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBeNull();
  });

  it("refreshes a credited balance but defers the notice when collaboration claims during the gift request", async () => {
    const notice = { hasGift: true, grantId: "v125_task_token_gift_20m", audience: "existing",
      tokenAmount: 20_000_000, totalTokens: 22_000_000 } as const;
    let resolveNotice!: (value: typeof notice) => void;
    mocks.ensureTaskTokenGift.mockReturnValue(new Promise<typeof notice>((resolve) => { resolveNotice = resolve; }));

    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(mocks.ensureTaskTokenGift).toHaveBeenCalled();
    expect(mocks.getBootstrap).not.toHaveBeenCalled();
    claimCollabLaunchPrompt();
    markCollabLaunchPromptSeen(window.localStorage);
    setCollabLaunchPromptOpen(true);
    await act(async () => { resolveNotice(notice); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector("button")).toBeNull();
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBeNull();
    expect(mocks.getBootstrap).toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      tokenUsage: { totalTokens: 22_000_000 },
    }));

    setCollabLaunchPromptOpen(false);
    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    expect(mocks.ensureTaskTokenGift).toHaveBeenCalled();
    expect(mocks.getBootstrap).toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBeNull();
  });

  it("offers the deferred gift on the next run even though the collaboration announcement is already seen", async () => {
    claimCollabLaunchPrompt();
    markCollabLaunchPromptSeen(window.localStorage);
    setCollabLaunchPromptOpen(false);
    resetCollabLaunchPromptRuntime();
    expect(readCollabLaunchPromptSeen(window.localStorage)).toBe(true);

    await act(async () => { root.render(<TaskTokenGiftPromptHost />); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); });
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Dismiss gift notice");
    expect(mocks.ackTaskTokenGift).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBeNull();
    await act(async () => { button!.click(); await Promise.resolve(); });
    expect(mocks.ackTaskTokenGift).toHaveBeenCalledWith({ grantId: "v125_task_token_gift_20m" });
    expect(window.localStorage.getItem(featureAnnouncementSeenKey("user-1"))).toBe("1");
  });
});
