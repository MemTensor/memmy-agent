import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./credits-usage-ledger.module.css";

/** Hoverable request content with a copyable ID; no navigation or modal. */
export function CreditRequestHover(props: { content: string; requestId: string }) {
  const { t }=useTranslation();
  const id=useId();
  const trigger=useRef<HTMLSpanElement>(null), panel=useRef<HTMLDivElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [open,setOpen]=useState(false),[copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
  const [position,setPosition]=useState({left:0,top:0});
  function cancelHide(){if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}}
  function show(){cancelHide();setOpen(true);}
  function hideSoon(){cancelHide();timer.current=setTimeout(()=>setOpen(false),180);}
  useEffect(()=>()=>cancelHide(),[]);
  useLayoutEffect(()=>{
    if(!open || !trigger.current || !panel.current) return;
    const rect=trigger.current.getBoundingClientRect(), box=panel.current.getBoundingClientRect();
    const left=Math.max(12,Math.min(rect.left,window.innerWidth-box.width-12));
    const below=rect.bottom+6;
    const top=below+box.height<=window.innerHeight-12 ? below : Math.max(12,rect.top-box.height-6);
    setPosition({left,top});
  },[open,props.content]);
  useEffect(()=>{
    if(!open) return;
    const contains=(target:EventTarget|null)=>target instanceof Node && (trigger.current?.contains(target)||panel.current?.contains(target));
    const outside=(event:PointerEvent)=>{if(!contains(event.target)) setOpen(false);};
    const scroll=(event:Event)=>{if(!(event.target instanceof Node && panel.current?.contains(event.target))) setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape") setOpen(false);};
    const resize=()=>setOpen(false);
    window.addEventListener("pointerdown",outside);window.addEventListener("scroll",scroll,true);window.addEventListener("keydown",escape);window.addEventListener("resize",resize);
    return ()=>{window.removeEventListener("pointerdown",outside);window.removeEventListener("scroll",scroll,true);window.removeEventListener("keydown",escape);window.removeEventListener("resize",resize);};
  },[open]);
  async function copy(){
    try {await navigator.clipboard.writeText(props.requestId);setCopied(true);setFailed(false);} catch {setFailed(true);}
  }
  return <>
    <span ref={trigger} tabIndex={0} className={styles.requestText} aria-controls={open?id:undefined} onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={event=>{if(!panel.current?.contains(event.relatedTarget)) hideSoon();}} onKeyDown={event=>{if(event.key==="Tab" && !event.shiftKey && open){event.preventDefault();panel.current?.querySelector('button')?.focus();}}}>{props.content}</span>
    {open && createPortal(<div ref={panel} id={id} role="region" aria-label={t("usage.request")} className={styles.requestPopover} style={position} onMouseEnter={cancelHide} onMouseLeave={hideSoon} onFocus={cancelHide} onBlur={event=>{if(!panel.current?.contains(event.relatedTarget)&&!trigger.current?.contains(event.relatedTarget)) hideSoon();}}>
      <div className={styles.fullPrompt}>{props.content}</div>
      <div className={styles.popoverId}><span>{props.requestId}</span><button type="button" onClick={()=>void copy()} aria-label={t(copied?"usage.copied":"usage.copy")} title={t(copied?"usage.copied":"usage.copy")} onKeyDown={event=>{if(event.key==="Tab"){event.preventDefault();trigger.current?.focus();setOpen(false);}}}>{copied?<Check size={14}/>:<Copy size={14}/>}</button></div>
      {failed && <p role="status">{t("usage.copyFailed")}</p>}
    </div>,document.body)}
  </>;
}
