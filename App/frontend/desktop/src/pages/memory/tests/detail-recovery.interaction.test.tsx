// @vitest-environment happy-dom
import {PanelVisibilityContext} from "../panel-visibility.js";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {createHttpMemoryRuntimeClient} from "../../../api/memory-runtime-client.js";
import {MemoriesSubPage} from "../memories-sub-page.js";
import {AppStateProvider} from "../../../state/app-state.js";
import {I18nProvider} from "../../../i18n/i18n-provider.js";
import {memoryDetailFixture,panelItemsOutput} from "./fixtures.js";
import {clearMemoryPanelCache} from "../memory-panel-cache.js";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();clearMemoryPanelCache();});
it.each(["failure","close","late","hidden"])("detail cancellation and no stacked frontend retries: %s",async scenario=>{
 vi.useFakeTimers();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);
 const detail={...memoryDetailFixture,item:{...memoryDetailFixture.item,body:"unique recovered detail",summary:"unique recovered detail"}};
 let count=0,finish:((response:Response)=>void)|undefined;
 const fetch=vi.fn(async()=>{
   count++;
   if(scenario!=="failure")return await new Promise<Response>(resolve=>{finish=resolve;});
   return new Response("{}",{status:503});
 });vi.stubGlobal("fetch",fetch);
 const client=createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
 client.listPanelItems=async()=>panelItemsOutput([memoryDetailFixture.item]);client.checkPanelView=async()=>({updated:false});
 const container=document.createElement("div"),root=createRoot(container);
 try{
  await act(async()=>root.render(<AppStateProvider><I18nProvider language="en-US"><MemoriesSubPage client={client} openRequest={{id:detail.item.id,requestId:1}}/></I18nProvider></AppStateProvider>));
  expect(count).toBe(1);
  if(scenario==="close" || scenario==="late") await act(async()=>container.querySelector<HTMLButtonElement>(".memory-drawer__close")!.click());
  if(scenario==="hidden") await act(async()=>{hidden.mockReturnValue(true);document.dispatchEvent(new Event("visibilitychange"));});
  if(finish) await act(async()=>finish!(new Response(JSON.stringify(detail))));
  await act(async()=>vi.advanceTimersByTimeAsync(5000));
  if(scenario==="failure") {expect(count).toBe(1);expect(container.textContent).toContain("503");}
  else {expect(count).toBe(1);expect(container.textContent).not.toContain("unique recovered detail");}
 }finally{await act(async()=>root.unmount());}
});

it.each(["subpage", "document", "deleted", "redacted", "close", "new selection"])("revalidates the selected detail after interruption: %s", async scenario => {
 vi.useFakeTimers();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);
 const detail={...memoryDetailFixture,item:{...memoryDetailFixture.item,body:"fresh validated body",summary:"fresh validated body"}};
 let finishOld!:(value:typeof detail)=>void;
 let oldSignal:AbortSignal|undefined;
 const getPanelMemory=vi.fn(async (_id:string,signal?:AbortSignal)=>{
  if(getPanelMemory.mock.calls.length===1){oldSignal=signal;return new Promise<typeof detail>(resolve=>{finishOld=resolve;});}
  if(scenario==="deleted" || scenario==="redacted")throw new Error("detail unavailable");
  return detail;
 });
 const client=createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
 client.getPanelMemory=getPanelMemory;client.listPanelItems=async()=>panelItemsOutput([memoryDetailFixture.item]);client.checkPanelView=async()=>({updated:false});
 const container=document.createElement("div"),root=createRoot(container);
 const render=(visible:boolean,id=detail.item.id,requestId=1)=>root.render(<AppStateProvider><I18nProvider language="en-US"><PanelVisibilityContext.Provider value={visible}><MemoriesSubPage client={client} openRequest={{id,requestId}}/></PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>);
 try{
  await act(async()=>render(true));expect(getPanelMemory).toHaveBeenCalledTimes(1);
  if(scenario==="close")await act(async()=>container.querySelector<HTMLButtonElement>(".memory-drawer__close")!.click());
  if(scenario==="document")await act(async()=>{hidden.mockReturnValue(true);document.dispatchEvent(new Event("visibilitychange"));});
  else await act(async()=>render(false));
  expect(oldSignal?.aborted).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(60_000));expect(getPanelMemory).toHaveBeenCalledTimes(1);
  if(scenario==="document")await act(async()=>{hidden.mockReturnValue(false);document.dispatchEvent(new Event("visibilitychange"));});
  else await act(async()=>render(true));
  expect(getPanelMemory).toHaveBeenCalledTimes(scenario==="close"?1:2);
  if(scenario==="new selection"){
   await act(async()=>render(true,"another-memory",2));
   expect(getPanelMemory).toHaveBeenLastCalledWith("another-memory",expect.any(AbortSignal));
  }
  await act(async()=>finishOld({...detail,item:{...detail.item,body:"obsolete private body",summary:"obsolete private body"}}));
  expect(container.textContent).not.toContain("obsolete private body");
  if(scenario==="deleted" || scenario==="redacted")expect(container.textContent).toContain("detail unavailable");
  else if(scenario==="close")expect(container.querySelector(".memory-drawer")).toBeNull();
  else expect(container.textContent).toContain("fresh validated body");
 }finally{await act(async()=>root.unmount());}
});
