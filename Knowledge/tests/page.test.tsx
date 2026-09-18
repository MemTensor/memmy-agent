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
it("shows management only, with recall off by default and no exposed saved secret", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: false,
    serviceAvailable: true,
    bases: [{ id: "base-1", name: "差旅制度", selected: false }],
  };
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).includes("/files"))
        return new Response(JSON.stringify({ files: [], total: 0, page: 1 }));
      if (body?.enabled !== undefined) state.enabled = body.enabled;
      if (Array.isArray(body?.selectedIds))
        state.bases.forEach(
          (base) =>
            (base.selected = (body.selectedIds as string[]).includes(base.id)),
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
        connection={{
          baseUrl: "http://localhost:1234",
          localToken: "local-test",
        }}
      />,
    );
  });
  const toggle = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
  ].find((item) =>
    (item.getAttribute("aria-label") ?? "").includes("差旅制度"),
  )!;
  expect(toggle).toBeDefined();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
  expect(container.textContent).toContain("差旅制度");
  expect(container.querySelector("textarea")).toBeNull();
  const fileInput =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(fileInput.multiple).toBe(true);
  expect(fileInput.hidden).toBe(true);
  expect(container.querySelector(".mk-empty-cta")).toBeNull();
  expect(container.textContent).toContain("每个文件最多 20 MB");
  expect(container.querySelector(".mk-count")?.textContent?.trim()).toBe("文件");
  expect(container.textContent).not.toContain("内容(0)");
  expect(container.textContent).not.toMatch(/文件\s*\(\d+\)/);
  expect(container.textContent).not.toMatch(/\d+ 个文件/);
  // 侧边栏分组数量与可创建上限
  expect(
    container.querySelector(".mk-group-title .mk-group-count")?.textContent,
  ).toBe("1");
  expect(container.querySelector(".mk-quota")?.textContent).toContain(
    "可创建的知识库：1/10",
  );
  expect(container.querySelector("style")?.textContent).toContain(
    ".mk-side-foot{padding:10px 16px}",
  );
  expect(container.querySelector("style")?.textContent).not.toContain(
    ".mk-side-foot{padding:10px 16px;border-top",
  );
  const createTrigger = [
    ...container.querySelectorAll("button"),
  ].find((item) => item.textContent?.includes("新建知识库"));
  expect(createTrigger).toBeDefined();
  await act(async () => {
    createTrigger!.click();
  });
  const createInput = [
    ...container.querySelectorAll<HTMLInputElement>("input"),
  ].find((item) => item.placeholder === "请输入知识库名称");
  expect(createInput?.maxLength).toBe(20);
  expect(container.querySelector(".mk-name-count")?.textContent).toBe("0/20");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).not.toContain("API Key");
  expect(container.textContent).not.toContain("MemOS 云服务连接");
  expect(container.querySelector('a[href*="memos-dashboard"]')).toBeNull();
  expect(calls.some((call) => call.url.includes("/credentials/reveal"))).toBe(
    false,
  );
  expect(calls.some((call) => call.url.includes("search"))).toBe(false);
  await act(async () => {
    toggle.click();
  });
  expect(
    calls.some(
      (call) =>
        call.body?.enabled === true &&
        Array.isArray(call.body?.selectedIds) &&
        (call.body.selectedIds as string[]).includes("base-1"),
    ),
  ).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it("removes a knowledge base from the list without waiting for delete to finish", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: KnowledgeSettings = {
    authenticated: true,
    enabled: true,
    serviceAvailable: true,
    bases: [
      { id: "keep", name: "保留库", selected: false },
      { id: "gone", name: "待删库", selected: true },
      {
        id: "share",
        name: "共享库",
        selected: false,
        shared: true,
        ownerName: "胡朗铿",
      },
    ],
  };
  let releaseDelete: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const path = String(url);
      if (path.includes("/files"))
        return Promise.resolve(
          new Response(JSON.stringify({ files: [], total: 0, page: 1 })),
        );
      if (path.includes("/folders"))
        return Promise.resolve(new Response(JSON.stringify({ folders: [] })));
      if (init.method === "DELETE" && path.includes("/bases/gone"))
        return new Promise<Response>((resolve) => {
          releaseDelete = resolve;
        });
      return Promise.resolve(new Response(JSON.stringify(state)));
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgePage
        connection={{
          baseUrl: "http://localhost:1234",
          localToken: "local-test",
        }}
      />,
    );
  });
  const goneRow = [...container.querySelectorAll('[role="button"]')].find(
    (item) => item.textContent?.includes("待删库"),
  )!;
  await act(async () => {
    goneRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
      .click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "删除知识库")!
      .click();
  });
  expect(container.querySelector("#mk-delete-title")).not.toBeNull();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认删除")!
      .click();
  });
  expect(container.querySelector("#mk-delete-title")).toBeNull();
  expect(container.textContent).not.toContain("待删库");
  expect(container.textContent).toContain("保留库");
  expect(container.textContent).toContain("共享库");
  expect(container.querySelector("h1")).toBeNull();
  expect(container.textContent).not.toContain("创建你的第一个知识库");
  expect(container.querySelector(".mk-kb-active")).toBeNull();
  expect(releaseDelete).toBeDefined();
});
