// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgePage } from "../src/ui/page.js";
import type { KnowledgeSettings } from "../src/types.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openFileSearch(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="搜索文件"]',
  )!;
  await act(async () => {
    trigger.click();
  });
  return container.querySelector<HTMLInputElement>(
    'input[aria-label="在知识库中搜索"]',
  )!;
}

it("creates folders and navigates with breadcrumbs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const folders = [{ id: "f1", parentId: "", name: "产品资料" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST")
        return new Response(
          JSON.stringify({
            files: [
              { id: "a1", name: "指南.pdf", status: "AVAILABLE", message: "" },
            ],
            total: 1,
            page: 1,
          }),
        );
      if (path.endsWith("/folders") && init.method !== "POST")
        return new Response(JSON.stringify({ folders }));
      if (path.endsWith("/folders") && init.method === "POST") {
        folders.push({
          id: "f2",
          parentId: String(body?.parentId ?? ""),
          name: String(body?.name ?? ""),
        });
        return new Response(JSON.stringify({ id: "f2" }));
      }
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  // 根目录：文件夹行展示在文件之前，无面包屑
  expect(container.textContent).toContain("产品资料");
  expect(container.textContent).not.toContain("个子文件夹");
  expect(container.querySelector(".mk-crumb")).toBeNull();
  expect(container.querySelector(".mk-frow-folder")).not.toBeNull();
  // 单击进入文件夹：出现面包屑与当前目录文件请求
  const folderRow = container.querySelector<HTMLElement>(".mk-frow-folder")!;
  await act(async () => {
    folderRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("产品资料");
  expect(
    calls.some(
      (call) => call.url.includes("folderId=f1") && call.url.includes("/files?"),
    ),
  ).toBe(true);
  // 目录内新建文件夹：顶栏「新建」按钮 → 行内输入 → POST parentId=f1
  const createButton = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "新建")!;
  await act(async () => {
    createButton.click();
  });
  const inlineInput =
    container.querySelector<HTMLInputElement>(".mk-row-create input")!;
  expect(inlineInput).not.toBeNull();
  await act(async () => {
    setInputValue(inlineInput, "竞品分析");
  });
  const confirmButton = [
    ...container.querySelectorAll<HTMLButtonElement>(".mk-row-create button"),
  ].find((button) => button.textContent === "创建")!;
  await act(async () => {
    confirmButton.click();
  });
  expect(
    calls.some(
      (call) =>
        call.url.endsWith("/folders") &&
        call.body?.name === "竞品分析" &&
        call.body?.parentId === "f1",
    ),
  ).toBe(true);
});

it("batch deletes selected folders and files", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let releaseDelete: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", body });
      const path = String(url);
      if (init.method === "DELETE")
        return new Promise<Response>((resolve) => {
          releaseDelete = resolve;
        });
      if (path.includes("/files?") && init.method !== "POST")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              files: [
                { id: "a1", name: "指南.pdf", status: "AVAILABLE", message: "" },
                { id: "a2", name: "报表.xlsx", status: "AVAILABLE", message: "" },
              ],
              total: 2,
              page: 1,
            }),
          ),
        );
      if (path.endsWith("/folders"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              folders: [{ id: "f1", parentId: "", name: "产品资料" }],
            }),
          ),
        );
      return Promise.resolve(new Response(JSON.stringify(state)));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  // 勾选 1 个文件夹 + 1 个文件，出现批量操作条
  const folderCheck = container.querySelector<HTMLInputElement>(
    'input[aria-label="选择文件夹 产品资料"]',
  )!;
  const fileCheck = container.querySelector<HTMLInputElement>(
    'input[aria-label="选择 指南.pdf"]',
  )!;
  await act(async () => {
    folderCheck.click();
  });
  await act(async () => {
    fileCheck.click();
  });
  const bar = container.querySelector(".mk-batchbar");
  expect(bar?.textContent).toContain("已选 2 项");
  // 打开确认弹窗并确认
  const deleteButton = [
    ...container.querySelectorAll<HTMLButtonElement>(".mk-batchbar button"),
  ].find((button) => button.textContent === "删除")!;
  await act(async () => {
    deleteButton.click();
  });
  const modal = container.querySelector<HTMLElement>(".mk-action-modal")!;
  expect(modal.textContent).toContain("1 个文件夹和 1 个文件");
  const confirmButton = [
    ...modal.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "确认删除")!;
  await act(async () => {
    confirmButton.click();
  });
  // 文件夹连带内容删除，文件逐个删除
  expect(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/folders/f1") &&
        call.body?.mode === "all",
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/bases/base-1/files/a1"),
    ),
  ).toBe(true);
  expect(container.querySelector(".mk-batchbar")).toBeNull();
  expect(container.textContent).not.toContain("产品资料");
  expect(container.textContent).not.toContain("指南.pdf");
  expect(container.textContent).toContain("报表.xlsx");
  expect(container.querySelector(".mk-modal-backdrop")).toBeNull();
  expect(releaseDelete).toBeDefined();
});

