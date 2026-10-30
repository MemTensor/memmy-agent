// @vitest-environment happy-dom
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
