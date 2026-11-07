// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProjectKnowledgeDialog } from "../collab-knowledge-dialog.js";
import { listKnowledgeBases } from "../../api/knowledge-bases-client.js";

vi.mock("../../api/knowledge-bases-client.js", () => ({ listKnowledgeBases: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bases = [
  { id: "product", name: "MemOS产品" },
  { id: "team", name: "团队规范", shared: true, sharedByMe: false, ownerName: "小林" },
  { id: "linked", name: "已关联资料" }
];
let root: Root;
let container: HTMLDivElement;
const onAdd = vi.fn();
const onAdded = vi.fn();
const onClose = vi.fn();

async function render(maxBases = 10) {
  await act(async () => {
    root.render(<I18nProvider language="zh-CN"><ProjectKnowledgeDialog open linked={[{ id: "linked", name: "已关联资料" }]} maxBases={maxBases} config={{} as never} onAdd={onAdd} onAdded={onAdded} onClose={onClose} /></I18nProvider>);
  });
}
function checkbox(name: string) {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
}
function submit() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("添加知识库"))!;
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listKnowledgeBases).mockResolvedValue(bases);
  onAdd.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project knowledge picker", () => {
  it("selects by clicking a whole row, exposes metadata and updates the remaining capacity", async () => {
    await render();
    expect(submit().disabled).toBe(true);
    expect(checkbox("已关联资料").checked).toBe(true);
    expect(checkbox("已关联资料").disabled).toBe(true);
    expect(document.body.textContent).toContain("来自 小林");
    const label = checkbox("MemOS产品").closest("label")!;
    expect(label).toBeTruthy();
    await act(async () => label.click());
    expect(checkbox("MemOS产品").checked).toBe(true);
    expect(label.dataset.selected).toBe("true");
    expect(document.body.textContent).toContain("已选择 1 个");
    expect(document.body.textContent).toContain("还可关联 8 个");
    expect(submit().disabled).toBe(false);
    await act(async () => label.click());
    expect(submit().disabled).toBe(true);
  });

  it("keeps selected rows usable at the limit and never selects linked rows again", async () => {
    await render(2);
    await act(async () => checkbox("MemOS产品").click());
    expect(checkbox("团队规范").disabled).toBe(true);
    expect(checkbox("MemOS产品").disabled).toBe(false);
    await act(async () => submit().click());
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("product");
    expect(onAdded).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("distinguishes search misses from an empty library and preserves hidden selections", async () => {
    await render();
    await act(async () => checkbox("MemOS产品").click());
    await search(" 不存在 ");
    expect(document.body.textContent).toContain("未找到相关知识库");
    expect(document.body.textContent).toContain("尝试更换关键词");
    expect(document.body.textContent).not.toContain("暂无可关联的知识库");
    expect(document.body.textContent).toContain("已选择 1 个");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]')!.click());
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("");
    expect(checkbox("MemOS产品").checked).toBe(true);
  });

  it("disables editing and dismissal while adding and reports failures", async () => {
    let reject!: (cause: Error) => void;
    onAdd.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await render();
    await act(async () => checkbox("MemOS产品").click());
    await act(async () => submit().click());
    expect(checkbox("MemOS产品").disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error("网络不可用")));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("网络不可用");
    expect(submit().disabled).toBe(false);
  });

  it("removes completed additions from retries after partial failure", async () => {
    onAdd.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("请重试")).mockResolvedValue(undefined);
    await render();
    await act(async () => { checkbox("MemOS产品").click(); });
    await act(async () => { checkbox("团队规范").click(); });
    await act(async () => submit().click());
    expect(onAdded).toHaveBeenCalledWith(1);
    expect(checkbox("MemOS产品").disabled).toBe(true);
    expect(document.body.textContent).toContain("已选择 1 个");
    await act(async () => submit().click());
    expect(onAdd.mock.calls.map(([id]) => id)).toEqual(["product", "team", "team"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a compact empty state", async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain("暂无可关联的知识库");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });
});
