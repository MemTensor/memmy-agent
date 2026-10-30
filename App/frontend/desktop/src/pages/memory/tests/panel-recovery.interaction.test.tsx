// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpMemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { PoliciesSubPage } from "../policies-sub-page.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("does not retry a failed initial read in the frontend shared queue", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn(async () => new Response("{}", {status:503})); vi.stubGlobal("fetch", fetch);
  const client = createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"synthetic"});
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<AppStateProvider><I18nProvider language="en-US"><PoliciesSubPage client={client} onOpenMemoryReference={()=>{}} /></I18nProvider></AppStateProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("503");
  } finally { await act(async () => root.unmount()); }
});
it("keeps failed reads paused when hidden and starts a fresh read on return",async()=>{
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
