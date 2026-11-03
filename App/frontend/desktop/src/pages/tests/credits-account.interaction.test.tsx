// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreditsGrant } from "@memmy/local-api-contracts";
import type { AppClients } from "../../api/client-types.js";
import type { CreditsClient } from "../../api/credits-client.js";
import { AppProviders, useApiClients } from "../../app/providers.js";
import { readCreditGrants } from "../../app/use-credit-account.js";
import { creditDisplayBuckets, creditUsagePercent, formatCreditAmount } from "../../app/credit-display.js";
import { ApiRequestError } from "../../api/http.js";
import { useAppState } from "../../state/app-state.js";
import { appActions } from "../../state/app-actions.js";
import { CreditsSettingsPanel, CreditsSourceDetailPage, HomeCheckinCard } from "../credits-in-app.js";
import { CreditsPlansPage } from "../credits-commerce.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
vi.mock("../app-frame.js", () => ({ AppFrame: ({ children }: { children: ReactNode }) => <>{children}</> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
let switchAccount: (id: string) => void;
const summary = {
  account: { balance: "1234.56", held: "20.00", spendable: "1214.56", version: 2 },
  plan: { code: "FREE" as const, cycleStart: "2026-11-03T00:00+08:00", cycleEnd: "2026-12-03T00:00+08:00", nextCycleGrant: "1000.00" },
  balanceBySource: { plan: "1000.00", reward: "234.56" }, checkin: { claimedToday: false, reward: "100.00" },
  knowledgeEntitlement: { baseLimit: 10, storageBytes: 1024, membersPerBase: 5 }
};
const reward: CreditsGrant = { grantId: "9007199254740993", sourceType: "INVITATION", sourceId: "invite", sourceName: "真实邀请奖励", granted: "250.00", remaining: "214.56", reserved: "20.00", grantedAt: "2026-11-03T00:00+08:00", expiresAt: null, status: "AVAILABLE" };
function fixture() {
  return {
    checkin: vi.fn(), redeem: vi.fn(), invitationSummary: vi.fn(), invitations: vi.fn(),
    summary: vi.fn(async () => summary),
    grants: vi.fn(async () => ({ items: [reward, { ...reward, grantId: "2", sourceType: "PLAN" as const, sourceName: "Free", granted: "1000.00", remaining: "1000.00", reserved: "0.00" }], hasMore: false, nextCursor: null as string | null })),
    ledger: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })) } satisfies CreditsClient;
}
function Harness({ client, home = false }: { client: CreditsClient; home?: boolean }) {
  const { state, dispatch } = useAppState(); const { setClients } = useApiClients();
  switchAccount = id => dispatch(appActions.accountUpdated({ userId: id }));
  useEffect(() => {
    setClients({ credits: client } as AppClients);
    dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account", language: "zh-CN" } }, "/settings"));
    switchAccount("100001");
  }, [client, dispatch, setClients]);
  if (state.bootstrap?.app.userMode !== "account") return null;
  if (state.navigation.currentPath === "/credit-reward-details") return <CreditsSourceDetailPage source="reward" />;
  if (state.navigation.currentPath === "/plans") return <CreditsPlansPage />;
  return home ? <HomeCheckinCard dismissible /> : <CreditsSettingsPanel />;
}
async function mount(client: CreditsClient) { await act(async () => root.render(<AppProviders><Harness client={client} /></AppProviders>)); }
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.getAttribute("aria-label") === label || el.textContent?.trim() === label);
  expect(button).toBeTruthy(); await act(async () => { button!.click(); });
}
beforeEach(() => {
  window.history.replaceState({}, "", "/"); window.sessionStorage.clear(); window.localStorage.clear(); vi.stubEnv("MEMMY_APP_EDITION", "cn");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllEnvs(); });
