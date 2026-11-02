// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { createCreditDemo, populateCreditDemo, describeCreditPool, writeCreditDemo, readCreditDemo, type CreditBucket } from "../../app/credits-preview-quota.js";
import { CreditsSettingsPanel, CreditsSourceDetailPage } from "../credits-in-app.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const now = new Date(2026, 9, 16, 12);
function grant(id: string, source: CreditBucket["source"], value: number, expiry: number | null): CreditBucket {
  return { id, source, granted:value, remaining:value, grantedAt:new Date(2026,9,15,12).toISOString(), expiresAt:expiry ? new Date(2026,9,expiry,12).toISOString() : null };
}
function mount() { act(() => root.render(<AppProviders><CreditsSettingsPanel /></AppProviders>)); }
function switchPeriod(period: "valid" | "expired") { act(() => host.querySelector<HTMLButtonElement>(`#credits-tab-${period}`)!.click()); }
function nextPage() { act(() => host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()); }
function setPageSize(size: number) { const select=host.querySelector<HTMLSelectElement>('nav select')!;act(() => {select.value=String(size);select.dispatchEvent(new Event('change',{bubbles:true}));}); }
function card(source: string) { return host.querySelector<HTMLElement>(`article[aria-label="${source}"]`)!; }
function balance(source: string) { return [...host.querySelectorAll('dl > div')].find(row => row.querySelector('dt')?.textContent === source)?.querySelector('dd')?.textContent; }
function grants(source: string) { return card(source).querySelectorAll("ul > li"); }
beforeEach(() => {
  vi.useFakeTimers();vi.setSystemTime(now);window.sessionStorage.clear();
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(() => {act(() => root.unmount());document.body.replaceChildren();vi.useRealTimers();});

describe("balance hierarchy", () => {
  it("shows both sample balances, named rewards and exhausted batches without reseeding on refresh", () => {
    const account = createCreditDemo(now);
    account.buckets[0]!.remaining = 824.75;
    const sample = populateCreditDemo(account);
    expect(populateCreditDemo(sample)).toEqual(sample);
    expect(describeCreditPool(sample, now)).toMatchObject({ planRemaining: 824.75, rewardRemaining: 732.25, totalRemaining: 1557 });
    writeCreditDemo(sample);mount();
    expect(host.textContent).toContain('1,557.00');
    const reward = card('平台奖励积分');
    expect(reward.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(reward.textContent).toContain('最近到期时间');
    expect(reward.textContent).not.toContain('32.25 积分');
    expect(reward.textContent).not.toContain('签到奖励');
    expect(reward.textContent).not.toContain('查看全部');
    expect(reward.textContent).not.toContain('兑换码');
    act(() => root.render(<AppProviders><CreditsSourceDetailPage source="reward" /></AppProviders>));
    expect(grants('平台奖励积分')).toHaveLength(4);
    expect(host.textContent).not.toContain('邀请奖励');
    expect(host.querySelector<HTMLSelectElement>('nav select')?.value).toBe('10');
    expect(host.textContent).toContain('签到奖励');
    expect(grants('平台奖励积分')[0]?.textContent).toContain('到期时间 2026/10/17');
    expect(grants('平台奖励积分')[0]?.textContent).toContain('已使用 100.00 / 100.00');
    expect(grants('平台奖励积分')[0]?.textContent).not.toContain('发放于');
    expect(grants('平台奖励积分')[0]?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(grants('平台奖励积分')[1]?.textContent).toContain('到期时间 2026/10/18');
    expect(grants('平台奖励积分')[1]?.textContent).toContain('已使用 67.75 / 100.00');
    expect(host.textContent).toContain('历史赠送');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled).toBe(true);
    switchPeriod('expired');
    expect(card('已过期').textContent).toContain('失效积分');
    expect([...grants('已过期')].some(row => row.textContent?.includes('兑换码') && row.textContent.includes('已使用 320.00 / 500.00'))).toBe(true);
    expect(grants('已过期')).toHaveLength(2);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 1');
    switchPeriod('valid');
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 1');
    expect(readCreditDemo()).toEqual(sample);
  });

  it("shows one total with source summaries, and doesn't duplicate the plan deadline", () => {
    const account=createCreditDemo(now);account.buckets[0]!.remaining=825;
    account.buckets.push(grant('checkin:2026-10-15','reward',100,20));
    writeCreditDemo(account);mount();
    expect(host.textContent).toContain('925.00');
    expect(balance('套餐积分')).toBe('825.00');
    expect(balance('平台奖励积分')).toBe('100.00');
    for (const source of ['套餐积分','平台奖励积分']) {
      expect(card(source).textContent).not.toContain('剩余');
    }
    expect(card('套餐积分').textContent).toContain('下次刷新时间');
    expect(card('套餐积分').textContent).not.toContain('到期');
    expect(card('套餐积分').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('18');
    expect(card('平台奖励积分').textContent).not.toContain('签到奖励');
    const actions=[...host.querySelectorAll('button')].map(b=>b.textContent?.trim());
    expect(actions).toEqual(expect.arrayContaining(['申请升级','兑换码']));
    expect(card('平台奖励积分').querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelectorAll('dl dt')).toHaveLength(2);
  });

  it("keeps empty sources compact and does not invent grants", () => {
    writeCreditDemo(createCreditDemo(now));mount();
    expect(card('平台奖励积分').textContent).toContain('暂无奖励积分');
    expect(card('平台奖励积分').querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows ten grants by default and lets the user change page size", () => {
    const account=createCreditDemo(now);
    account.buckets.push(...Array.from({length:12},(_,index)=>grant(`checkin:page-${index}`,'reward',10,20+index)));
    writeCreditDemo(account);
    act(() => root.render(<AppProviders><CreditsSourceDetailPage source="reward" /></AppProviders>));
    expect(grants('平台奖励积分')).toHaveLength(10);
    expect(host.textContent).toContain('共 12 笔');
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 2');
    nextPage();
    expect(grants('平台奖励积分')).toHaveLength(2);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('2 / 2');
    setPageSize(20);
    expect(grants('平台奖励积分')).toHaveLength(12);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 1');
    switchPeriod('expired');
    switchPeriod('valid');
    expect(host.querySelector<HTMLSelectElement>('nav select')?.value).toBe('20');
    expect(grants('平台奖励积分')).toHaveLength(12);
    setPageSize(10);
    nextPage();
    switchPeriod('expired');
    switchPeriod('valid');
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 2');
  });

  it("orders grants by expiry, expands batches and excludes expired grants from totals", () => {
    const account=createCreditDemo(now);
    account.buckets.push(grant('late','reward',90,25),grant('soon','reward',10,17),grant('forever','reward',40,null),grant('middle','reward',20,20),grant('expired','reward',999,15));
    writeCreditDemo(account);mount();
    const reward=card('平台奖励积分');
    expect(reward.textContent).toContain('160.00');
    expect(reward.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    act(() => root.render(<AppProviders><CreditsSourceDetailPage source="reward" /></AppProviders>));
    const details=card('平台奖励积分');
    expect(grants('平台奖励积分')).toHaveLength(4);
    const text=details.textContent!;
    expect(grants('平台奖励积分')[0]?.textContent).toContain('到期时间 2026/10/17');
    expect(grants('平台奖励积分')[1]?.textContent).toContain('到期时间 2026/10/20');
    expect(text).not.toContain('999.00');
    expect(host.textContent).toContain('长期有效');
    switchPeriod('expired');
    expect(card('已过期').textContent).toContain('失效积分');
    expect(grants('已过期')[0]?.textContent).toContain('已使用 0.00 / 999.00');

  });

  it("moves a grant into expired details at its deadline without treating expiry as consumption", () => {
    const account=createCreditDemo(now);
    account.buckets.push({ ...grant('redeem:boundary','reward',100,16), remaining:40 },
      { ...grant('future','reward',999,null), grantedAt:new Date(now.getTime()+3600000).toISOString() });
    writeCreditDemo(account);
    act(() => root.render(<AppProviders><CreditsSourceDetailPage source="reward" /></AppProviders>));
    expect(card('平台奖励积分').textContent).toContain('暂无奖励积分');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled).toBe(true);
    switchPeriod('expired');
    expect(card('已过期').textContent).toContain('失效积分');
    expect(grants('已过期')[0]?.textContent).toContain('已使用 60.00 / 100.00');
    expect(host.textContent).not.toContain('999.00');
    expect(describeCreditPool(readCreditDemo(),now).rewardRemaining).toBe(0);
  });

  it("refreshes balances without changing grants", () => {
    writeCreditDemo(createCreditDemo(now));mount();const before=readCreditDemo();
    act(()=>host.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click());
    act(()=>vi.advanceTimersByTime(450));
    expect(readCreditDemo()).toEqual(before);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已更新');
  });

  it("shows one reward row per confirmed invitation without a daily count", () => {
    const account = createCreditDemo(now);
    account.buckets.push(grant('invite:first','reward',200,23),grant('invite:second','reward',200,23));
    writeCreditDemo(account);
    act(() => root.render(<AppProviders><CreditsSourceDetailPage source="reward" /></AppProviders>));
    const invitationRows = [...grants('平台奖励积分')].filter(row => row.textContent?.includes('邀请奖励'));
    expect(invitationRows).toHaveLength(2);
    expect(invitationRows.every(row => row.textContent?.includes('发放于'))).toBe(true);
    expect(host.textContent).not.toContain('今天成功');
  });

  it("seeds invitation rewards only in the invited preview, one bucket per success", () => {
    window.history.replaceState(null, "", "/?credits-preview=1");
    expect(readCreditDemo(now).buckets.some(bucket => bucket.id.startsWith("invite:sample"))).toBe(false);
    window.history.replaceState(null, "", "/?credits-preview=1&credits-invited=1");
    const invited = readCreditDemo(now).buckets.filter(bucket => bucket.id.startsWith("invite:sample"));
    expect(invited).toHaveLength(2);
    expect(invited.map(bucket => bucket.granted)).toEqual([200, 200]);
    expect(new Date(invited[0]!.grantedAt).toDateString()).toBe(new Date(invited[1]!.grantedAt).toDateString());
    const spent = readCreditDemo(now);
    spent.buckets.find(bucket => bucket.id === "invite:sample-1")!.remaining = 25;
    writeCreditDemo(spent);
    expect(readCreditDemo(now).buckets.find(bucket => bucket.id === "invite:sample-1")?.remaining).toBe(25);
    const oldSample = readCreditDemo(now);
    Object.assign(oldSample.buckets.find(bucket => bucket.id === "invite:sample-2")!, { granted: 100, remaining: 35 });
    writeCreditDemo(oldSample);
    expect(readCreditDemo(now).buckets.find(bucket => bucket.id === "invite:sample-2")).toMatchObject({ granted: 200, remaining: 135 });
    window.history.replaceState(null, "", "/?credits-preview=1");
    expect(readCreditDemo(now).buckets.some(bucket => bucket.id.startsWith("invite:sample"))).toBe(false);
    window.history.replaceState(null, "", "/");
  });
});
