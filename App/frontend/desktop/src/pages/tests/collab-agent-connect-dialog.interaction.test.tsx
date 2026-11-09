// @vitest-environment happy-dom

/**
 * 添加 Agent 支持：只问名字（知道技能目录时可以一起给），说明里讲清 Memmy 会新建一条任务去做这件事。
 * 文案固定住，免得又变回「关联其他 Agent」这种把「添加支持」说成「关联任务」的写法。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedAgent, CollabClient } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabAgentConnectDialog } from "../collab-agent-connect-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("add agent support dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onRemoved = vi.fn();
  const removeAddedAgent = vi.fn();

  const added: AddedAgent[] = [{ sourceId: "added-qoder-82ef827e", name: "Qoder", skillDirectory: "/Users/me/.qoder/skills" }];

  async function render(options: { added?: AddedAgent[] } = {}) {
    const collab = { removeAddedAgent } as unknown as CollabClient;
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabAgentConnectDialog
            open
            projectName="MemOS"
            added={options.added ?? []}
            collab={collab}
            onClose={onClose}
            onStart={onStart}
            onRemoved={onRemoved}
          />
        </I18nProvider>
      );
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    removeAddedAgent.mockResolvedValue({ text: "已移除" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function inputs(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>(".modal-body input"));
  }

  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function button(text: string): HTMLButtonElement {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.textContent?.trim() === text);
    expect(target, `「${text}」按钮应已渲染`).toBeTruthy();
    return target!;
  }

  it("says what Memmy will do, then how it is used afterwards", () => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("添加 Agent 支持");
    expect(text).toContain("填写 Agent 名称即可");
    // 「只在本机」紧跟在「会新建一条任务」后面，读起来才连贯。
    expect(text).toMatch(/找到这个 Agent 并让它能够使用协作项目。本次新建的任务只在本机，不会共享给成员。/u);
    // 说明块提示以后怎么用：在对话中说明即可，并给一句能照着说的话。
    expect(text).toContain("在对话中说明即可，无需返回 Memmy");
    expect(text).toContain("例如「把这个任务加入 MemOS 项目」");
    // 不点名任何产品，也不描述实现规则。
    expect(text).not.toContain("Cursor");
    expect(text).not.toContain("关联其他 Agent");
  });

  it("takes the name, and leaves the skills folder empty unless one is picked", async () => {
    const [name] = inputs();
    expect(button("确认并开始").disabled).toBe(true);
    await act(async () => type(name!, "  Kimi Code  "));
    expect(button("确认并开始").disabled).toBe(false);
    await act(async () => button("确认并开始").click());
    // 不选目录时不传第二个参数，由那条任务自己去找。
    expect(onStart).toHaveBeenCalledExactlyOnceWith("Kimi Code", undefined);
  });

  it("opens the folder picker instead of asking the person to type a path", async () => {
    const selectProjectDirectory = vi.fn().mockResolvedValue({ canceled: false, path: "/Users/me/.kimi/skills" });
    (window as unknown as { memmy?: unknown }).memmy = { selectProjectDirectory };
    try {
      expect(document.body.textContent).toContain("未选择");
      await act(async () => type(inputs()[0]!, "Kimi Code"));
      await act(async () => button("选择文件夹").click());
      expect(selectProjectDirectory).toHaveBeenCalledOnce();
      // 选中的路径显示在只读框里，按钮变成「更改」
      expect(document.body.textContent).toContain("/Users/me/.kimi/skills");
      expect(document.querySelectorAll("button").length).toBeGreaterThan(0);
      expect(Array.from(document.querySelectorAll("button")).some((item) => item.textContent?.trim() === "更改")).toBe(true);
      await act(async () => button("确认并开始").click());
      expect(onStart).toHaveBeenCalledExactlyOnceWith("Kimi Code", "/Users/me/.kimi/skills");
    } finally {
      delete (window as unknown as { memmy?: unknown }).memmy;
    }
  });

  it("lists the added agents and removes one", async () => {
    await act(async () => root.unmount());
    const fresh = createRoot(container);
    await act(async () => {
      fresh.render(
        <I18nProvider language="zh-CN">
          <CollabAgentConnectDialog
            open
            projectName="MemOS"
            added={added}
            collab={{ removeAddedAgent } as unknown as CollabClient}
            onClose={onClose}
            onStart={onStart}
            onRemoved={onRemoved}
          />
        </I18nProvider>
      );
    });
    expect(document.body.textContent).toContain("Qoder");
    await act(async () => button("移除").click());
    expect(removeAddedAgent).toHaveBeenCalledWith("Qoder");
    expect(onRemoved).toHaveBeenCalledOnce();
    await act(async () => fresh.unmount());
  });
});
