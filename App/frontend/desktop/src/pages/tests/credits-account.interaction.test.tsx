// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreditsGrant } from "@memmy/local-api-contracts";
import type { AppClients } from "../../api/client-types.js";
import type { CreditsClient } from "../../api/credits-client.js";
import { AppProviders, useApiClients } from "../../app/providers.js";
import { readCreditGrants, useCreditAccount } from "../../app/use-credit-account.js";
import { useCreditsExhaustedPrompt, requestCreditsExhaustedPrompt } from "../../app/credits-exhausted-prompt.js";
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
  balanceBySource: { plan: "1000.00", reward: "214.56" }, checkin: { claimedToday: false, reward: "100.00" },
  knowledgeEntitlement: { baseLimit: 10, storageBytes: 1024, membersPerBase: 5 }
};
const reward: CreditsGrant = { grantId: "9007199254740993", sourceType: "INVITATION", sourceId: "invite", sourceName: "真实邀请奖励", granted: "250.00", remaining: "214.56", reserved: "20.00", grantedAt: "2026-11-03T00:00+08:00", expiresAt: null, status: "AVAILABLE" };
function fixture() {
  return { submitApplication: vi.fn(async () => ({applicationId: "1", status: "APPROVED" as const, plan: "PRO" as const, submittedAt: "2026-11-04T10:00:00+08:00", processedAt: "2026-11-04T10:00:00+08:00", failureReason: null})), checkin: vi.fn(), redeem: vi.fn(), invitationSummary: vi.fn(), invitations: vi.fn(), plans: vi.fn(async () => ({ currentPlan: "FREE" as const, plans: [
    { code: "FREE" as const, name: "Free", cycleGrant: "1000.00", knowledgeEntitlement: { baseLimit: 10, storageBytes: 10737418240, membersPerBase: 5 } },
    { code: "PRO" as const, name: "Pro", cycleGrant: "5000.00", knowledgeEntitlement: { baseLimit: 50, storageBytes: 53687091200, membersPerBase: 10 } }
  ], application: { eligible: true, formType: "CN_ZH" as const, formUrl: "https://alidocs.dingtalk.com/notable/share/form/v01GXn4ZWgaXodwdODQ_Gb8aww9_hSDStju?source=link" } })),
    latestApplication: vi.fn(async () => null), usage: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })), usageDetail: vi.fn(), usageExport: vi.fn(), usageDownload: vi.fn(), summary: vi.fn(async () => summary),
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
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.getAttribute("aria-label") === label || el.textContent?.trim() === label);
  expect(button).toBeTruthy(); await act(async () => { button!.click(); });
}
beforeEach(() => {
  window.history.replaceState({}, "", "/"); window.sessionStorage.clear(); window.localStorage.clear(); vi.stubEnv("MEMMY_APP_EDITION", "cn");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllEnvs(); });