it("batch deletes a nested uploaded folder without waiting on the server", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "121212", selected: true }],
  };
  const folders = [
    { id: "lenovo", parentId: "", name: "联想" },
    { id: "docs", parentId: "lenovo", name: "知识库资料" },
    { id: "attr", parentId: "lenovo", name: "属性记忆能力更新" },
  ];
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", body });
      const path = String(url);
      if (init.method === "DELETE")
        return new Promise<Response>(() => undefined);
      if (path.includes("/files?"))
        return Promise.resolve(
          new Response(JSON.stringify({ files: [], total: 0, page: 1 })),
        );
      if (path.endsWith("/folders"))
        return Promise.resolve(new Response(JSON.stringify({ folders })));
      return Promise.resolve(new Response(JSON.stringify(state)));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  await act(async () => {
    container
      .querySelector<HTMLInputElement>('input[aria-label="选择文件夹 联想"]')!
      .click();
  });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>(".mk-batchbar button")]
      .find((button) => button.textContent === "删除")!
      .click();
  });
  const confirm = [
    ...container.querySelectorAll<HTMLButtonElement>(".mk-action-modal button"),
  ].find((button) => button.textContent === "确认删除")!;
  await act(async () => {
    confirm.click();
  });
  expect(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/folders/lenovo") &&
        call.body?.mode === "all",
    ),
  ).toBe(true);
  expect(container.querySelector(".mk-modal-backdrop")).toBeNull();
  expect(container.textContent).not.toContain("联想");
}, 2000);

it("highlights matching text in file and folder names while searching", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST")
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "a1",
                name: "属性模板管理API_Bugreporto.md",
                status: "AVAILABLE",
                message: "",
              },
              {
                id: "a2",
                name: "属性树-工程-相关api.md",
                status: "AVAILABLE",
                message: "",
              },
              {
                id: "a3",
                name: "接口约定-v2.pdf",
                status: "AVAILABLE",
                message: "",
              },
            ],
            total: 3,
            page: 1,
          }),
        );
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [{ id: "f1", parentId: "", name: "属性资料" }],
          }),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  expect(container.querySelector(".mk-hit")).toBeNull();
  const search = await openFileSearch(container);
  await act(async () => {
    setInputValue(search, "属性");
  });
  const hits = [...container.querySelectorAll(".mk-hit")];
  expect(hits.map((item) => item.textContent)).toEqual(["属性", "属性", "属性"]);
  expect(container.textContent).toContain("属性模板管理API_Bugreporto.md");
  expect(container.textContent).toContain("属性树-工程-相关api.md");
  expect(container.textContent).toContain("属性资料");
  expect(container.textContent).not.toContain("接口约定-v2.pdf");
  expect(container.querySelector("style")?.textContent).toContain(
    "color:var(--mk-accent-deep);background:var(--mk-accent-tint)",
  );
  expect(container.querySelector("style")?.textContent).toContain(
    ".mk-fsearch input{border:0;background:transparent;padding:1px 0;font-size:12.5px;width:100%;color:var(--mk-ink)}",
  );
});

