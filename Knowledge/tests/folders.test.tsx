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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init.method ?? "GET", body });
      const path = String(url);
      if (path.includes("/files?") && init.method !== "POST")
        return new Response(
          JSON.stringify({
            files: [
              { id: "a1", name: "指南.pdf", status: "AVAILABLE", message: "" },
              { id: "a2", name: "报表.xlsx", status: "AVAILABLE", message: "" },
            ],
            total: 2,
            page: 1,
          }),
        );
      if (path.endsWith("/folders"))
        return new Response(
          JSON.stringify({
            folders: [{ id: "f1", parentId: "", name: "产品资料" }],
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
  // 完成后清空选择，操作条消失
  expect(container.querySelector(".mk-batchbar")).toBeNull();
});
