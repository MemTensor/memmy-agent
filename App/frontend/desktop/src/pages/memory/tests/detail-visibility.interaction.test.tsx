// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {PanelVisibilityContext} from "../panel-visibility.js";
import {UserMemoriesSubPage} from "../user-memories-sub-page.js";
import {SkillsSubPage} from "../skills-sub-page.js";
import {WorldModelSubPage} from "../world-model-sub-page.js";
import {LogsSubPage} from "../logs-sub-page.js";
import {TasksSubPage} from "../tasks-sub-page.js";
import {AppStateProvider} from "../../../state/app-state.js";
import {I18nProvider} from "../../../i18n/i18n-provider.js";
import {createMemoryRuntimeClientStub,memoryDetailFixture,skillPanelDetailFixture,panelItemsOutput} from "./fixtures.js";
import {mockMemoryDetails} from "./memory-runtime-fixtures.js";
import {clearMemoryPanelCache} from "../memory-panel-cache.js";
import {ApiRequestError} from "../../../api/http.js";
import type {GetMemoryOutput,PanelTasksOutput} from "@memmy/local-api-contracts";
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();clearMemoryPanelCache();});
it.each(["user","skill","world"] as const)("revalidates %s detail after hiding, rejects stale responses and closes safely",async kind=>{
 const base=kind==="skill"?skillPanelDetailFixture:kind==="world"?mockMemoryDetails["world_model:memory-world-1"]!:memoryDetailFixture;
 const item={...base.item,metadata:{...base.item.metadata,fullContentAvailable:true}};
 let finishOld!:(data:GetMemoryOutput)=>void;
 const read=vi.fn((_id:string,_signal?:AbortSignal):Promise<GetMemoryOutput>=>new Promise(resolve=>{finishOld=resolve;}));
 const client=createMemoryRuntimeClientStub({getPanelMemory:read,listPanelItems:async()=>panelItemsOutput([item]),listPanelLogs:async()=>({logs:[],serverTime:base.serverTime}),checkPanelView:async()=>({updated:false})});
 const container=document.createElement("div"),root=createRoot(container);
 const render=(visible:boolean,activeClient=client)=>root.render(<AppStateProvider><I18nProvider language="en-US"><PanelVisibilityContext.Provider value={visible}>{kind==="user"?<UserMemoriesSubPage client={activeClient}/>:kind==="skill"?<SkillsSubPage client={activeClient}/>:<WorldModelSubPage client={activeClient}/>}</PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>);
 try{
  await act(async()=>render(true));await act(async()=>container.querySelector<HTMLElement>(".memory-card")!.click());
  expect(read).toHaveBeenCalledTimes(1);const oldSignal=read.mock.calls[0]![1];
  await act(async()=>render(false));expect(oldSignal?.aborted).toBe(true);
  read.mockResolvedValue({...base,item:{...item,body:"fresh validated body",summary:"fresh validated body"}});
  await act(async()=>render(true));expect(read).toHaveBeenCalledTimes(2);expect(container.textContent).toContain("fresh validated body");
  await act(async()=>finishOld({...base,item:{...item,body:"obsolete private body",summary:"obsolete private body"}}));expect(container.textContent).not.toContain("obsolete private body");
  // A second absence spans deletion/redaction; the old full body must not return.
  await act(async()=>render(false));read.mockRejectedValue(new ApiRequestError("detail unavailable",404));
  await act(async()=>render(true));expect(container.textContent).not.toContain("fresh validated body");expect(container.querySelector(".memory-drawer")).not.toBeNull();
  await act(async()=>container.querySelector<HTMLElement>(".memory-drawer__close")!.click());
  await act(async()=>render(false));await act(async()=>render(true));expect(read).toHaveBeenCalledTimes(3);expect(container.querySelector(".memory-drawer")).toBeNull();
  // Returning with a different runtime must not resurrect the old selection.
  await act(async()=>container.querySelector<HTMLElement>(".memory-card")!.click());
  await act(async()=>render(false));
  const newRead=vi.fn(async()=>base);const newClient={...client,getPanelMemory:newRead};
  await act(async()=>render(true,newClient));expect(newRead).not.toHaveBeenCalled();expect(container.querySelector(".memory-drawer")).toBeNull();

 }finally{await act(async()=>root.unmount());}
});
it("resumes expanded log on document return without reintroducing a retry button",async()=>{
 vi.useFakeTimers();const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);
 const at=memoryDetailFixture.serverTime;const log={id:1,toolName:"memory_search" as const,inputJson:"{}",outputJson:"{}",durationMs:1,success:true,calledAt:at,detailAvailable:true};
 const read=vi.fn((_id:number,signal?:AbortSignal)=>new Promise<{log:typeof log;serverTime:string}>((_resolve,reject)=>{signal?.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")));}));
 const client=createMemoryRuntimeClientStub({listPanelLogs:async()=>({logs:[log],total:1,limit:20,offset:0,serverTime:at}),getPanelLogDetail:read});
 const container=document.createElement("div"),root=createRoot(container);
 try{
  await act(async()=>root.render(<AppStateProvider><I18nProvider language="zh-CN"><LogsSubPage client={client}/></I18nProvider></AppStateProvider>));
  await act(async()=>container.querySelector<HTMLElement>(".memory-log-card__button")!.click());
  await act(async()=>{hidden.mockReturnValue(true);document.dispatchEvent(new Event("visibilitychange"));});expect(read.mock.calls[0]![1]?.aborted).toBe(true);
  read.mockResolvedValue({log:{...log,inputJson:JSON.stringify({query:"restored log query"})},serverTime:at});
  await act(async()=>{hidden.mockReturnValue(false);document.dispatchEvent(new Event("visibilitychange"));});
  expect(read).toHaveBeenCalledTimes(2);expect(container.textContent).toContain("restored log query");expect(container.textContent).not.toContain("继续读取内容");
 }finally{await act(async()=>root.unmount());}
});
it("restarts an interrupted task open even before its drawer existed",async()=>{
 const at=memoryDetailFixture.serverTime;const output:PanelTasksOutput={tasks:[{id:"task",episode:{id:"task",title:"recovered task",sessionId:"session",status:"closed",turnCount:1},memoryIds:[],turns:[],updatedAt:at}],page:1,pageSize:20,total:1,totalPages:1,hasNext:false,hasPrev:false,serverTime:at};
 let finish!:(data:PanelTasksOutput)=>void;
 const read=vi.fn((_input:unknown,_signal?:AbortSignal)=>new Promise<PanelTasksOutput>(resolve=>{finish=resolve;}));
 const client=createMemoryRuntimeClientStub({listPanelTaskSummaries:async()=>output,listPanelTasks:read,checkPanelView:async()=>({updated:false})});
 const container=document.createElement("div"),root=createRoot(container);
 const render=(visible:boolean)=>root.render(<AppStateProvider><I18nProvider language="en-US"><PanelVisibilityContext.Provider value={visible}><TasksSubPage client={client} openRequest={{id:"task",requestId:1}}/></PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>);
 try{
  await act(async()=>render(true));await act(async()=>render(false));expect(read.mock.calls[0]![1]?.aborted).toBe(true);
  read.mockResolvedValue(output);await act(async()=>render(true));expect(read).toHaveBeenCalledTimes(2);expect(container.querySelector(".memory-drawer")).not.toBeNull();
  await act(async()=>finish({...output,tasks:[]}));expect(container.querySelector(".memory-drawer")).not.toBeNull();
 }finally{await act(async()=>root.unmount());}
});
