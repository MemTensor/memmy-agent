import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react";
import { Button } from "../components/button.js";
import { CreditRequestHover } from "./credit-request-hover.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useCreditDemo } from "../app/use-credit-demo.js";
import { creditRangeStart, formatDayKey, type LedgerSpan } from "../app/credits-preview-quota.js";
import { createUsageMock, filterUsageCalls, groupUsageCalls, usageCsv, usageRange, type UsageCall, type UsageRow, type UsageTab } from "../app/credit-usage-ledger.js";
import styles from "./credits-usage-ledger.module.css";

function presetStart(span: LedgerSpan, now: Date) {
  const start=creditRangeStart(span,now);
  if(span!=="today") start.setDate(start.getDate()-1);
  return start;
}

function dayDate(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function addMonth(month: Date, offset: number) {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}

function CalendarMonth(props: {
  month: Date;
  now: Date;
  start: string;
  end: string;
  language: string;
  onMonthChange: (month: Date) => void;
  onNavigate: (offset: number) => void;
  onSelectDay: (day: string) => void;
}) {
  const { t } = useTranslation();
  const year = props.month.getFullYear();
  const monthIndex = props.month.getMonth();
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2024, 0, 1 + index).toLocaleDateString(props.language, { weekday: "narrow" }));
  const today = formatDayKey(props.now);
  return <div className={styles.calendarMonth}>
    <div className={styles.calendarMonthHeader}>
      <button type="button" aria-label={t("usage.previousMonth")} onClick={() => props.onNavigate(-1)}><ChevronLeft size={14} aria-hidden="true" /></button>
      <div className={styles.calendarMonthSelectors}>
        <label><select aria-label={t("usage.month")} value={monthIndex} onChange={event => props.onMonthChange(new Date(year, Number(event.target.value), 1))}>
          {Array.from({ length: 12 }, (_, index) => <option key={index} value={index}>{new Date(year, index, 1).toLocaleDateString(props.language, { month: "short" })}</option>)}
        </select><ChevronDown size={12} aria-hidden="true" /></label>
        <label><select aria-label={t("usage.year")} value={year} onChange={event => props.onMonthChange(new Date(Number(event.target.value), monthIndex, 1))}>
          {Array.from({ length: 11 }, (_, index) => props.now.getFullYear() - 10 + index).map(value => <option key={value} value={value}>{value}</option>)}
        </select><ChevronDown size={12} aria-hidden="true" /></label>
      </div>
      <button type="button" aria-label={t("usage.nextMonth")} onClick={() => props.onNavigate(1)}><ChevronRight size={14} aria-hidden="true" /></button>
    </div>
    <div className={styles.calendarGrid}>
      {weekdays.map((weekday, index) => <span className={styles.calendarWeekday} key={index}>{weekday}</span>)}
      {Array.from({ length: 42 }, (_, index) => {
        const date = new Date(year, monthIndex, index - offset + 1);
        const key = formatDayKey(date);
        const outside = date.getMonth() !== monthIndex;
        const endpoint = !outside && (key === props.start || key === props.end);
        const inRange = !outside && props.end && key >= props.start && key <= props.end;
        return <button key={key} type="button" data-day={key} className={`${styles.calendarDay} ${outside ? styles.calendarDayOutside : ""} ${inRange ? styles.calendarDayRange : ""} ${endpoint ? styles.calendarDayEndpoint : ""} ${!outside && key === today ? styles.calendarDayToday : ""}`} aria-label={date.toLocaleDateString(props.language, { year: "numeric", month: "long", day: "numeric" })} aria-pressed={endpoint} disabled={outside || key > today} onClick={() => props.onSelectDay(key)}>{date.getDate()}</button>;
      })}
    </div>
  </div>;
}