it("lists nested matches in one column with a path and no extra hint", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      calls.push(path);
      if (path.includes("/files?") && init.method !== "POST") {
        if (path.includes("recursive="))
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "a1",
                  name: "属性模板管理API_Bugreporto.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "",
                },
                {
                  id: "a2",
                  name: "属性定义说明.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f1",
                },
                {
                  id: "a3",
                  name: "属性树-工程-相关api.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f2",
                },
                {
                  id: "a4",
                  name: "接口约定-v2.pdf",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "",
                },
              ],
              total: 4,
              page: 1,
            }),
          );
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "a1",
                name: "属性模板管理API_Bugreporto.md",
                status: "AVAILABLE",
                message: "",
              },
              {
                id: "a4",
                name: "接口约定-v2.pdf",
                status: "AVAILABLE",
                message: "",
              },
            ],
            total: 2,
            page: 1,
          }),
        );
      }
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [
              { id: "f1", parentId: "", name: "属性资料" },
              { id: "f2", parentId: "f1", name: "历史稿" },
              { id: "f3", parentId: "", name: "接口文档" },
              { id: "f4", parentId: "f3", name: "属性对照" },
            ],
          }),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  const search = await openFileSearch(container);
  await act(async () => {
    setInputValue(search, "属性");
  });
  expect(
    calls.some(
      (url) => url.includes("recursive=true") && !url.includes("folderId="),
    ),
  ).toBe(true);
  expect(container.textContent).toContain("属性模板管理API_Bugreporto.md");
  expect(container.textContent).toContain("属性定义说明.md");
  expect(container.textContent).toContain("属性树-工程-相关api.md");
  expect(container.textContent).toContain("属性资料 / 历史稿 /");
  expect(container.textContent).toContain("属性资料 /");
  expect(container.textContent).not.toContain("个子文件夹");
  expect(container.textContent).not.toContain("subfolders");
  expect(container.textContent).toContain("属性对照");
  expect(container.textContent).toContain("接口文档 /");
  expect(container.textContent).not.toContain("接口约定-v2.pdf");
  expect(container.textContent).not.toContain("包含当前目录及子目录");
  expect(container.textContent).not.toContain("当前目录");
  expect(container.textContent).not.toContain("子目录");
  const folderNames = [...container.querySelectorAll(".mk-frow-folder .mk-fname")].map(
    (item) => item.textContent,
  );
  const fileNames = [
    ...container.querySelectorAll(".mk-frow:not(.mk-frow-folder) .mk-fname"),
  ].map((item) => item.textContent);
  expect(folderNames[0]).toBeTruthy();
  expect(fileNames[0]).toContain("属性");
});

it("searches the whole knowledge base from a nested folder and restores it on close", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST") {
        if (path.includes("recursive="))
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "a1",
                  name: "属性定义说明.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f1",
                },
                {
                  id: "a2",
                  name: "属性对照.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f3",
                },
                {
                  id: "a3",
                  name: "会议纪要.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f2",
                },
              ],
              total: 3,
              page: 1,
            }),
          );
        return new Response(
          JSON.stringify({ files: [], total: 0, page: 1 }),
        );
      }
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [
              { id: "f1", parentId: "", name: "属性资料" },
              { id: "f2", parentId: "f1", name: "历史稿" },
              { id: "f3", parentId: "", name: "其他资料" },
            ],
          }),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  const parent = [...container.querySelectorAll<HTMLElement>(".mk-frow-folder")].find(
    (row) => row.textContent?.includes("属性资料"),
  )!;
  await act(async () => {
    parent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const nested = [...container.querySelectorAll<HTMLElement>(".mk-frow-folder")].find(
    (row) => row.textContent?.includes("历史稿"),
  )!;
  await act(async () => {
    nested.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("历史稿");
  const search = await openFileSearch(container);
  expect(container.querySelector(".mk-crumb")).toBeNull();
  expect(container.querySelector('input[aria-label="在知识库中搜索"]')).not.toBeNull();
  await act(async () => {
    setInputValue(search, "属性");
  });
  expect(container.textContent).toContain("属性资料");
  expect(container.textContent).toContain("属性定义说明.md");
  expect(container.textContent).toContain("属性对照.md");
  expect(container.textContent).toContain("其他资料 /");
  expect(container.textContent).not.toContain("会议纪要.md");
  const clear = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "清除",
  )!;
  await act(async () => {
    clear.click();
  });
  expect(search.value).toBe("");
  expect(container.textContent).toContain("没有匹配的文件。");
  expect(container.querySelector('button[aria-label="关闭搜索"]')).not.toBeNull();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="关闭搜索"]')!.click();
  });
  expect(container.querySelector('input[aria-label="在知识库中搜索"]')).toBeNull();
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("历史稿");
});

