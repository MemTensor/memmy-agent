import {PanelVisibilityContext} from "../panel-visibility.js";
// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {I18nProvider} from "../../../i18n/i18n-provider.js";
import {LogsSubPageView} from "../logs-sub-page.js";
import {UserMemoriesSubPage} from "../user-memories-sub-page.js";
import {SkillsSubPageView} from "../skills-sub-page.js";
import {createMemoryRuntimeClientStub,panelItemsOutput,memoryDetailFixture,skillPanelDetailFixture} from "./fixtures.js";

const at="2026-10-30T00:00:00Z";
const log={id:1,toolName:"memory_search" as const,inputJson:'{"query":"restored log query"}',outputJson:"{}",durationMs:1,success:true,calledAt:at,detailAvailable:true};
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.restoreAllMocks());
it.each(["log","user"])("removes the extra %s retry control and recovers through close/reopen",async kind=>{
 const container=document.createElement("div"),root=createRoot(container);
 const read=vi.fn().mockRejectedValueOnce(new Error("temporary timeout"));
 const item={...memoryDetailFixture.item,metadata:{fullContentAvailable:true},summary:"summary only"};
 const client=createMemoryRuntimeClientStub({listPanelItems:async()=>panelItemsOutput([item]),getPanelMemory:read,getPanelLogDetail:read});
 const view=kind==="user"?<UserMemoriesSubPage client={client}/>:<LogsSubPageView client={client} state={{status:"ready",data:{logs:[log],total:1,limit:20,offset:0,serverTime:at}}} tool="" sourceAgent="" onToolChange={()=>{}} onSourceAgentChange={()=>{}} onPageChange={()=>{}} onRefresh={()=>{}} onOpenDetail={()=>{}}/>;
 const open=()=>container.querySelector<HTMLButtonElement>(kind==="user"?".memory-card":".memory-log-card__button")!.click();
 try{
  await act(async()=>root.render(<I18nProvider language="zh-CN">{view}</I18nProvider>));
  await act(async()=>open());
  expect(container.textContent).toContain("temporary timeout");
  expect(container.textContent).not.toContain("继续读取内容");
  expect(read.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  await act(async()=>kind==="user"?container.querySelector<HTMLButtonElement>(".memory-drawer__close")!.click():open());
  expect(read.mock.calls[0]![1].aborted).toBe(true);
  read.mockResolvedValue(kind==="user"?{...memoryDetailFixture,item:{...item,body:"restored user body"}}:{log,serverTime:at});
  await act(async()=>open());
  expect(container.textContent).toContain(kind==="user"?"restored user body":"restored log query");
  expect(container.textContent).not.toContain("继续读取内容");
  expect(read).toHaveBeenCalledTimes(2);
 }finally{await act(async()=>root.unmount());}
});

it("keeps timeline pagination styled inside its card through loading, failure, retry and completion",async()=>{
 const container=document.createElement("div"),root=createRoot(container),detail=skillPanelDetailFixture;
 const logs=Array.from({length:20},(_,i)=>({...log,id:i+1,outputJson:JSON.stringify({skillId:detail.item.id,kind:"crystallized",summary:`entry ${i}`})}));
 let rejectNext!:(error:Error)=>void;
 const read=vi.fn().mockResolvedValueOnce({logs,nextCursor:"next",serverTime:at})
  .mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectNext=reject;}))
  .mockResolvedValueOnce({logs:[{...logs[0],id:21}],serverTime:at});
 const client=createMemoryRuntimeClientStub({listPanelLogs:read});
 const button=()=>Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(x=>x.textContent==="继续读取内容");
 try{
  await act(async()=>root.render(<I18nProvider language="zh-CN"><SkillsSubPageView client={client} state={{status:"ready",data:panelItemsOutput([detail.item])}} detail={{status:"ready",data:{detail,timeline:[]}}} query="" onQueryChange={()=>{}} onSearch={()=>{}} onPageChange={()=>{}} onRefresh={()=>{}} onOpenSkill={()=>{}} onDeleteSkill={async()=>{}} onCloseSkill={()=>{}} onOpenMemoryReference={()=>{}}/></I18nProvider>));
  const card=button()!.closest(".memory-detail-card")!;
  expect(card.querySelector(".memory-detail-card__label")?.textContent).toContain("时间线");
  expect(card.querySelectorAll(".memory-skill-timeline__item")).toHaveLength(20);
  expect(button()!.classList.contains("memory-skill-editor__button")).toBe(true);
  expect(card.lastElementChild).toBe(button());
  await act(async()=>button()!.click());expect(button()!.disabled).toBe(true);
  await act(async()=>rejectNext(new Error("page timeout")));
  expect(card.querySelector('[role="alert"]')?.textContent).toBe("page timeout");expect(button()!.disabled).toBe(false);
  await act(async()=>button()!.click());
  expect(read.mock.calls.map(call=>call[0].cursor)).toEqual([undefined,"next","next"]);
  expect(card.querySelectorAll(".memory-skill-timeline__item")).toHaveLength(21);
  expect(button()).toBeUndefined();expect(card.querySelector('[role="alert"]')).toBeNull();
  expect(card.nextElementSibling?.textContent).toContain("SKILL.md");
 }finally{await act(async()=>root.unmount());}
});

it("cancels a timeline page while hidden and revalidates on return",async()=>{
 const container=document.createElement("div"),root=createRoot(container),detail=skillPanelDetailFixture;
 const logs=Array.from({length:20},(_,i)=>({...log,id:i+1,outputJson:JSON.stringify({skillId:detail.item.id,kind:"crystallized",summary:`entry ${i}`})}));
 const read=vi.fn().mockResolvedValueOnce({logs,nextCursor:"next",serverTime:at})
   .mockImplementationOnce((_input,signal:AbortSignal)=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")))))
   .mockResolvedValue({logs:[],serverTime:at});
 const client=createMemoryRuntimeClientStub({listPanelLogs:read});
 const render=(visible:boolean)=>root.render(<I18nProvider language="zh-CN"><PanelVisibilityContext.Provider value={visible}><SkillsSubPageView client={client} state={{status:"ready",data:panelItemsOutput([detail.item])}} detail={{status:"ready",data:{detail,timeline:[]}}} query="" onQueryChange={()=>{}} onSearch={()=>{}} onPageChange={()=>{}} onRefresh={()=>{}} onOpenSkill={()=>{}} onDeleteSkill={async()=>{}} onCloseSkill={()=>{}} onOpenMemoryReference={()=>{}}/></PanelVisibilityContext.Provider></I18nProvider>);
 try{
  await act(async()=>render(true));
  await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="继续读取内容")!.click());
  await act(async()=>render(false));expect(read.mock.calls[1]![1].aborted).toBe(true);
  await act(async()=>render(true));expect(read.mock.calls.map(call=>call[0].cursor)).toEqual([undefined,"next",undefined]);
  expect(container.querySelectorAll(".memory-skill-timeline__item")).toHaveLength(0);expect(container.querySelector('[role="alert"]')).toBeNull();
 }finally{await act(async()=>root.unmount());}
});
