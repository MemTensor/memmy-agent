// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { FilePreview } from "../file-preview/file-preview.js";
import type { FilePreviewResource } from "../file-preview/file-preview-types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FilePreview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("renders safe Markdown and opens project-relative links in the host", async () => {
    const openRelativePath = vi.fn();
    const resource: FilePreviewResource = {
      id: "readme",
      name: "README.md",
      path: "docs/README.md",
      load: async () => new Blob(["# 标题\n[源码](../src/index.ts)\n<script>bad()</script>"], { type: "text/markdown" }),
      openRelativePath
    };
    await render(resource);

    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("script")).toBeNull();
    const link = container.querySelector<HTMLButtonElement>(".file-preview__markdown-link")!;
    act(() => link.click());
    expect(openRelativePath).toHaveBeenCalledWith("src/index.ts");
  });

  it("switches Markdown between rendered preview and source", async () => {
    const onViewStateChange = vi.fn();
    const resource: FilePreviewResource = {
      id: "markdown-toggle",
      name: "README.md",
      load: async () => new Blob(["# 标题\n\n正文"], { type: "text/markdown" })
    };
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <FilePreview resource={resource} onViewStateChange={onViewStateChange} />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("h1")?.textContent).toBe("标题");
    const source = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("源码"))!;
    await act(async () => {
      source.click();
      await Promise.resolve();
    });

    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector(".file-preview__code")?.textContent).toContain("# 标题");
    expect(onViewStateChange).toHaveBeenCalledWith({ markdownMode: "source" });
  });

  it("renders code with line numbers", async () => {
    await render({
      id: "code",
      name: "index.ts",
      load: async () => new Blob(["const value = 1;\n"], { type: "text/plain" })
    });

    expect(container.querySelector(".file-preview__code")?.textContent).toContain("const");
    expect(container.querySelector(".linenumber")).not.toBeNull();
  });

  it.each([
    ["Command+F", { metaKey: true }],
    ["Ctrl+F", { ctrlKey: true }]
  ])("searches within code using %s and navigates matches", async (_shortcut, modifier) => {
    await render({
      id: `search-${_shortcut}`,
      name: "index.ts",
      load: async () => new Blob(["const alpha = 1;\nconst next = alpha;\n"], { type: "text/plain" })
    });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f",
      bubbles: true,
      ...modifier
    })));
    const input = container.querySelector<HTMLInputElement>('[role="search"] input')!;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("在文件中搜索");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "alpha");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelector(".file-preview__search-count")?.textContent).toBe("1/2"));

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(container.querySelector(".file-preview__search-count")?.textContent).toBe("2/2");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="search"]')).toBeNull();
  });

  it.each([
    ["module.mjs", "export const value = 1;", true],
    ["references.bib", "@article{memmy, title={Memmy}}", false]
  ])("previews %s as text instead of an unsupported binary", async (name, body, code) => {
    await render({
      id: name,
      name,
      load: async () => new Blob([body], { type: "text/plain" })
    });

    expect(container.textContent).toContain(body);
    expect(container.textContent).not.toContain("暂不支持");
    expect(Boolean(container.querySelector(".file-preview__code"))).toBe(code);
  });

  it("previews an unknown extension when its bytes are text", async () => {
    await render({
      id: "unknown-text",
      name: "rules.customlang",
      load: async () => new Blob(["rule allow_memmy = true"], { type: "application/octet-stream" })
    });

    expect(container.querySelector(".file-preview__text")?.textContent).toContain("allow_memmy");
    expect(container.textContent).not.toContain("暂不支持");
  });

  it("keeps a binary unknown extension on the unsupported fallback", async () => {
    await render({
      id: "unknown-binary",
      name: "payload.unknown",
      load: async () => new Blob([new Uint8Array([0, 1, 2, 3])], { type: "application/octet-stream" })
    });

    expect(container.textContent).toContain("暂不支持");
  });

  it("offers a system-open fallback for unsupported files", async () => {
    const open = vi.fn();
    await render({
      id: "archive",
      name: "bundle.zip",
      open,
      load: async () => new Blob(["zip"], { type: "application/zip" })
    });

    expect(container.textContent).toContain("暂不支持");
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("系统应用"))!;
    act(() => button.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  async function render(resource: FilePreviewResource) {
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><FilePreview resource={resource} /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

describe("plugin PDF preview source", () => {
  it("uses the shared renderer instead of Chromium's PDF iframe", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/plugin-artifact-preview-panel.tsx"), "utf8");
    expect(source).toContain("<FilePreview resource={resource}");
    expect(source).not.toContain("<iframe");
  });

  it("keeps search navigation inside the preview scroll container", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/file-preview/file-preview.tsx"), "utf8");
    expect(source).toContain("scrollContainer.scrollTop +=");
    expect(source).not.toContain("scrollIntoView");
  });
});