it("opens a folder from search results and leaves search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST")
        return new Response(JSON.stringify({ files: [], total: 0, page: 1 }));
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [
              { id: "f1", parentId: "", name: "属性资料" },
              { id: "f2", parentId: "", name: "其他资料" },
            ],
          }),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  const search = await openFileSearch(container);
  await act(async () => {
    setInputValue(search, "属性");
  });
  const match = container.querySelector<HTMLElement>(".mk-frow-folder")!;
  expect(match.textContent).toContain("属性资料");
  await act(async () => {
    match.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector('input[aria-label="在知识库中搜索"]')).toBeNull();
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("属性资料");
});

it("opens a file's folder from search results and leaves search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST") {
        if (path.includes("recursive="))
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "a1",
                  name: "属性对照.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f2",
                },
              ],
              total: 1,
              page: 1,
            }),
          );
        if (path.includes("folderId=f2"))
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "a1",
                  name: "属性对照.md",
                  status: "AVAILABLE",
                  message: "",
                  folderId: "f2",
                },
              ],
              total: 1,
              page: 1,
            }),
          );
        return new Response(JSON.stringify({ files: [], total: 0, page: 1 }));
      }
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [
              { id: "f1", parentId: "", name: "属性资料" },
              { id: "f2", parentId: "", name: "其他资料" },
            ],
          }),
        );
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  const search = await openFileSearch(container);
  await act(async () => {
    setInputValue(search, "属性");
  });
  const fileRow = [...container.querySelectorAll<HTMLElement>(".mk-frow")].find(
    (row) => row.textContent?.includes("属性对照.md"),
  )!;
  await act(async () => {
    fileRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector('input[aria-label="在知识库中搜索"]')).toBeNull();
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("其他资料");
  expect(container.textContent).toContain("属性对照.md");
  expect(container.querySelector(".mk-frow")?.className).not.toContain("focus");
});

it("searches and deletes folders when parent links form a cycle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "小治的知识库", selected: true }],
  };
  const folders = [
    { id: "a", parentId: "b", name: "属性资料" },
    { id: "b", parentId: "a", name: "历史稿" },
    { id: "c", parentId: "c", name: "属性对照" },
  ];
  const deletes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/folders/") && init.method === "DELETE") {
        deletes.push(path);
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path.includes("/files?") && init.method !== "POST")
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "a1",
                name: "属性模板.md",
                status: "AVAILABLE",
                message: "",
                folderId: "a",
              },
            ],
            total: 1,
            page: 1,
          }),
        );
      if (path.endsWith("/folders"))
        return new Response(JSON.stringify({ folders }));
      return new Response(JSON.stringify(state));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{ baseUrl: "http://localhost:1234", localToken: "t" }}
      />,
    );
  });
  const search = await openFileSearch(container);
  await act(async () => {
    setInputValue(search, "属性");
  });
  expect(container.textContent).toContain("历史稿 / 属性资料 /");
  expect(container.textContent).toContain("属性对照 /");
  const match = [...container.querySelectorAll<HTMLElement>(".mk-frow-folder")].find(
    (row) => row.textContent?.includes("属性资料"),
  )!;
  await act(async () => {
    match.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector(".mk-crumb")?.textContent).toContain("属性资料");
  const deleteButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="删除文件夹 历史稿"]',
  )!;
  await act(async () => {
    deleteButton.click();
  });
  const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "确认删除",
  )!;
  await act(async () => {
    confirm.click();
  });
  expect(deletes.some((url) => url.includes("/folders/b"))).toBe(true);
  expect(container.querySelector(".mk-modal-backdrop")).toBeNull();
}, 2000);