function Pagination(props: { total: number; page: number; size: number; setPage: (n:number)=>void; setSize:(n:number)=>void }) {
  const { t } = useTranslation();
  const pages=Math.max(1,Math.ceil(props.total/props.size));
  return <nav className={styles.pagination} aria-label={t("usage.pagination")}>
    <span>{t("usage.count",{count:props.total})}</span>
    <div><label>{t("credits.detail.pageSizeLabel")} <select aria-label={t("usage.pageSize")} value={props.size} onChange={e=>props.setSize(Number(e.target.value))}>{[10,20,50].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      <Button size="sm" variant="secondary" aria-label={t("credits.detail.previousPage")} disabled={props.page<=1} onClick={()=>props.setPage(props.page-1)}><ChevronLeft size={14}/></Button>
      <span aria-live="polite">{props.page} / {pages}</span>
      <Button size="sm" variant="secondary" aria-label={t("credits.detail.nextPage")} disabled={props.page>=pages} onClick={()=>props.setPage(props.page+1)}><ChevronRight size={14}/></Button>
    </div>
  </nav>;
}

export function CreditsUsageLedger() {
  const { t, language }=useTranslation();
  const { demo, now, reload }=useCreditDemo();
  const [tab,setTab]=useState<UsageTab>("agent");
  const [span,setSpan]=useState<LedgerSpan | "custom">("7");
  const [customOpen,setCustomOpen]=useState(false);
  const [draftStart,setDraftStart]=useState(()=>formatDayKey(presetStart("7",now)));
  const [draftEnd,setDraftEnd]=useState(()=>formatDayKey(now));
  const [calendarMonth,setCalendarMonth]=useState(()=>addMonth(dayDate(formatDayKey(now)),-1));
  const [pickingEnd,setPickingEnd]=useState(false);
  const [custom,setCustom]=useState({start:draftStart,end:draftEnd});
  const [page,setPage]=useState(1), [size,setSize]=useState(10);
  const [exportStatus,setExportStatus]=useState("");
  const calendarRef=useRef<HTMLDivElement|null>(null);
  const calendarTriggerRef=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{ const timer=window.setInterval(reload,10000); return ()=>window.clearInterval(timer); },[reload]);
  useEffect(()=>{
    if(!customOpen) return;
    const dismiss=(event:PointerEvent)=>{
      if(!calendarRef.current?.contains(event.target as Node) && !calendarTriggerRef.current?.contains(event.target as Node)) setCustomOpen(false);
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key==="Escape") {setCustomOpen(false);calendarTriggerRef.current?.focus();}
    };
    document.addEventListener("pointerdown",dismiss);
    document.addEventListener("keydown",escape);
    return ()=>{document.removeEventListener("pointerdown",dismiss);document.removeEventListener("keydown",escape);};
  },[customOpen]);
  const calls=useMemo(()=>createUsageMock(new Date(demo.ledgerAnchor)),[demo.ledgerAnchor]);
  const start=span==="custom" ? custom.start : formatDayKey(presetStart(span,now));
  const end=span==="custom" ? custom.end : formatDayKey(now);
  const range=usageRange(start,end)!;
  const filtered=filterUsageCalls(calls,tab,range,now);
  const rows=groupUsageCalls(filtered);
  const currentPage=Math.min(page,Math.max(1,Math.ceil(rows.length/size)));
  const visible=rows.slice((currentPage-1)*size,currentPage*size);
  const english=language==="en-US";
  const number=(n:number)=>n.toLocaleString(language,{minimumFractionDigits:2,maximumFractionDigits:2});
  const stamp=(at:string,seconds=false)=>new Date(at).toLocaleString(language,{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",...(seconds?{second:"2-digit"}:{}),hour12:false});
  const operation=(call:UsageCall)=>t(`usage.operation.${call.operation}`);
  const prompt=(call:UsageCall)=>english?call.promptEn:call.prompt;
  const title=(row:UsageRow)=>row.source==="memory" ? operation(row.calls[0]!) : row.operation==="title" ? `${operation(row.calls[0]!)} · ${prompt(row.calls[0]!)}` : prompt(row.calls[0]!);
  const model=(row:UsageRow)=>row.models.length===1 ? row.models[0] : t("usage.multipleModels",{model:row.models[0]!,count:row.models.length});
  const dateLabel=(row:UsageRow)=>row.source==="agent" ? stamp(row.at) : row.date===formatDayKey(now) ? stamp(now.toISOString()) : new Date(row.at).toLocaleDateString(language,{month:"2-digit",day:"2-digit"});
  const reset=()=>{setPage(1);setExportStatus("");};
  function refreshUsage() {
    reload();
    setExportStatus(t("usage.refreshed",{time:new Date().toLocaleTimeString(language,{hour:"2-digit",minute:"2-digit",hour12:false})}));
  }
  const draftValid=Boolean(usageRange(draftStart,draftEnd)) && draftEnd<=formatDayKey(now);
  function toggleCalendar() {
    if(customOpen) {setCustomOpen(false);return;}
    setDraftStart(start);setDraftEnd(end);setPickingEnd(false);
    const first=new Date(dayDate(start).getFullYear(),dayDate(start).getMonth(),1);
    const last=new Date(dayDate(end).getFullYear(),dayDate(end).getMonth(),1);
    setCalendarMonth(first.getTime()===last.getTime()?addMonth(first,-1):first);
    setCustomOpen(true);
  }
  function selectCalendarDay(day:string) {
    if(!pickingEnd) {setDraftStart(day);setDraftEnd("");setPickingEnd(true);return;}
    if(day<draftStart) {setDraftStart(day);setDraftEnd("");return;}
    setDraftEnd(day);setPickingEnd(false);
  }
  function exportCsv() {
    const headers=["RequestID",t("usage.requestContent"),t("usage.operation"),t("credits.ledger.model"),t("credits.ledger.credits")];
    const csv=usageCsv(headers,filtered.map(c=>[c.id,c.modelInput,operation(c),c.model,c.credits.toFixed(2)]));
    try {
      const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
      const a=document.createElement("a");a.href=url;a.download=`memmy-usage-${tab}-${start}-${end}.csv`;document.body.append(a);a.click();a.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      setExportStatus(t("usage.exported",{count:filtered.length}));
    } catch {setExportStatus(t("usage.exportFailed"));}
  }
  return <section className={styles.section} aria-label={t("credits.ledger.title")}>
    <h2>{t("credits.ledger.title")}</h2>
    <div className={styles.tabs} role="tablist" aria-label={t("usage.category")}>
      {(["agent","memory"] as const).map(value=><button id={`usage-tab-${value}`} key={value} role="tab" aria-selected={tab===value} aria-controls="usage-list" tabIndex={tab===value?0:-1} onClick={()=>{setTab(value);reset();}} onKeyDown={e=>{
        if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();const next=e.key==="Home"?"agent":e.key==="End"?"memory":value==="agent"?"memory":"agent";setTab(next);reset();document.getElementById(`usage-tab-${next}`)?.focus();}
      }}>{t(value==="agent"?"usage.agent":"usage.memory")}</button>)}
    </div>
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.presets} role="group" aria-label={t("usage.dateRange")}>
          {(["today","7","30"] as const).map(value=><button key={value} aria-pressed={span===value} onClick={()=>{setSpan(value);setCustomOpen(false);reset();}}>{t(value==="today"?"credits.ledger.today":value==="7"?"credits.ledger.week":"credits.ledger.month")}</button>)}
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" className={styles.dateTrigger} onClick={refreshUsage} aria-label={t("usage.refresh")} title={t("usage.refresh")}><RefreshCw size={14}/></button>
          <button type="button" ref={calendarTriggerRef} className={styles.dateTrigger} aria-label={t("usage.chooseDate")} aria-expanded={customOpen} aria-controls="usage-date-calendar" onClick={toggleCalendar}><CalendarDays size={14} aria-hidden="true" />{start} – {end}</button>
          <button type="button" className={styles.dateTrigger} disabled={!filtered.length} onClick={exportCsv}><Download size={14}/>{t("usage.export")}</button>
        </div>
        {customOpen && <div ref={calendarRef} id="usage-date-calendar" className={styles.calendarPopover} role="dialog" aria-label={t("usage.chooseDate")}>
          <div className={styles.calendarMonths}>
            {([calendarMonth,addMonth(calendarMonth,1)] as const).map((month,index)=><CalendarMonth key={`${month.getFullYear()}-${month.getMonth()}`} month={month} now={now} start={draftStart} end={draftEnd} language={language} onMonthChange={next=>setCalendarMonth(index===0?next:addMonth(next,-1))} onNavigate={offset=>setCalendarMonth(current=>addMonth(current,offset))} onSelectDay={selectCalendarDay}/>)}
          </div>
          <div className={styles.calendarFooter}><span aria-live="polite">{draftStart} – {draftEnd||"…"}</span><Button size="sm" variant="secondary" disabled={!draftValid} onClick={()=>{setCustom({start:draftStart,end:draftEnd});setSpan("custom");setCustomOpen(false);reset();}}>{t("usage.apply")}</Button></div>
        </div>}
      </div>
      <div className={styles.exportStatus} role="status">{exportStatus}</div>
      <div role="tabpanel" id="usage-list" aria-labelledby={`usage-tab-${tab}`} className={styles.tableScroll}>
        <table className={styles.table}><thead><tr><th>{t(tab==="agent"?"credits.ledger.time":"usage.date")}</th><th>{t(tab==="agent"?"usage.request":"usage.operation")}</th><th>{t("credits.ledger.model")}</th><th className={styles.amount}>{t("credits.ledger.credits")}</th></tr></thead>
          <tbody>{visible.map(row=><tr key={row.id}><td className={styles.time}>{dateLabel(row)}</td><td>{row.source==="agent" ? <CreditRequestHover content={title(row)} requestId={row.calls[0]!.id} /> : <span>{title(row)}</span>}{row.source==="agent" && <small className={styles.rowRequestId}>{row.calls[0]!.id}</small>}{row.source==="agent" && row.status==="interrupted" && <small className={styles.state}>{t(`usage.status.${row.status}`)}</small>}</td><td className={styles.model}>{model(row)}</td><td className={styles.amount}>{number(row.credits)}</td></tr>)}</tbody>
        </table>
        {!visible.length && <p className={styles.empty}>{t("credits.ledger.empty")}</p>}
      </div>
      <Pagination total={rows.length} page={currentPage} size={size} setPage={setPage} setSize={n=>{setSize(n);setPage(1);}}/>
    </div>

  </section>;
}