it("uses original balance/source/usage layout with real data and no simulated usage", async () => {
  const client = fixture(); await mount(client);
  expect(host.querySelector("#credits-balance")).not.toBeNull(); expect(host.textContent).toContain("1,214.56");
  expect(host.textContent).not.toContain("1,234.56");
  expect([...host.querySelectorAll('dl dd')].map(el => el.textContent)).toEqual(["1,000.00", "214.56"]);
  expect(host.textContent).toContain("已用 15.44 / 250.00");
  expect(host.textContent).toContain("Agent 任务"); expect(host.textContent).toContain("记忆服务");
  expect(host.textContent).not.toContain("消费明细尚未接入"); expect(client.usage).toHaveBeenCalled(); expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  await click("刷新"); expect(client.summary).toHaveBeenCalledTimes(2);
  await click("兑换码"); expect(host.textContent).toContain("兑换后积分将发放至您的个人账户");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(client.ledger).not.toHaveBeenCalled(); // Accounting entries cannot be relabelled as model calls.
});
it("opens original reward details and plan cards", async () => {
  await mount(fixture()); await click("平台奖励积分");
  expect(host.textContent).toContain("真实邀请奖励"); expect(host.textContent).toContain("214.56"); expect(host.textContent).not.toContain("234.56"); expect(host.textContent).toContain("发放于");
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("6");
  await click("已过期"); expect(host.textContent).not.toContain("真实邀请奖励");
  await click("积分余额"); await click("申请升级");
  expect(host.querySelectorAll("article")).toHaveLength(2); expect(host.textContent).toContain("5,000.00");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "现在申请")).toBe(true);
});
it("displays improvement rewards with the server-provided name and amount", async () => {
  const client = fixture();
  client.grants.mockResolvedValue({ items: [{ ...reward, sourceType: "IMPROVEMENT", sourceName: "改进计划奖励", granted: "123.45", remaining: "123.45", reserved: "0.00" }], hasMore: false, nextCursor: null });
  await mount(client); await click("平台奖励积分");
  expect(host.textContent).toContain("改进计划奖励");
  expect(host.textContent).toContain("123.45");
});
it("does not fall back to demo data after failed requests", async () => {
  const client = fixture(); client.summary.mockRejectedValueOnce(new ApiRequestError("expired", 401)); await mount(client);
  expect(host.textContent).toContain("登录已失效"); expect(host.textContent).not.toContain("1,000.00");
  await click("重试"); expect(host.textContent).toContain("1,214.56");
});
it("shares one snapshot across pages and the modal while credits are held, then reports actual exhaustion", async () => {
  const client = fixture();
  client.summary.mockResolvedValue({ ...summary, account: { balance: "83.27", held: "83.27", spendable: "0.00", version: 3 } });
  function Balance() {
    const account = useCreditAccount();
    return <span data-balance>{account.summary?.account.spendable ?? "—"}</span>;
  }
  function Prompt() {
    const { state } = useAppState();
    const account = useCreditAccount();
    const prompt = useCreditsExhaustedPrompt({ enabled: account.live, userId: state.account.userId, balance: account.summary?.account.balance, preview: false });
    return prompt.open ? <span data-exhausted>exhausted</span> : null;
  }
  function SharedHarness({ page }: { page: number }) {
    const { dispatch } = useAppState(); const { setClients } = useApiClients();
    useEffect(() => {
      setClients({ credits: client } as AppClients);
      dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/settings"));
      dispatch(appActions.accountUpdated({ userId: "100001" }));
    }, [dispatch, setClients]);
    return <><Prompt /><Balance /><Balance key={page} /></>;
  }
  const render = (page: number) => act(async () => root.render(<AppProviders><SharedHarness page={page}/></AppProviders>));
  await render(1);
  expect(client.summary).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll('[data-balance]')].map(el => el.textContent)).toEqual(["0.00", "0.00"]);
  expect(host.querySelector('[data-exhausted]')).toBeNull();
  await render(2);
  expect(client.summary).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("—");
  client.summary.mockRejectedValueOnce(new Error("offline"));
  await act(async () => window.dispatchEvent(new Event("memmy:credits-refresh")));
  expect(host.textContent).not.toContain("—");
  expect(host.querySelector('[data-exhausted]')).toBeNull();
  client.summary.mockResolvedValue({ ...summary, account: { balance: "0.00", held: "0.00", spendable: "0.00", version: 4 } });
  await act(async () => window.dispatchEvent(new CustomEvent("credits.changed", { detail: { userId: "100001", accountVersion: 4 } })));
  expect(host.querySelector('[data-exhausted]')).toBeNull();
  await act(async () => requestCreditsExhaustedPrompt());
  expect(host.querySelector('[data-exhausted]')).not.toBeNull();
});
it("discards old account responses after switching", async () => {
  const client = fixture(); let resolveOld!: (value: typeof summary) => void;
  client.summary.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })); await mount(client);
  client.summary.mockResolvedValue({ ...summary, account: { ...summary.account, balance: "88.00", held: "0.00", spendable: "88.00" } });
  await act(async () => switchAccount("100002")); await act(async () => resolveOld(summary));
  expect(host.textContent).toContain("88.00"); expect(host.textContent).not.toContain("1,214.56");
});
it("shows the same spendable balance and source amounts used by the low-credit notice", async () => {
  const client = fixture();
  client.summary.mockResolvedValue({ ...summary,
    account: { ...summary.account, balance: "1000.00", held: "950.00", spendable: "50.00" },
    balanceBySource: { plan: "40.00", reward: "10.00" }
  });
  await mount(client);
  expect(host.textContent).toContain("可用积分低于本周期套餐额度的 10%");
  expect([...host.querySelectorAll('#credits-balance strong')].some(el => el.textContent === "50.00")).toBe(true);
  expect([...host.querySelectorAll('dl dd')].map(el => el.textContent)).toEqual(["40.00", "10.00"]);
});
it("loads all grant pages for original page counts and rejects broken cursors", async () => {
  const client = fixture(); client.grants.mockResolvedValueOnce({ items: [reward], hasMore: true, nextCursor: "next" });
  client.grants.mockResolvedValueOnce({ items: [{ ...reward, grantId: "2" }], hasMore: false, nextCursor: null });
  expect(await readCreditGrants(client)).toHaveLength(2); expect(client.grants).toHaveBeenLastCalledWith({ limit: 100, cursor: "next" });
  client.grants.mockResolvedValue({ items: [], hasMore: true, nextCursor: "repeat" });
  await expect(readCreditGrants(client)).rejects.toThrow("Invalid credit pagination");
});
it("keeps precise spendable amounts without treating held credits as consumed", () => {
  expect(formatCreditAmount("9007199254740993.01", "en-US")).toBe("9,007,199,254,740,993.01");
  expect(formatCreditAmount("-0.01", "en-US")).toBe("-0.01");
  expect(creditDisplayBuckets([], [reward])[0]).toMatchObject({ remaining: 21456n, reserved: 2000n, used: 1544n });
  expect(creditDisplayBuckets([], [{ ...reward, status: "EXPIRED", remaining: "0.00" }])[0]?.usageKnown).toBe(false); expect(creditUsagePercent(1544n, 25000n)).toBe(6.17);
});

