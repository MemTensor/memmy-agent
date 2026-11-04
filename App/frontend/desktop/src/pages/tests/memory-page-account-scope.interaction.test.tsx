// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {I18nProvider} from "../../i18n/i18n-provider.js";
import {createInitialAppState} from "../../state/app-reducer.js";
import {MemoryPage} from "../memory-page.js";
const mock=vi.hoisted(()=>({state:null as ReturnType<typeof createInitialAppState>|null,client:{resetPanelView:vi.fn()}}));
vi.mock("../../app/providers.js",()=>({useApiClients:()=>({clients:{memoryRuntime:mock.client}})}));
vi.mock("../../state/app-state.js",()=>({useAppState:()=>({state:mock.state,dispatch:vi.fn()})}));
vi.mock("../../analytics/use-analytics.js",()=>({useAnalytics:()=>({track:vi.fn(),ready:false})}));
vi.mock("../memory/memories-sub-page.js",()=>({MemoriesSubPage:()=>{const [value,setValue]=useState("");return <input aria-label="local-filter" value={value} onInput={e=>setValue(e.currentTarget.value)}/>;}}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it("preserves the local page and its view when only account UID changes, but retires a replaced connection",()=>{
  mock.state=createInitialAppState();mock.state.account.userId="a";
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const render=()=>root.render(<I18nProvider language="zh-CN"><MemoryPage initialSubPage="memories"/></I18nProvider>);
  try{
    act(render);
    const input=container.querySelector<HTMLInputElement>("input[aria-label=local-filter]")!;
    act(()=>{input.value="kept local search";input.dispatchEvent(new Event("input",{bubbles:true}));});
    const resets=mock.client.resetPanelView.mock.calls.length;
    mock.state={...mock.state,account:{...mock.state.account,userId:"b"}};
    act(render);
    expect(container.querySelector("input[aria-label=local-filter]")).toBe(input);
    expect(input.value).toBe("kept local search");
    expect(mock.client.resetPanelView).toHaveBeenCalledTimes(resets);
    const oldClient=mock.client;mock.client={resetPanelView:vi.fn()};act(render);
    expect(oldClient.resetPanelView).toHaveBeenCalledTimes(resets+1);
  }finally{act(()=>root.unmount());}
});
