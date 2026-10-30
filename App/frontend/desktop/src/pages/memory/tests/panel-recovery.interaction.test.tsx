// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpMemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { PoliciesSubPage } from "../policies-sub-page.js";
import { memoryListItemFixture } from "./fixtures.js";

const at = "2026-10-29T00:00:00Z";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("recovers initial creation, paging and refresh after a single 503 without manual retry", async () => {
  vi.useFakeTimers();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  let fail = "create", serial = 0;
  const operations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); operations.push(body.op);
    if (body.op === fail) { fail = ""; return new Response("{}",{status:503}); }
    const page=body.page??1;
    const result=body.op==="check" ? {viewId:body.viewId,instanceId:"instance",safety:"safe",updated:false,serverTime:at}
      : body.op==="release" ? {ok:true}
      : {viewId:body.op==="create"?`view-${++serial}`:body.viewId,instanceId:"instance",safety:"safe",createdAt:at,serverTime:at,
        page,pageSize:20,total:60,totalPages:3,hasNext:page<3,hasPrev:page>1,items:[{...memoryListItemFixture,summary:`page ${page}`,generatedTitle:`page ${page}`,title:`page ${page}`} ]};
    return new Response(JSON.stringify(result));
  }));
  const client=createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const current=()=>Number(container.querySelector<HTMLInputElement>(".memory-pagination__input")?.value);
  try {
    await act(async()=>root.render(<AppStateProvider><I18nProvider language="en-US"><PoliciesSubPage client={client} onOpenMemoryReference={()=>{}} /></I18nProvider></AppStateProvider>));
    await act(async()=>vi.advanceTimersByTimeAsync(0));
    expect(operations.filter(x=>x==="create")).toHaveLength(1);
    expect(container.querySelector("input[type=search]")).not.toBeNull();
    expect(container.querySelector(".memory-list")).toBeNull();
    await act(async()=>vi.advanceTimersByTimeAsync(250));
    expect(current()).toBe(1);expect(container.textContent).toContain("page 1");
    fail="page";
    await act(async()=>container.querySelectorAll<HTMLButtonElement>(".memory-pagination__button")[1]!.click());
    await act(async()=>vi.advanceTimersByTimeAsync(250));
    expect(current()).toBe(2);expect(container.textContent).toContain("page 2");
    fail="create";
    await act(async()=>container.querySelector<HTMLButtonElement>(".memory-refresh-button")!.click());
    await act(async()=>vi.advanceTimersByTimeAsync(250));
    expect(current()).toBe(1);expect(container.textContent).toContain("page 1");
    expect(operations.filter(x=>x==="create")).toHaveLength(4);
    expect(operations.filter(x=>x==="page")).toHaveLength(2);
    expect(container.textContent).not.toContain("status 503");
  } finally {await act(async()=>root.unmount());container.remove();}
});
it("stops an initial create retry when hidden and starts a fresh read on return",async()=>{
  vi.useFakeTimers();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);
  const fetch=vi.fn(async()=>new Response("{}",{status:503}));vi.stubGlobal("fetch",fetch);
  const client=createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
  const container=document.createElement("div"),root=createRoot(container);
  try{
    await act(async()=>root.render(<AppStateProvider><I18nProvider language="en-US"><PoliciesSubPage client={client} onOpenMemoryReference={()=>{}} /></I18nProvider></AppStateProvider>));
    await act(async()=>vi.advanceTimersByTimeAsync(0));expect(fetch).toHaveBeenCalledTimes(1);
    await act(async()=>{hidden.mockReturnValue(true);document.dispatchEvent(new Event("visibilitychange"));});
    await act(async()=>vi.advanceTimersByTimeAsync(10_000));expect(fetch).toHaveBeenCalledTimes(1);
    await act(async()=>{hidden.mockReturnValue(false);document.dispatchEvent(new Event("visibilitychange"));});
    await act(async()=>vi.advanceTimersByTimeAsync(0));expect(fetch).toHaveBeenCalledTimes(2);
  }finally{await act(async()=>root.unmount());}
});
