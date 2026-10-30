// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ThreadTabPreview } from "../agent-thread-panel-preview.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });
async function mount(fetchFn: typeof fetch, options: { name?: string; path?: string; workspaceRoot?: string } = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); cleanup = () => act(() => root.unmount());
  await act(async () => {
    root.render(<I18nProvider language="zh-CN"><ThreadTabPreview tab={{id:"preview",type:"file",name:options.name ?? "raw.json",path:options.path,url:"https://fixture.test/raw.json"}}
      context={{artifactClient:null,agentClient:null,sessionScope:null,environment:null,workspaceRoot:options.workspaceRoot ?? null,fetchFn}} /></I18nProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  return container;
}
describe("raw text side panel", () => {
  it("loads large files in bounded ranges and navigates to their raw tail", async () => {
    const raw = '{"n":9007199254740993,"body":"' + '中🙂'.repeat(450000) + '","tail":9007199254740993}';
    const bytes = new TextEncoder().encode(raw);
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      const start = Number(match[1]); const end = Math.min(Number(match[2]), bytes.length-1);
      return new Response(bytes.slice(start,end+1).buffer, {status:206, headers:{"content-range":`bytes ${start}-${end}/${bytes.length}`}});
    });
    const container = await mount(fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
    const first = container.querySelector('pre')!.textContent!;
    expect(first).not.toContain('\uFFFD'); expect(first.length).toBeLessThan(262145);
    const last = [...container.querySelectorAll('button')].find(button => button.textContent === '末尾')!;
    await act(async () => { last.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('pre')!.textContent).toContain('"tail":9007199254740993}');
    expect(container.querySelector('pre')!.textContent).not.toContain('\uFFFD');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each(["empty.txt", "empty.json", "empty.ts"])("opens readable empty %s in the normal preview", async (name) => {
    const fetchFn = vi.fn(async () => new Response(null, {status:416, headers:{"content-range":"bytes */0"}}));
    const container = await mount(fetchFn as typeof fetch, {name});
    expect(container.textContent).not.toContain("文件已移动、删除或无法访问");
    expect(container.querySelector(".thread-preview__code")).not.toBeNull();
    expect(container.querySelector(".thread-preview__text-pager")).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["empty.txt", "empty.json", "empty.ts"])("opens empty %s in the workspace editor and saves edits", async (name) => {
    const writeWorkspaceFile = vi.fn(async () => undefined);
    Object.defineProperty(window, "memmy", {configurable:true, value:{platform:"darwin",writeWorkspaceFile}});
    const container = await mount(vi.fn(async () => new Response(null, {status:416,headers:{"content-range":"bytes */0"}})) as typeof fetch,
      {name, path:`/repo/${name}`, workspaceRoot:"/repo"});
    const field = container.querySelector("textarea");
    expect(field).not.toBeNull();
    expect(field!.value).toBe("");
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value")!.set!.call(field,"new content");
      field!.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async () => { field!.dispatchEvent(new KeyboardEvent("keydown",{key:"s",metaKey:true,bubbles:true})); });
    expect(writeWorkspaceFile).toHaveBeenCalledWith("/repo",`/repo/${name}`,"new content");
  });

  it("keeps a valid nonempty 206 response in the normal preview", async () => {
    const raw = '{"n":9007199254740993}';
    const fetchFn = vi.fn(async () => new Response(raw, {status:206,headers:{"content-range":`bytes 0-${raw.length-1}/${raw.length}`}}));
    const container = await mount(fetchFn as typeof fetch);
    expect(container.textContent).toContain(raw);
    expect(container.querySelector(".thread-preview__code")).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["bytes */12", "bytes */", null])("rejects 416 with nonempty or missing length metadata %s", async (contentRange) => {
    const container = await mount(vi.fn(async () => new Response(null,{status:416,headers:contentRange ? {"content-range":contentRange} : {}})) as typeof fetch);
    expect(container.textContent).toContain("文件已移动、删除或无法访问");
    expect(container.querySelector(".thread-preview__code")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("does not turn a later range failure into an empty file", async () => {
    const bytes = new TextEncoder().encode("x".repeat(3*1024*1024));
    const fetchFn = vi.fn(async (_url:any,init:any) => {
      const start = Number(/bytes=(\d+)-/.exec(init.headers.Range)![1]);
      return start === 0
        ? new Response(bytes.slice(0,262147).buffer,{status:206,headers:{"content-range":`bytes 0-262146/${bytes.length}`}})
        : new Response(null,{status:416,headers:{"content-range":"bytes */0"}});
    });
    const container = await mount(fetchFn as typeof fetch);
    const original = container.querySelector("pre")!.textContent;
    const last = [...container.querySelectorAll("button")].find(button=>button.textContent==="末尾")!;
    await act(async () => {last.click(); await new Promise(resolve=>setTimeout(resolve,10));});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("当前会话无法读取这个文件");
    expect(container.querySelector("pre")!.textContent).toBe(original);
  });

  it("keeps short raw JSON integers in the preview", async () => {
    const container = await mount(vi.fn(async () => new Response(' {"n":9007199254740993,  "x":1}  ')) as typeof fetch);
    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
  });
  it("reports a removed file instead of rendering a fake preview", async () => {
    const container = await mount(vi.fn(async () => new Response('not found',{status:404})) as typeof fetch);
    expect(container.textContent).toContain('文件已移动、删除或无法访问');
    expect(container.querySelector('pre')).toBeNull();
  });
});
