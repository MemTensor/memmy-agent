// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { createHttpMemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { OverviewSubPage } from "../overview-sub-page.js";
import { AnalyticsSubPage } from "../analytics-sub-page.js";
import { MemoriesSubPage } from "../memories-sub-page.js";
import { createMemoryRuntimeClientStub, memoryListItemFixture, panelOverviewFixture, panelAnalysisFixture } from "./fixtures.js";

describe("user feedback UI", () => {
  it.each(["overview", "analysis"])("keeps %s ready and omits the internal statistics timestamp", async section => {
    const container = document.createElement("div");
    const pageRoot = createRoot(container);
    const generatedAt = "2026-10-29T00:00:00.123Z";
    const client = createMemoryRuntimeClientStub({getPanelStats:async()=>({status:"ready",generatedAt,serverTime:generatedAt,data:{overview:panelOverviewFixture,analysis:panelAnalysisFixture}})});
    try {
      await act(async()=>pageRoot.render(<I18nProvider language="zh-CN">{section === "overview" ? <OverviewSubPage client={client} onNavigate={()=>{}}/> : <AnalyticsSubPage client={client}/>}</I18nProvider>));
      expect(container.querySelector(".memory-page-content-title")).not.toBeNull();
      expect(container.textContent).not.toContain(generatedAt);
      expect(container.textContent).not.toContain("统计生成时间");
    } finally {await act(async()=>pageRoot.unmount());}
  });

  it("loads a selected producer immediately, resets pagination and refreshes the selected filter", async () => {
    vi.useFakeTimers();
    const container=document.createElement("div"), root=createRoot(container);
    const requests: Array<{op:string;filter?:{sourceAgent?:string}}> = [];
    let serial=0;
    vi.stubGlobal("fetch", vi.fn(async (_url:unknown, init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)); requests.push(body);
      const result=body.op === "release" ? {ok:true} : body.op === "check"
        ? {viewId:body.viewId,instanceId:"synthetic",safety:"safe",updated:false,serverTime:"2026-10-29T00:00:00Z"}
        : {viewId:`view-${++serial}`,instanceId:"synthetic",safety:"safe",createdAt:"2026-10-29T00:00:00Z",serverTime:"2026-10-29T00:00:00Z",page:1,pageSize:20,total:1,totalPages:1,hasNext:false,hasPrev:false,
          items:[{...memoryListItemFixture,id:`producer-${body.filter?.sourceAgent ?? "all"}`,title:`visible-${body.filter?.sourceAgent ?? "all"}`,generatedTitle:`visible-${body.filter?.sourceAgent ?? "all"}`,metadata:{source:body.filter?.sourceAgent ?? "memmy"}}]};
      return new Response(JSON.stringify(result));
    }));
    const client=createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
    try {
      await act(async()=>root.render(<AppStateProvider><I18nProvider language="en-US"><MemoriesSubPage client={client}/></I18nProvider></AppStateProvider>));
      await act(async()=>vi.advanceTimersByTimeAsync(0));
      await act(async()=>container.querySelector<HTMLButtonElement>(".memory-source-filter__button")!.click());
      const codex=Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(button=>button.textContent?.includes("Codex"))!;
      await act(async()=>codex.click());
      expect(requests.filter(x=>x.op === "create").at(-1)?.filter?.sourceAgent).toBe("codex");
      expect(container.textContent).toContain("visible-codex");
      expect(container.textContent).not.toContain("visible-all");
      await act(async()=>container.querySelector<HTMLButtonElement>(".memory-refresh-button")!.click());
      expect(requests.filter(x=>x.op === "create").at(-1)?.filter?.sourceAgent).toBe("codex");
      expect(container.querySelector<HTMLInputElement>(".memory-pagination__input")?.value ?? "1").toBe("1");
    } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();vi.useRealTimers();}
  });
});
