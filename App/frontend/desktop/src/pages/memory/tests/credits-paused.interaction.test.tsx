// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppProviders } from "../../../app/providers.js";
import { createUnavailableMemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { MemoriesSubPage } from "../memories-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => { if (root) act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("shows real paused work above search and removes the banner after recovery without removing memories", async () => {
  document.body.append(host); root = createRoot(host);
  const client = createUnavailableMemoryRuntimeClient();
  const health = await client.health();
  let paused: boolean | undefined = true;
  client.health = vi.fn(async () => ({...health, creditPaused: paused}));
  client.listPanelItems = vi.fn(async () => ({items:[{
    id:"saved-memory",kind:"trace",memoryLayer:"L1",status:"activated",title:"已完成记忆保留",summary:"已完成的内容",
    tags:[],metadata:{source:"memmy"},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1
  }],page:1,pageSize:20,total:1,totalPages:1,hasNext:false,hasPrev:false,serverTime:new Date().toISOString()}));
  await act(async () => root.render(<AppProviders><MemoriesSubPage client={client}/></AppProviders>));
  expect(host.textContent).toContain("积分不足，记忆加工已暂停");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(host.textContent).toContain("已完成的内容");
  expect(host.innerHTML.indexOf('aria-label="记忆服务暂停"')).toBeLessThan(host.innerHTML.indexOf('class="memory-toolbar"'));
  paused = false;
  await act(async () => { window.dispatchEvent(new Event("memmy:credits-refresh")); });
  expect(host.textContent).not.toContain("积分不足，记忆加工已暂停");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(host.textContent).toContain("已完成的内容");
  paused = undefined;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(host.textContent).not.toContain("积分不足，记忆加工已暂停");
});
