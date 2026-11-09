// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { SkillsSubPage, SkillsSubPageView } from "../skills-sub-page.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { createMemoryRuntimeClientStub, panelItemsOutput, skillPanelDetailFixture } from "./fixtures.js";

function historySkill(version = 1) {
  return { ...skillPanelDetailFixture, item: { ...skillPanelDetailFixture.item,
    version, title: "原始 Skill", body: "# 原始 Skill\n\n1. 查看当前工作。",
    metadata: { properties: { internal_info: { read_only: false,
      external_evidence_candidate: { source: "computer_history", activation_mode: "automatic_history" } } } } } };
}

function sourcedHistorySkill(options: { edited?: boolean; stepSources?: unknown; factCheck?: string } = {}) {
  const original = historySkill();
  return { ...original, item: { ...original.item, status: "activated" as const,
    sourceMemoryIds: ["memory-summary-1", "memory-summary-2"],
    metadata: { properties: { internal_info: { read_only: false,
      external_evidence_candidate: { source: "computer_history", activation_mode: "automatic_history",
        ...(options.edited ? { human_modified: true } : {}),
        generatedStepSources: options.stepSources === undefined ? [
          { stepIndex: 0, sourceMemoryId: "memory-summary-1", actionId: "private-action", textHash: "opaque-hash" },
          { stepIndex: 1, sourceMemoryId: "memory-summary-2", actionId: "private-action-2", textHash: "opaque-hash-2" }
        ] : options.stepSources },
      skill: { verification: { summaryFactCheck: options.factCheck ?? "not_independently_verified",
        execution_verified: false } } } } } } };
}

