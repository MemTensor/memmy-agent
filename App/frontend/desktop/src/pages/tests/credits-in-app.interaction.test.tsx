// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { useAppState } from "../../state/app-state.js";
import { appActions } from "../../state/app-actions.js";
import { describeCreditPool, formatDayKey, readCreditDemo, previewCreditPlan, shiftDayKey, writeCreditDemo } from "../../app/credits-preview-quota.js";
import { CreditsSettingsPanel, CreditsSettingsShell, CreditsSourceDetailPage, HomeCheckinCard } from "../credits-in-app.js";
import { CreditsPlansPage, CreditsRedeemPage } from "../credits-commerce.js";
import type { AppRoutePath } from "../../app/routes.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let navigate: (path: AppRoutePath) => void;
function Harness() {
  const { state, dispatch } = useAppState();
  navigate = path => dispatch(appActions.navigate(path));
  switch (state.navigation.currentPath) {
    case "/credit-purchase-details": return <CreditsPlansPage />;
    case "/credit-reward-details": return <CreditsSourceDetailPage source="reward" />;
    case "/plans": return <CreditsPlansPage />;
    case "/credit-packs": return <CreditsPlansPage />;
    case "/redeem": return <CreditsRedeemPage />;
    case "/credit-checkout": return <CreditsPlansPage />;
    default: return <CreditsSettingsShell><CreditsSettingsPanel /></CreditsSettingsShell>;
  }
}
function button(text: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}
function click(el: HTMLElement) { act(() => el.click()); }
function go(path: AppRoutePath) { act(() => navigate(path)); }
function headings() { return [...container.querySelectorAll("h1")].map(el => el.textContent); }
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear(); window.localStorage.clear();
  vi.stubEnv("MEMMY_APP_EDITION", "cn");
  container = document.createElement("div");document.body.append(container);root = createRoot(container);
  act(() => root.render(<AppProviders><Harness /></AppProviders>));
});
afterEach(() => { act(() => root.unmount());document.body.replaceChildren();vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("separate credit destinations", () => {
  it("dismisses the home reminder for today without claiming, and shows it on a later day", () => {
    const before = readCreditDemo();
    act(() => root.render(<AppProviders><HomeCheckinCard key="first" dismissible /></AppProviders>));
    click(container.querySelector<HTMLButtonElement>('[aria-label="关闭签到提醒"]')!);
    expect(container.querySelector(".home-checkin")).toBeNull();
    expect(readCreditDemo()).toEqual(before);
    act(() => root.render(<AppProviders><HomeCheckinCard key="revisit" dismissible /></AppProviders>));
    expect(container.querySelector(".home-checkin")).toBeNull();
    window.localStorage.setItem("memmy.home.checkinDismissedOn", shiftDayKey(formatDayKey(new Date()), -1));
    act(() => root.render(<AppProviders><HomeCheckinCard key="next-day" dismissible /></AppProviders>));
    expect(container.querySelector(".home-checkin")).not.toBeNull();
  });

  it("shows the continuous streak after claiming exactly 100, even on day seven", () => {
    const today = formatDayKey(new Date());
    const current = readCreditDemo();
    act(() => writeCreditDemo({ ...current, lastClaimDate: shiftDayKey(today, -1), streak: 6 }));
    act(() => root.render(<AppProviders><HomeCheckinCard /></AppProviders>));
    expect(container.textContent).toContain("+100积分");
    expect(button("签到领取")).toBeTruthy();
    expect(container.textContent).not.toContain("连续签到");
    expect(container.textContent).not.toContain("1,000");
    expect(container.querySelectorAll(".home-checkin__dot")).toHaveLength(0);
    const before=describeCreditPool(readCreditDemo()).totalRemaining;
    click(button("签到领取"));
    expect(container.textContent).toContain("已连续签到 7 天");
    expect(container.textContent).toContain("+100积分已到账");
    expect(container.textContent).not.toContain("额外");
    expect(container.textContent).not.toContain("1,000");
    expect(describeCreditPool(readCreditDemo()).totalRemaining).toBe(before+100);
    expect(container.querySelector(".home-checkin__done")?.textContent).toContain("已连续签到 7 天");
    expect(container.textContent).toContain("今日已签到");
    expect(container.querySelector(".home-checkin__action")).toBeNull();
  });

  it("opens source details from titles and returns to the compact balance summary", () => {
    expect(container.textContent).not.toContain("发放于");
    expect(container.textContent).not.toContain("发放于");
    click(button("平台奖励积分"));expect(headings()).toContain("平台奖励积分明细");
    expect(container.querySelectorAll('article ul > li')).toHaveLength(4);
    click(button("积分余额"));click(button("兑换码"));
    expect(headings()).not.toContain("兑换码");
    expect(container.querySelector('input[placeholder="请输入兑换码"]')).not.toBeNull();
  });

  it("opens upgrade benefits and expands redemption in the balance page", () => {
    expect(container.querySelector('input[placeholder="请输入兑换码"]')).toBeNull();
    expect(container.textContent).not.toContain("免费版每月 1,000 积分；");
    click(button("申请升级"));expect(headings()).toContain("套餐");
    click(button("积分余额"));click(button("兑换码"));
    expect(headings()).not.toContain("兑换码");
    expect(container.querySelector('input[placeholder="请输入兑换码"]')).not.toBeNull();
    expect(container.querySelector('form label')?.textContent).toBe("兑换码");
    expect(container.querySelector('form')?.textContent).toContain("兑换后积分将发放至您的个人账户");
    expect(button("兑换码").getAttribute("aria-expanded")).toBe("true");
    const before = readCreditDemo();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="请输入兑换码"]')!;
    act(() => { input.value = "TEST-CODE"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(readCreditDemo()).toEqual(before);
    click(button("兑换码"));
    expect(button("兑换码").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('input[placeholder="请输入兑换码"]')).toBeNull();
  });

  it("shows monthly validity directly with no cycle or owner tooltips", () => {
    go("/plans");
    expect(container.textContent).toContain("每月 5,000 积分");
    expect(container.textContent).toContain("每个知识库 10 人共享");
    expect(container.querySelector("s")?.textContent).toBe("原价 ¥50/月");
    expect(container.textContent).not.toContain("$7.99");
    expect(container.textContent).not.toContain("套餐积分每周期清零，不结转");
    expect(container.textContent).not.toContain("自己的 API Key 不消耗积分");
    expect(container.querySelector('#credits-pay')).toBeNull();
    expect(container.textContent).toContain("（每月重置）");
    expect(container.querySelector('[aria-label="积分有效期说明"]')).toBeNull();
    expect(container.querySelector('[aria-label="共享人数说明"]')).toBeNull();
    expect(container.textContent).not.toContain("包含创建者");
  });

  it("opens the questionnaire without changing the plan or credits", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("memmy", { openExternal });
    go("/plans");
    const before = readCreditDemo();
    const link = container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(link.href).toContain("/notable/share/form/");
    await act(async () => link.click());
    expect(openExternal).toHaveBeenCalledWith(link.href);
    expect(readCreditDemo()).toEqual(before);
    expect(container.textContent).not.toContain("升级成功");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(readCreditDemo()).toEqual(before);
  });

  it.each([
    ["cn", "zh-CN", "_Gb8aww9_hSDStju"],
    ["cn", "en-US", "_YEqI4bp_AaETHuL"],
    ["intl", "zh-CN", "_B0FXaSH_hHxa07b"],
    ["intl", "en-US", "_FAqe8nE_xKW8kbu"]
  ] as const)("routes the %s edition and %s interface to the matching questionnaire", (edition, locale, viewKey) => {
    vi.stubEnv("MEMMY_APP_EDITION", edition);
    window.history.replaceState({}, "", `/?credits-preview=1&preview-language=${locale}`);
    act(() => root.render(<AppProviders key={`${edition}:${locale}`}><Harness /></AppProviders>));
    go("/plans");
    expect(container.querySelector<HTMLAnchorElement>('article a[target="_blank"]')?.href).toContain(viewKey);
  });

  it("shows an open failure and retains the link and the existing rights", async () => {
    vi.stubGlobal("memmy", { openExternal: vi.fn().mockRejectedValue(new Error("offline")) });
    go("/plans");
    const before = readCreditDemo();
    await act(async () => container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("问卷打开失败");
    expect(container.textContent).not.toContain("复制问卷链接");
    expect(container.querySelector("article a")?.textContent).toBe("现在申请");
    expect(readCreditDemo()).toEqual(before);
  });

  it("shows Plus benefits without another upgrade action or any commerce controls", () => {
    act(() => writeCreditDemo(previewCreditPlan(readCreditDemo(), "pro")));
    go("/plans");
    expect(container.textContent).toContain("本周期套餐积分");
    expect(container.textContent).toContain("下次积分发放");
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(container.textContent).not.toContain("现在使用");
    expect(container.querySelectorAll("article button")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/续费|支付|退款|积分包|有效期至/);
    const before = readCreditDemo();
    click(container.querySelector<HTMLButtonElement>('header button[aria-label="刷新权益"]')!);
    expect(readCreditDemo()).toEqual(before);
  });

  it.each(["cn", "intl"])("uses the same application and two credit sources in %s", edition => {
    vi.stubEnv("MEMMY_APP_EDITION", edition);
    go("/credit-packs");
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/PayPal|支付|积分包/);
    expect(container.querySelector("s")?.textContent).toBe(edition === "intl" ? "原价 $8.99/月" : "原价 ¥50/月");
    const cards = container.querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("现在使用");
    expect(cards[1]?.querySelector("a")?.textContent).toBe("现在申请");
    expect(cards[1]?.textContent).toContain(edition === "intl" ? "$0" : "¥0");
    go("/credit-checkout");
    expect(container.textContent).toContain("现在申请");
    go("/credit-purchase-details");
    expect(container.textContent).toContain("现在申请");
    go("/settings");
    expect(container.querySelectorAll('dl dt')).toHaveLength(2);
    expect(container.textContent).not.toContain("购买积分");
  });
});