it("opens a local questionnaire, keeps failed answers and retry ID, then refreshes the real Pro plan", async () => {
  const client = fixture(); const openExternal = vi.fn(); const previous=window.memmy;
  Object.defineProperty(window,"memmy",{value:{openExternal}, configurable:true});
  try {
    await mount(client); await click("申请升级"); await click("现在申请");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('#upgrade-account')).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true})));
    expect(client.submitApplication).not.toHaveBeenCalled();
    async function fill(id:string,value:string) {
      const el=document.querySelector<HTMLInputElement|HTMLTextAreaElement>(id)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,"value")!.set!.call(el,value);
        el.dispatchEvent(new Event("input",{bubbles:true}));
      });
    }
    await fill('#upgrade-organization','个人'); await fill('#upgrade-upgradeReason','需要更多知识库容量');
    await act(async () => document.querySelector<HTMLInputElement>('input[value="CODING"]')!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(document.querySelector<HTMLInputElement>('#upgrade-organization')!.value).toBe("个人");
    client.submitApplication.mockRejectedValueOnce(new Error("网络暂时不可用"));
    await click("提交申请"); expect(document.body.textContent).toContain("网络暂时不可用");
    expect(document.querySelector<HTMLInputElement>('#upgrade-organization')!.value).toBe("个人");
    const first=client.submitApplication.mock.calls[0]![0];
    expect(first.answers.additionalContact).toBe('');
    expect(first).not.toHaveProperty('userId'); expect(first).not.toHaveProperty('phoneNumber');
    const plans=await client.plans();
    client.plans.mockResolvedValue({...plans,currentPlan:'PRO',application:{...plans.application,eligible:false}} as never);
    client.summary.mockResolvedValue({...summary,plan:{...summary.plan,code:'PRO'},account:{...summary.account,balance:'5234.56',version:3}} as never);
    await click("提交申请");
    expect(client.submitApplication.mock.calls[1]![0]).toEqual(first);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("已成功升级进阶版");
    expect(host.textContent).not.toContain("现在申请");
  } finally { Object.defineProperty(window,"memmy",{value:previous,configurable:true}); }
});
it("does not use an external URL returned in the plan response", async () => {
  const client = fixture(); const value = await client.plans();
  client.plans.mockResolvedValue({ ...value, application: { ...value.application, formUrl: "https://example.invalid" } });
  await mount(client); await click("申请升级"); await click("现在申请");
  expect(document.querySelector('a[target="_blank"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => switchAccount("another-user"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it.each([
  ["CN_ZH", ["usageFrequency", "useCases", "upgradeReason", "organization", "role"]],
  ["CN_EN", ["role", "useCases", "organization", "usageFrequency", "upgradeReason"]],
  ["INTL_ZH", ["upgradeReason", "useCases", "usageFrequency", "organization", "role"]],
  ["INTL_EN", ["upgradeReason", "useCases", "role", "organization", "usageFrequency"]]
] as const)("preserves the source questionnaire field order for %s", async (formType, order) => {
  const client=fixture(); const plans=await client.plans();
  client.plans.mockResolvedValue({...plans,application:{...plans.application,formType}} as never);
  await mount(client); await click("申请升级"); await click("现在申请");
  const form=document.querySelector('[role="dialog"] form')!;
  const fields=[...form.children].slice(0,5).map(el => el.tagName==='FIELDSET' ? el.querySelector('input')!.name : el.querySelector('input,textarea')!.id.replace('upgrade-',''));
  expect(fields).toEqual(order);
  expect(form.querySelectorAll('input[type="checkbox"]')).toHaveLength(7);
  expect(form.querySelector<HTMLInputElement>('#upgrade-organization')?.required).toBe(true);
  expect(form.querySelector<HTMLTextAreaElement>('#upgrade-upgradeReason')?.required).toBe(true);
  expect(form.querySelector('#upgrade-additionalContact')).toBeNull();
  expect(form.firstElementChild?.textContent).toMatch(/^01/);
});
const usageRow = { callId: "local-test-call", requestId: "local-test-request", domain: "agent", operation: "CHAT", model: "actual-test-model", inputTokens: 100, outputTokens: 20, chargedCredits: "1.01", status: "SETTLED", businessDate: "2026-11-03", callCount: 1, startedAt: "2026-11-03T10:00:00+08:00", settledAt: "2026-11-03T10:01:00+08:00", requestContent: null, requestContentStatus: "UNAVAILABLE" };
it("loads billing details into the existing request hover and cancels them when accounts change", async () => {
  const client = fixture();
  client.usage.mockResolvedValue({ items: [usageRow], hasMore: false, nextCursor: null } as never);
  client.usageDetail.mockResolvedValue({ ...usageRow, pricingVersion: "pricing-v2", settlementVersion: 2,
    cachedTokens: 15, audioSeconds: null, inputCredits: "0.50", outputCredits: "1.00", chargeCredits: "1.50",
    chargedCredits: "1.01", absorbedCredits: "0.49", settlementStatus: "SETTLED", remainingCredits: "99.00",
    checkpoints: [{ sequence: 1, usageTokens: 80, chargedCredits: "0.75" }] } as never);
  await mount(client);
  await act(async () => host.querySelector<HTMLElement>('tbody span[tabindex="0"]')!.focus());
  const detail = document.querySelector('[role="region"]')!;
  expect(client.usageDetail).toHaveBeenCalledWith("local-test-call", expect.any(AbortSignal));
  expect(detail.textContent).toContain("请求内容不可用");
  const fields = [...detail.querySelectorAll('dl dt')].map(label => [label.textContent, label.nextElementSibling?.textContent]);
  expect(fields).toEqual(expect.arrayContaining([["输入积分", "0.50"], ["输出积分", "1.00"], ["实际扣除", "1.01"],
    ["平台承担", "0.49"], ["价格版本", "pricing-v2"], ["结算版本", "2"], ["结算状态", "已结算"]]));
  expect(detail.querySelector('details tbody')?.textContent).toBe("1800.75");
  const signal = client.usageDetail.mock.calls[0]![1] as AbortSignal;
  await act(async () => switchAccount("100002"));
  expect(signal.aborted).toBe(true);
  expect(document.querySelector('[role="region"]')).toBeNull();
});
it("renders real usage in the original table without new detail or balance panels", async () => {
  const client = fixture();
  client.usage.mockResolvedValueOnce({ items: [usageRow], hasMore: true, nextCursor: "signed-next", total: 11 } as never);
  client.usage.mockResolvedValue({ items: [usageRow], hasMore: false, nextCursor: null, total: 11 } as never);
  await mount(client);
  expect(host.textContent).toContain("actual-test-model"); expect(host.textContent).toContain("1.01");
  expect(host.textContent).toContain("请求内容不可用");
  expect(host.querySelector('tbody button')).toBeNull();
  expect(host.textContent).not.toContain("余额变动流水");
  const pagination = host.querySelector('nav[aria-label="消耗明细分页"]');
  expect(pagination?.textContent).toContain("1 / 2");
  expect(pagination?.textContent).toContain("共 11 条");
  await click("下一页"); expect(client.usage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "signed-next", limit: 10 }), expect.any(AbortSignal));
  expect(pagination?.textContent).toContain("2 / 2");
  await click("记忆服务"); expect(client.usage).toHaveBeenLastCalledWith(expect.objectContaining({ domain: "memory" }), expect.any(AbortSignal));
  expect(client.usage.mock.calls.at(-1)?.[0]).not.toHaveProperty("cursor");
  expect(host.querySelector('tbody')?.textContent).toContain("Agent 执行");
  expect(client.ledger).not.toHaveBeenCalled(); expect(client.usageDetail).not.toHaveBeenCalled();
});