describe("History Skill post-editing", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    clearMemoryPanelCache();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); clearMemoryPanelCache(); });

  function button(label: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label)!;
  }
  async function replaceBody(body: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, body);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("saves the edited body then refreshes the open detail and list", async () => {
    const original = historySkill();
    const editedBody = "# 修订 Skill\n\n1. 查看当前工作。\n2. 核对结果。";
    const revised = { ...original, item: { ...original.item, version: 2, title: "修订 Skill", body: editedBody } };
    const getMemory = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(revised);
    const updateObservedSkill = vi.fn(async () => ({ id: original.item.id, status: "activated" as const, version: 2, serverTime: "2026-10-09T00:00:00Z" }));
    const listPanelItems = vi.fn(async () => panelItemsOutput([original.item]));
    const client = createMemoryRuntimeClientStub({ getMemory, updateObservedSkill, listPanelItems,
      listMemoryLogs: vi.fn(async () => ({ logs: [], total: 0, limit: 500, offset: 0, serverTime: "2026-10-09T00:00:00Z" })) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><SkillsSubPage
      client={client} openRequest={{ id: original.item.id, requestId: 1 }} onOpenMemoryReference={vi.fn()} /></I18nProvider></AppStateProvider>));
    expect(container.textContent).not.toContain("确认并启用这个 Skill");
    await act(async () => button("修改").click());
    await replaceBody(editedBody);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(updateObservedSkill).toHaveBeenCalledWith(original.item.id, { body: editedBody, expectedVersion: 1 });
    expect(getMemory).toHaveBeenCalledTimes(2);
    expect(listPanelItems).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".memory-drawer__title")?.textContent).toBe("修订 Skill");
  });

  it("keeps a failed draft and its original version when a newer detail appears", async () => {
    const onUpdate = vi.fn(async () => { throw new Error("内容已更新，请重新打开后修改。"); });
    const render = async (version: number) => act(async () => root.render(<I18nProvider language="zh-CN"><SkillsSubPageView
      state={{ status: "ready", data: panelItemsOutput([historySkill(version).item]) }}
      detail={{ status: "ready", data: { detail: historySkill(version), timeline: [] } }}
      query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onPageChange={vi.fn()} onRefresh={vi.fn()}
      onOpenSkill={vi.fn()} onDeleteSkill={vi.fn(async () => undefined)} onUpdateObservedSkill={onUpdate}
      onCloseSkill={vi.fn()} onOpenMemoryReference={vi.fn()} /></I18nProvider>));
    await render(1);
    await act(async () => button("修改").click());
    await replaceBody("# 人工修订\n\n保留这份草稿。");
    await render(2);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onUpdate).toHaveBeenCalledWith(historySkill().item.id, "# 人工修订\n\n保留这份草稿。", 1);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("内容已更新");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toContain("保留这份草稿");
  });

  it("links each generated step to its source memory and labels original verification", async () => {
    const onOpenMemoryReference = vi.fn();
    const detail = sourcedHistorySkill();
    await act(async () => root.render(<I18nProvider language="zh-CN"><SkillsSubPageView
      state={{ status: "ready", data: panelItemsOutput([detail.item]) }}
      detail={{ status: "ready", data: { detail, timeline: [] } }}
      query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onPageChange={vi.fn()} onRefresh={vi.fn()}
      onOpenSkill={vi.fn()} onDeleteSkill={vi.fn(async () => undefined)} onCloseSkill={vi.fn()}
      onOpenMemoryReference={onOpenMemoryReference} /></I18nProvider>));
    const section = container.querySelector(".memory-skill-step-sources")!;
    expect(section.textContent).toContain("第 1 步");
    expect(section.textContent).toContain("第 2 步");
    expect(section.textContent).toContain("摘要中的事实尚未逐条对照原始记录核验");
    expect(section.textContent).toContain("当时这些操作的执行结果尚未核实");
    expect(section.textContent).not.toContain("private-action");
    await act(async () => section.querySelector<HTMLButtonElement>('button[aria-label="memory-summary-2"]')!.click());
    expect(onOpenMemoryReference).toHaveBeenCalledWith("memory-summary-2", "memories");
  });

  it("falls back to general sources for edited, legacy, and malformed step mappings", async () => {
    const render = async (detail: ReturnType<typeof sourcedHistorySkill>, language: "zh-CN" | "en-US" = "zh-CN") => {
      await act(async () => root.render(<I18nProvider language={language}><SkillsSubPageView
        state={{ status: "ready", data: panelItemsOutput([detail.item]) }}
        detail={{ status: "ready", data: { detail, timeline: [] } }}
        query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onPageChange={vi.fn()} onRefresh={vi.fn()}
        onOpenSkill={vi.fn()} onDeleteSkill={vi.fn(async () => undefined)} onCloseSkill={vi.fn()}
        onOpenMemoryReference={vi.fn()} /></I18nProvider>));
      expect(container.querySelector(".memory-skill-step-sources")).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="memory-summary-1"]')).not.toBeNull();
    };
    await render(sourcedHistorySkill({ edited: true }));
    await render(sourcedHistorySkill({ stepSources: [] }));
    await render(sourcedHistorySkill({ stepSources: [{ stepIndex: 1, sourceMemoryId: "memory-summary-1" }] }));
    await render(sourcedHistorySkill({ stepSources: [{ stepIndex: 0, sourceMemoryId: "not-a-source" }] }));
    await render(sourcedHistorySkill({ stepSources: Array.from({ length: 13 }, (_, stepIndex) => ({
      stepIndex, sourceMemoryId: "memory-summary-1" })) }));

    const unknown = sourcedHistorySkill({ factCheck: "unknown" });
    await act(async () => root.render(<I18nProvider language="en-US"><SkillsSubPageView
      state={{ status: "ready", data: panelItemsOutput([unknown.item]) }}
      detail={{ status: "ready", data: { detail: unknown, timeline: [] } }}
      query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onPageChange={vi.fn()} onRefresh={vi.fn()}
      onOpenSkill={vi.fn()} onDeleteSkill={vi.fn(async () => undefined)} onCloseSkill={vi.fn()}
      onOpenMemoryReference={vi.fn()} /></I18nProvider>));
    expect(container.querySelector(".memory-skill-step-sources")?.textContent).toContain("Step 1");
    expect(container.querySelector(".memory-skill-step-sources")?.textContent).toContain("No record of a claim-by-claim check");
    expect(container.querySelector(".memory-skill-step-sources")?.textContent).toContain("original actions has not been verified");
  });

  it.each(["success", "failure"] as const)("ignores a late %s from Skill A while Skill B is being edited and saved", async (outcome) => {
    let finishA!: () => void;
    let rejectA!: (error: Error) => void;
    let finishB!: () => void;
    const pendingA = new Promise<void>((resolve, reject) => { finishA = resolve; rejectA = reject; });
    const pendingB = new Promise<void>((resolve) => { finishB = resolve; });
    const onUpdate = vi.fn((id: string) => id === "skill-A" ? pendingA : pendingB);
    const render = async (id: string) => {
      const detail = historySkill();
      detail.item.id = id;
      await act(async () => root.render(<I18nProvider language="zh-CN"><SkillsSubPageView
        state={{ status: "ready", data: panelItemsOutput([detail.item]) }}
        detail={{ status: "ready", data: { detail, timeline: [] } }}
        query="" onQueryChange={vi.fn()} onSearch={vi.fn()} onPageChange={vi.fn()} onRefresh={vi.fn()}
        onOpenSkill={vi.fn()} onDeleteSkill={vi.fn(async () => undefined)} onUpdateObservedSkill={onUpdate}
        onCloseSkill={vi.fn()} onOpenMemoryReference={vi.fn()} /></I18nProvider>));
    };
    const submit = async () => act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    await render("skill-A");
    await act(async () => button("修改").click());
    await replaceBody("# A 的草稿\n\n保存 A。");
    await submit();
    expect(button("正在保存…").disabled).toBe(true);

    await render("skill-B");
    await act(async () => button("修改").click());
    await replaceBody("# B 的草稿\n\n保留 B 的修改。");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    await submit();
    await act(async () => outcome === "success" ? finishA() : rejectA(new Error("A 保存失败")));

    const bEditor = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(bEditor?.value).toContain("保留 B 的修改");
    expect(bEditor?.disabled).toBe(true);
    expect(button("正在保存…").disabled).toBe(true);
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(onUpdate).toHaveBeenLastCalledWith("skill-B", "# B 的草稿\n\n保留 B 的修改。", 1);
    await act(async () => finishB());
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("archives an active Skill and reactivates an archived one from the drawer", async () => {
    const active = { ...skillPanelDetailFixture, item: { ...skillPanelDetailFixture.item, status: "activated" as const } };
    const archived = { ...active, item: { ...active.item, status: "archived" as const } };
    const getMemory = vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(archived).mockResolvedValue(active);
    const archiveSkill = vi.fn(async (id: string) => ({ ok: true as const, id, status: "archived" as const, serverTime: "2026-10-28T00:00:00Z" }));
    const reactivateSkill = vi.fn(async (id: string) => ({ ok: true as const, id, status: "activated" as const, serverTime: "2026-10-28T00:00:00Z" }));
    const client = createMemoryRuntimeClientStub({ getMemory, archiveSkill, reactivateSkill,
      listPanelItems: vi.fn(async () => panelItemsOutput([active.item])),
      listMemoryLogs: vi.fn(async () => ({ logs: [], total: 0, limit: 500, offset: 0, serverTime: "2026-10-28T00:00:00Z" })) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><SkillsSubPage
      client={client} openRequest={{ id: active.item.id, requestId: 1 }} onOpenMemoryReference={vi.fn()} /></I18nProvider></AppStateProvider>));

    await act(async () => button("归档").click());
    expect(archiveSkill).toHaveBeenCalledWith(active.item.id);
    await act(async () => button("重新启用").click());
    expect(reactivateSkill).toHaveBeenCalledWith(active.item.id);
    expect(button("归档")).toBeTruthy();
  });
});
