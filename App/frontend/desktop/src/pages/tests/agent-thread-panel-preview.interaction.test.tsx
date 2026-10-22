// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentArtifactClient } from "../agent-message-content.js";
import { readPreviewResponse, THREAD_PDF_PREVIEW_MAX_BYTES, ThreadTabPreview } from "../agent-thread-panel-preview.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });
async function mount(fetchFn: typeof fetch, options: {
  name?: string; path?: string; url?: string; workspaceRoot?: string; artifactClient?: AgentArtifactClient | null;
} = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); cleanup = () => act(() => root.unmount());
  await act(async () => {
    root.render(<I18nProvider language="zh-CN"><ThreadTabPreview tab={{id:"preview",type:"file",name:options.name ?? "raw.json",path:options.path,url:options.url ?? "https://fixture.test/raw.json"}}
      context={{artifactClient:options.artifactClient ?? null,agentClient:null,sessionScope:null,environment:null,workspaceRoot:options.workspaceRoot ?? null,fetchFn}} /></I18nProvider>);
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

describe("bounded attachment previews", () => {
  it("rejects an oversized Content-Length without reading the response body", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const response = {
      headers: new Headers({ "content-length": "6" }),
      body: { cancel, getReader },
    } as unknown as Response;
    await expect(readPreviewResponse(response, 5)).resolves.toBeNull();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, "1", "invalid"])("enforces the stream limit with Content-Length=%s", async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.enqueue(new Uint8Array([5]));
      },
      cancel,
    });
    const response = new Response(body, { headers: length === null ? undefined : { "content-length": length } });
    await expect(readPreviewResponse(response, 4)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("accepts exactly the limit and decodes a Chinese character split across chunks", async () => {
    const bytes = new TextEncoder().encode("ab中");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, -1));
        controller.enqueue(bytes.slice(-1));
        controller.close();
      },
    }));
    const blob = await readPreviewResponse(response, bytes.byteLength);
    expect(await blob?.text()).toBe("ab中");
  });

  it("uses the independent PDF limit before creating an object URL", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(THREAD_PDF_PREVIEW_MAX_BYTES + 1) }),
      body: { cancel, getReader },
    } as unknown as Response));
    const container = await mount(fetchFn as typeof fetch, { name: "large.pdf" });
    expect(container.textContent).toContain("文件较大，暂不在侧栏中预览");
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts the old preview request when switching files and ignores its result", async () => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); cleanup = () => act(() => root.unmount());
    let oldSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("old")) {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          oldSignal?.addEventListener("abort", () => resolve(new Response("OLD")), { once: true });
        });
      }
      return Promise.resolve(new Response("NEW"));
    }) as typeof fetch;
    const context = { artifactClient:null,agentClient:null,sessionScope:null,environment:null,workspaceRoot:null,fetchFn };
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ThreadTabPreview tab={{ id:"old",type:"file",name:"old.txt",url:"https://fixture.test/old" }} context={context} /></I18nProvider>);
    });
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ThreadTabPreview tab={{ id:"new",type:"file",name:"new.txt",url:"https://fixture.test/new" }} context={context} /></I18nProvider>);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(oldSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("NEW");
    expect(container.textContent).not.toContain("OLD");
  });
});

describe("side panel attachment downloads", () => {
  it("saves a URL-only PPTX through the native bridge", async () => {
    const saveFile = vi.fn(async () => ({ canceled: false as const, filePath: "/tmp/deck.pptx", bytes: 4 }));
    Object.defineProperty(window, "memmy", { configurable: true, value: { saveFile } });
    const container = await mount(vi.fn() as unknown as typeof fetch, { name: "deck.pptx", url: "https://fixture.test/deck.pptx" });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="下载文件"]')!.click(); await Promise.resolve(); });
    expect(saveFile).toHaveBeenCalledWith({ url: "https://fixture.test/deck.pptx", name: "deck.pptx" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("文件已保存");
  });

  it("keeps cancellation quiet and shows native HTTP failures", async () => {
    const saveFile = vi.fn()
      .mockResolvedValueOnce({ canceled: true as const })
      .mockRejectedValueOnce(new Error("file download failed: 404"));
    Object.defineProperty(window, "memmy", { configurable: true, value: { saveFile } });
    const container = await mount(vi.fn() as unknown as typeof fetch, { name: "deck.pptx", url: "https://fixture.test/deck.pptx" });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="下载文件"]')!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(container.textContent).not.toContain("文件已保存");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("file download failed: 404");
  });

  it("re-resolves local attachment URLs before saving", async () => {
    const saveFile = vi.fn(async () => ({ canceled: true as const }));
    Object.defineProperty(window, "memmy", { configurable: true, value: { saveFile } });
    const resolveArtifact = vi.fn(async () => ({
      ok: true as const, path: "/work/fresh.pptx", name: "fresh.pptx", kind: "file" as const,
      media_url: "http://127.0.0.1:18980/api/media/fresh",
    }));
    const artifactClient: AgentArtifactClient = {
      resolveArtifact,
      openArtifact: vi.fn(async () => undefined),
      revealArtifact: vi.fn(async () => undefined),
    };
    const container = await mount(vi.fn() as unknown as typeof fetch, { name: "old.pptx", path: "/work/old.pptx", artifactClient });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="下载文件"]')!.click(); await Promise.resolve(); });
    expect(resolveArtifact).toHaveBeenCalledWith("/work/old.pptx");
    expect(saveFile).toHaveBeenCalledWith({ url: "http://127.0.0.1:18980/api/media/fresh", name: "fresh.pptx" });
  });
});