it("holds the previous height only while loading, then fits the actual rows", async () => {
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 480 } as DOMRect);
  const client = fixture();
  client.usage.mockResolvedValue({ items: [usageRow], hasMore: false, nextCursor: null, total: 1 } as never);
  await mount(client);
  let resolve!: (value: never) => void;
  client.usage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await click("记忆服务");
  expect(host.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector<HTMLElement>('[role="tabpanel"]')?.style.minHeight).toBe("480px");
  expect(host.textContent).not.toContain("正在读取积分");
  expect(host.querySelector("tbody")?.textContent).not.toContain("local-test-request");
  await act(async () => resolve({ items: [], hasMore: false, nextCursor: null, total: 0 } as never));
  expect(host.querySelector('nav[aria-label="消耗明细分页"]')?.textContent).toContain("共 0 条");
  expect(host.querySelector<HTMLElement>('[role="tabpanel"]')?.style.minHeight).toBe("");
  bounds.mockRestore();
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

it.each([
  ["0.00", "0.00", "250.00"],
  ["15.44", "0.00", "234.56"],
  ["15.44", "20.00", "214.56"],
])("shows expired credits excluding consumed %s and held %s", async (used, reserved, expected) => {
  const client = fixture();
  client.grants.mockResolvedValue({ items: [{ ...reward, used, remaining: "0.00", reserved, status: "EXPIRED", expiresAt: "2026-01-01T00:00+08:00" }], hasMore: false, nextCursor: null });
  await mount(client); await click("平台奖励积分"); await click("已过期");
  expect(host.textContent).toContain(`失效积分${expected}`);
  expect(host.textContent).toContain(`已使用 ${used} / 250.00`);
});

