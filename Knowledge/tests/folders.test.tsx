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
  // 目录内新建文件夹：行内输入 → POST parentId=f1
  const createButton = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.includes("新建文件夹"))!;
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
