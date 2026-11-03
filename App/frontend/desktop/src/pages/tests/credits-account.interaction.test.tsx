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
import { CreditsSettingsPanel, CreditsSourceDetailPage } from "../credits-in-app.js";
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
  return { plans: vi.fn(async () => ({ currentPlan: "FREE" as const, plans: [
    { code: "FREE" as const, name: "Free", cycleGrant: "1000.00", knowledgeEntitlement: { baseLimit: 10, storageBytes: 10737418240, membersPerBase: 5 } },
    { code: "PRO" as const, name: "Pro", cycleGrant: "5000.00", knowledgeEntitlement: { baseLimit: 50, storageBytes: 53687091200, membersPerBase: 10 } }
  ], application: { eligible: true, formType: "CN_ZH" as const, formUrl: "https://alidocs.dingtalk.com/notable/share/form/v01GXn4ZWgaXodwdODQ_Gb8aww9_hSDStju?source=link" } })),
    latestApplication: vi.fn(async () => null), usage: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })), usageDetail: vi.fn(), usageExport: vi.fn(), usageDownload: vi.fn(), summary: vi.fn(async () => summary),
    grants: vi.fn(async () => ({ items: [reward, { ...reward, grantId: "2", sourceType: "PLAN" as const, sourceName: "Free", granted: "1000.00", remaining: "1000.00", reserved: "0.00" }], hasMore: false, nextCursor: null as string | null })),
    ledger: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })) } satisfies CreditsClient;
}
function Harness({ client }: { client: CreditsClient }) {
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
  return <CreditsSettingsPanel />;
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
  expect(host.textContent).not.toContain("消费明细尚未接入"); expect(client.usage).toHaveBeenCalled(); expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  await click("刷新"); expect(client.summary).toHaveBeenCalledTimes(2);
  await click("兑换码"); expect(host.textContent).toContain("兑换功能尚未接入");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(client.ledger).not.toHaveBeenCalled(); // Accounting entries cannot be relabelled as model calls.
});
it("opens original reward details and plan cards", async () => {
  await mount(fixture()); await click("平台奖励积分");
  expect(host.textContent).toContain("真实邀请奖励"); expect(host.textContent).toContain("234.56"); expect(host.textContent).toContain("发放于");
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("6");
  await click("已过期"); expect(host.textContent).not.toContain("真实邀请奖励");
  await click("积分余额"); await click("申请升级");
  expect(host.querySelectorAll("article")).toHaveLength(2); expect(host.textContent).toContain("5,000.00");
  expect(host.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain("Gb8aww9_hSDStju?source=link");
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

it("opens the authoritative questionnaire through the system browser", async () => {
  const client = fixture(); const openExternal = vi.fn(async () => undefined);
  const previous = window.memmy;
  Object.defineProperty(window, "memmy", { value: { openExternal }, configurable: true });
  try {
    await mount(client); await click("申请升级");
    const link = host.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    await act(async () => link!.click());
    expect(openExternal).toHaveBeenCalledWith((await client.plans()).application.formUrl);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(client.latestApplication).toHaveBeenCalledTimes(2);
  } finally { Object.defineProperty(window, "memmy", { value: previous, configurable: true }); }
});
it("never opens an arbitrary URL returned in a plan response", async () => {
  const client = fixture(); const value = await client.plans();
  client.plans.mockResolvedValue({ ...value, application: { ...value.application, formUrl: "https://example.invalid" } });
  await mount(client); await click("申请升级");
  expect(host.querySelector('a[target="_blank"]')?.hasAttribute("href")).toBe(false);
});
const usageRow = { callId: "local-test-call", requestId: "local-test-request", domain: "agent", operation: "CHAT", model: "actual-test-model", inputTokens: 100, outputTokens: 20, chargedCredits: "1.01", status: "SETTLED", businessDate: "2026-11-03", callCount: 1, startedAt: "2026-11-03T10:00:00+08:00", settledAt: "2026-11-03T10:01:00+08:00", requestContent: null, requestContentStatus: "UNAVAILABLE" };
it("renders settled calls, opens details and keeps balance activity separate", async () => {
  const client = fixture();
  client.usage.mockResolvedValue({ items: [usageRow], hasMore: true, nextCursor: "signed-next" } as never);
  client.usageDetail.mockResolvedValue({ ...usageRow, pricingVersion: "1", cachedTokens: 10, audioSeconds: null, chargeCredits: "1.01", absorbedCredits: "0.00", settlementStatus: "SETTLED", remainingCredits: "998.99" });
  client.ledger.mockResolvedValue({ items: [{ ledgerId: "1", title: "套餐积分重置", balanceDelta: "-8.00", heldDelta: "0.00", balanceAfter: "1000.00", occurredAt: usageRow.startedAt }], hasMore: false, nextCursor: null } as never);
  await mount(client); expect(host.textContent).toContain("actual-test-model"); expect(host.textContent).toContain("1.01");
  expect(host.textContent).toContain("请求内容不可用");
  await click("Agent 执行"); expect(client.usageDetail).toHaveBeenCalledWith("local-test-call", expect.any(AbortSignal));
  expect(document.body.textContent).toContain("价格版本");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await click("下一页"); expect(client.usage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "signed-next", limit: 10 }), expect.any(AbortSignal));
  await click("记忆服务"); expect(client.usage).toHaveBeenLastCalledWith(expect.objectContaining({ domain: "memory" }), expect.any(AbortSignal));
  expect(client.usage.mock.calls.at(-1)?.[0]).not.toHaveProperty("cursor");
  await click("余额变动流水"); expect(host.textContent).toContain("套餐积分重置"); expect(host.textContent).toContain("-8.00");
});
it("uses server CSV export and rejects a late download after switching accounts", async () => {
  const client = fixture(); client.usage.mockResolvedValue({ items: [usageRow], hasMore: false, nextCursor: null } as never);
  const url = "/api/credits/v1/usage/download?token=signed";
  client.usageExport.mockResolvedValue({ exportId: "test-export", fileName: "test.csv", downloadUrl: url, rowCount: 1, expiresAt: usageRow.settledAt });
  let resolve!: (value: { csv: string }) => void;
  client.usageDownload.mockImplementation(() => new Promise(done => { resolve = done; }));
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  await mount(client); await click("导出"); expect(client.usageExport).toHaveBeenCalledWith(expect.objectContaining({ domain: "agent" }), expect.any(AbortSignal));
  await act(async () => switchAccount("100002")); await act(async () => resolve({ csv: "test-data" }));
  expect(create).not.toHaveBeenCalled(); create.mockRestore();
});
it("uses ledger-derived consumed amounts for expired grants", () => {
  const bucket = creditDisplayBuckets([], [{ ...reward, used: "15.44", remaining: "0.00", reserved: "0.00", status: "EXPIRED" }])[0]!;
  expect(bucket.usageKnown).toBe(true); expect(bucket.used).toBe(1544n);
});

it("shows source balances in the existing account menu", async () => {
  const { AppFrame } = await vi.importActual<typeof import("../app-frame.js")>("../app-frame.js");
  const client = fixture();
  function MenuHarness() {
    const { dispatch } = useAppState(); const { setClients } = useApiClients();
    useEffect(() => {
      setClients({ credits: client } as AppClients);
      dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account", language: "zh-CN" } }, "/settings"));
      dispatch(appActions.accountUpdated({ userId: "100001", email: "menu-test@example.invalid" }));
    }, [dispatch, setClients]);
    return <AppFrame title="test"><div>test</div></AppFrame>;
  }
  await act(async () => root.render(<AppProviders><MenuHarness /></AppProviders>));
  const trigger = host.querySelector<HTMLButtonElement>('[data-account-menu-trigger="true"]'); expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const menu = document.querySelector('[role="menu"]');
  expect(menu?.textContent).toContain("套餐积分1,000.00"); expect(menu?.textContent).toContain("平台奖励积分234.56");
});