it("keeps the original account menu and shows spendable balance", async () => {
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
  expect(menu?.textContent).toContain("免费版"); expect(menu?.textContent).toContain("1,214.56");
  expect(menu?.textContent).not.toContain("1,234.56");
  expect(menu?.textContent).not.toContain("套餐积分"); expect(menu?.textContent).not.toContain("平台奖励积分");
  let resolveRefresh!: (value: typeof summary) => void;
  client.summary.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
  await click("刷新积分余额");
  expect(menu?.textContent).toContain("1,214.56");
  expect(menu?.textContent).not.toContain("正在读取积分");
  expect(menu?.textContent).not.toContain("—");
  await act(async () => resolveRefresh({ ...summary, account: { balance: "83.27", held: "0.00", spendable: "83.27", version: 3 } }));
  expect(menu?.textContent).toContain("83.27");
  client.summary.mockRejectedValueOnce(new Error("offline"));
  await click("刷新积分余额");
  expect(menu?.textContent).toContain("83.27");
  expect(menu?.textContent).toContain("数据可能不是最新");
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
    client.summary.mockResolvedValue({ ...summary, account: { ...summary.account, version: 3 }, checkin: { ...summary.checkin, claimedToday: true } });
    return { claimed: true, alreadyClaimed: false, businessDate: "2026-11-03", grant: { grantId: "3", amount: "100.00", expiresAt: "2026-12-03T00:00:00+08:00" }, balance: "1334.56", accountVersion: 3 };
  });
  await act(async () => root.render(<AppProviders><Harness client={client} home /></AppProviders>));
  await act(async () => host.querySelector<HTMLButtonElement>(".home-checkin__action")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeout");
  await act(async () => host.querySelector<HTMLButtonElement>(".home-checkin__action")!.click());
  expect(client.checkin.mock.calls[0]).toEqual(client.checkin.mock.calls[1]);
  expect(host.querySelector(".home-checkin--claimed")).not.toBeNull();
});
