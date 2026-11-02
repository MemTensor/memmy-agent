// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { createCreditDemo, writeCreditDemo, readCreditDemo } from "../../app/credits-preview-quota.js";
import { CreditsUsageLedger } from "../credits-usage-ledger.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
const now=new Date(2026,9,16,12);
const click=(el:HTMLElement)=>act(()=>el.click());
const button=(text:string,scope:ParentNode=host)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text||b.getAttribute('aria-label')===text)!;
function rows(){return host.querySelectorAll('tbody tr');}
function change(el:HTMLInputElement|HTMLSelectElement,value:string){act(()=>{const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLSelectElement.prototype,'value')!.set!;setter.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLInputElement?'input':'change',{bubbles:true}));});}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);window.sessionStorage.clear();window.localStorage.clear();writeCreditDemo(createCreditDemo(now));host=document.createElement('div');document.body.append(host);root=createRoot(host);act(()=>root.render(<AppProviders><CreditsUsageLedger/></AppProviders>));});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.restoreAllMocks();});
describe("usage list interaction",()=>{
  it("always shows the selected date range immediately before the matching export button",()=>{
    const date=button('选择日期'), exp=button('导出');
    expect(date.textContent).toBe('2026-10-09 – 2026-10-16');
    expect(date.nextElementSibling).toBe(exp);
    expect(date.className).toBe(exp.className);
    expect(host.querySelector('[aria-label="消耗日期范围"]')?.contains(date)).toBe(false);
    click(button('今天'));expect(date.textContent).toBe('2026-10-16 – 2026-10-16');
    click(button('30 天'));expect(date.textContent).toBe('2026-09-16 – 2026-10-16');
  });

  it("keeps the request hover card open for multiline content and copying its ID",async()=>{
    const copy=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
    const row=rows()[0]!;
    expect(row.querySelector('button')).toBeNull();
    const trigger=row.querySelector<HTMLElement>('[tabindex="0"]')!;
    act(()=>trigger.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
    const panel=document.querySelector<HTMLElement>('[role="region"][aria-label="请求"]')!;
    expect(panel.textContent).toContain('帮我整理这份会议记录');
    expect(panel.textContent).toContain('仍有分歧、需要继续确认的问题');
    expect(panel.textContent).toContain('sample-agent-0-0-0');
    act(()=>{trigger.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));panel.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));vi.advanceTimersByTime(200);});
    expect(panel.isConnected).toBe(true);
    await act(async()=>button('复制',panel).click());
    expect(copy).toHaveBeenCalledWith('sample-agent-0-0-0');
    expect(button('已复制',panel)).toBeDefined();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
    expect(panel.isConnected).toBe(false);
    act(()=>trigger.focus());expect(document.querySelector('[role="region"][aria-label="请求"]')).not.toBeNull();
    act(()=>{trigger.blur();vi.advanceTimersByTime(200);});expect(document.querySelector('[role="region"][aria-label="请求"]')).toBeNull();
  });

  it("paginates both tabs while keeping date selection",()=>{
    expect(rows()).toHaveLength(10);
    const range=button('选择日期').textContent;
    click(button('下一页'));expect(rows()).toHaveLength(10);expect(button('选择日期').textContent).toBe(range);
    click(button('记忆服务'));expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 4');expect(rows()).toHaveLength(10);
    click(button('今天'));expect(rows()).toHaveLength(5);
    click(button('Agent 任务'));expect(rows()).toHaveLength(6);expect(button('今天').getAttribute('aria-pressed')).toBe('true');
    click(button('30 天'));change(host.querySelector('select')!,'20');expect(rows()).toHaveLength(20);
  });
  it("keeps memory summaries flat, separates model changes, and refreshes without resetting the page",()=>{
    const before=readCreditDemo();click(button('记忆服务'));click(button('今天'));
    expect(rows()).toHaveLength(5);
    expect(host.querySelector('tbody button')).toBeNull();
    const summaries=[...rows()].filter(row=>row.textContent?.includes('记忆摘要'));
    expect(summaries).toHaveLength(2);
    expect(summaries.map(row=>row.textContent).join(' ')).toContain('DeepSeek-V3');
    expect(summaries.map(row=>row.textContent).join(' ')).toContain('Qwen3-32B');
    expect(host.textContent).not.toContain('今天 · 截至');
    click(button('7 天'));click(button('下一页'));
    const first=rows()[0]!.textContent;
    click(button('刷新消耗明细'));
    expect(rows()[0]!.textContent).toBe(first);
    expect(host.textContent).toContain('已刷新 12:00');
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('2 / 4');
    expect(readCreditDemo()).toEqual(before);
  });
  it("applies custom dates, handles empty ranges and keeps balances unchanged",()=>{
    const before=readCreditDemo();click(button('选择日期'));
    expect(host.querySelectorAll('[role="dialog"][aria-label="选择日期"]')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label="月份"]')).toHaveLength(2);
    expect(host.querySelector('input[type="date"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-day="2026-10-10"]:disabled')?.getAttribute('aria-pressed')).toBe('false');
    click(host.querySelector<HTMLButtonElement>('[data-day="2026-09-01"]:not(:disabled)')!);
    click(host.querySelector<HTMLButtonElement>('[data-day="2026-09-02"]:not(:disabled)')!);
    click(button('确定'));
    expect(rows()).toHaveLength(0);expect(host.textContent).toContain('这段时间没有消耗');expect(button('导出').disabled).toBe(true);
    expect(readCreditDemo()).toEqual(before);
  });
  it("selects a range across two months and returns to presets",()=>{
    click(button('选择日期'));
    click(host.querySelector<HTMLButtonElement>('[data-day="2026-09-16"]:not(:disabled)')!);
    click(host.querySelector<HTMLButtonElement>('[data-day="2026-10-16"]:not(:disabled)')!);
    expect(host.querySelector<HTMLButtonElement>('[data-day="2026-09-16"]')?.getAttribute('aria-pressed')).toBe('true');
    click(button('确定'));
    expect(host.querySelector('[aria-controls="usage-date-calendar"]')?.textContent).toContain('2026-09-16 – 2026-10-16');
    expect(rows()).toHaveLength(10);
    expect(button('导出').disabled).toBe(false);
    click(button('今天'));
    expect(host.querySelector('[aria-controls="usage-date-calendar"]')?.textContent).toContain('2026-10-16 – 2026-10-16');
  });
  it("exports all filtered calls, including off-page records and zero usage",()=>{
    let blob:Blob|undefined;
    vi.spyOn(URL,'createObjectURL').mockImplementation(b=>{blob=b as Blob;return 'blob:usage-test';});
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    click(button('导出'));expect(blob).toBeDefined();expect(blob!.size).toBeGreaterThan(1000);
    expect(host.textContent).toContain('已导出 48 条请求记录');
    expect(rows()).toHaveLength(10);
  });
});