it("uses original balance/source/usage layout with real data and no simulated usage", async () => {
  const client = fixture(); await mount(client);
  expect(host.querySelector("#credits-balance")).not.toBeNull(); expect(host.textContent).toContain("1,234.56");
  expect(host.textContent).toContain("234.56"); expect(host.textContent).toContain("已用 15.44 / 250.00");
  expect(host.textContent).toContain("Agent 任务"); expect(host.textContent).toContain("记忆服务");
  expect(host.textContent).toContain("消费明细尚未接入"); expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  await click("刷新"); expect(client.summary).toHaveBeenCalledTimes(2);
  await click("兑换码"); expect(host.textContent).toContain("兑换后积分将发放至您的个人账户");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(client.ledger).not.toHaveBeenCalled(); // Accounting entries cannot be relabelled as model calls.
});
it("opens original reward details and plan cards", async () => {
  await mount(fixture()); await click("平台奖励积分");
  expect(host.textContent).toContain("真实邀请奖励"); expect(host.textContent).toContain("234.56"); expect(host.textContent).toContain("发放于");
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("6");
  await click("已过期"); expect(host.textContent).not.toContain("真实邀请奖励");
  await click("积分余额"); await click("申请升级");
  expect(host.querySelectorAll("article")).toHaveLength(2); expect(host.textContent).toContain("Pro 申请尚未接入");
  expect(host.querySelector('a[aria-disabled="true"]')?.hasAttribute("href")).toBe(false);
});
it("does not fall back to demo data after failed requests", async () => {
  const client = fixture(); client.summary.mockRejectedValueOnce(new ApiRequestError("expired", 401)); await mount(client);
  expect(host.textContent).toContain("登录已失效"); expect(host.textContent).not.toContain("1,000.00");
  await click("重试"); expect(host.textContent).toContain("1,234.56");
});
it("discards old account responses after switching", async () => {
  const client = fixture(); let resolveOld!: (value: typeof summary) => void;
  client.summary.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })); await mount(client);
  client.summary.mockResolvedValue({ ...summary, account: { ...summary.account, balance: "88.00" } });
  await act(async () => switchAccount("100002")); await act(async () => resolveOld(summary));
  expect(host.textContent).toContain("88.00"); expect(host.textContent).not.toContain("1,234.56");
});
it("loads all grant pages for original page counts and rejects broken cursors", async () => {
  const client = fixture(); client.grants.mockResolvedValueOnce({ items: [reward], hasMore: true, nextCursor: "next" });
  client.grants.mockResolvedValueOnce({ items: [{ ...reward, grantId: "2" }], hasMore: false, nextCursor: null });
  expect(await readCreditGrants(client)).toHaveLength(2); expect(client.grants).toHaveBeenLastCalledWith({ limit: 100, cursor: "next" });
  client.grants.mockResolvedValue({ items: [], hasMore: true, nextCursor: "repeat" });
  await expect(readCreditGrants(client)).rejects.toThrow("Invalid credit pagination");
});
it("keeps precise amounts and treats held credits as remaining", () => {
  expect(formatCreditAmount("9007199254740993.01", "en-US")).toBe("9,007,199,254,740,993.01");
  expect(formatCreditAmount("-0.01", "en-US")).toBe("-0.01");
  expect(creditDisplayBuckets([], [reward])[0]?.remaining).toBe(23456n);
  expect(creditDisplayBuckets([], [{ ...reward, status: "EXPIRED", remaining: "0.00" }])[0]?.usageKnown).toBe(false); expect(creditUsagePercent(1544n, 25000n)).toBe(6.17);
});

it("retries a live redemption with the same request ID and displays its actual result", async () => {
  const client = fixture();
  client.redeem.mockRejectedValueOnce(new Error("timeout"));
  client.redeem.mockResolvedValueOnce({ redeemed: true, activityName: "测试活动", grant: { grantId: "3", amount: "123.45", expiresAt: null }, balance: "1358.01", accountVersion: 3 });
  await mount(client); await click("兑换码");
  const input = host.querySelector<HTMLInputElement>("#credit-redemption-code")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "TEST-123");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await submit(); expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeout");
  await submit();
  expect(client.redeem.mock.calls[0]).toEqual(client.redeem.mock.calls[1]);
  expect(client.redeem.mock.calls[0]?.[1]).toBe("TEST-123");
  expect(host.textContent).toContain("测试活动 +123.45"); expect(input.value).toBe("");
});
it("dismissal is per account and never claims a live check-in", async () => {
  const client = fixture();
  await act(async () => root.render(<AppProviders><Harness client={client} home /></AppProviders>));
  const close = host.querySelector<HTMLButtonElement>(".home-checkin__close")!;
  await act(async () => close.click());
  expect(client.checkin).not.toHaveBeenCalled(); expect(host.querySelector(".home-checkin")).toBeNull();
  await act(async () => switchAccount("100002"));
  expect(host.querySelector(".home-checkin")).not.toBeNull();
});
it("check-in retries reuse the request ID and refresh the authoritative status", async () => {
  const client = fixture();
  client.checkin.mockRejectedValueOnce(new Error("timeout"));
  client.checkin.mockImplementationOnce(async () => {
    client.summary.mockResolvedValue({ ...summary, checkin: { ...summary.checkin, claimedToday: true } });
    return { claimed: true, alreadyClaimed: false, businessDate: "2026-11-03", grant: { grantId: "3", amount: "100.00", expiresAt: "2026-12-03T00:00:00+08:00" }, balance: "1334.56", accountVersion: 3 };
  });
  await act(async () => root.render(<AppProviders><Harness client={client} home /></AppProviders>));
  await act(async () => host.querySelector<HTMLButtonElement>(".home-checkin__action")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeout");
  await act(async () => host.querySelector<HTMLButtonElement>(".home-checkin__action")!.click());
  expect(client.checkin.mock.calls[0]).toEqual(client.checkin.mock.calls[1]);
  expect(host.querySelector(".home-checkin--claimed")).not.toBeNull();
});
