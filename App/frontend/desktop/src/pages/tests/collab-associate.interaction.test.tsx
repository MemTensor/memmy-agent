// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient, CollabLinks, LocalAgentSession } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AssociateSessionsModal } from "../collab-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const group = { id: "workspace", label: "MemOS-WorkSpace", path: "/repo" };
const sessions: LocalAgentSession[] = ["one", "two"].map((id) => ({
  sourceId: "workbuddy", agentName: "WorkBuddy", conversationId: id, title: `任务 ${id}`,
  lastQuestion: "", workspacePath: "/repo", group, updatedAt: "2026-10-29T00:00:00Z", turnCount: 1
}));
const whole: CollabLinks = { groups: [{ sourceId: "workbuddy", groupId: "workspace", excluded: [] }], sessions: [] };
const project = { id: "p1", name: "MemOS", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null, localProjectId: null, instructions: "" };
let root: Root;
let container: HTMLDivElement;
const saveLinks = vi.fn();
const onLinked = vi.fn();
const onClose = vi.fn();
async function render(links: CollabLinks = whole) {
  const client = {
    listLocalSessions: vi.fn().mockResolvedValue({ sessions, refreshing: false }),
    getLinks: vi.fn().mockResolvedValue(links),
    saveLinks
  } as unknown as CollabClient;
  await act(async () => root.render(<I18nProvider language="zh-CN"><AssociateSessionsModal open collab={client} project={project} onClose={onClose} onLinked={onLinked} /></I18nProvider>));
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!; }
function groupCheckbox() { return document.querySelector<HTMLInputElement>('input[aria-label="MemOS-WorkSpace"]')!; }
async function expand() { await act(async () => document.querySelector<HTMLButtonElement>('button[title="/repo"]')!.click()); }
function taskCheckbox(name: string) {
  return [...document.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.includes(name))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}
beforeEach(() => {
  vi.clearAllMocks();
  saveLinks.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("associate other agents' tasks", () => {
  it("shows the authorization note instead of reading other agents' tasks, then lists them in place", async () => {
    const listLocalSessions = vi.fn().mockResolvedValue({ sessions, refreshing: false });
    const client = {
      listLocalSessions,
      getLinks: vi.fn().mockResolvedValue(whole),
      saveLinks
    } as unknown as CollabClient;
    const onGrantAccess = vi.fn().mockResolvedValue(true);
    await act(async () => root.render(<I18nProvider language="zh-CN"><AssociateSessionsModal open collab={client} project={project} accessGranted={false} onGrantAccess={onGrantAccess} onClose={onClose} onLinked={onLinked} /></I18nProvider>));

    // 未授权：正文是授权说明，一个本机记录也不读，也没有「保存」。
    expect(document.body.textContent).toContain("关联前需要你的授权");
    expect(listLocalSessions).not.toHaveBeenCalled();
    expect([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "保存")).toBe(false);

    await act(async () => button("授权并继续").click());
    expect(onGrantAccess).toHaveBeenCalledOnce();
    // 父级把授权状态翻成已授权后，同一个弹窗里直接列出任务，不用关掉再点一次。
    await act(async () => root.render(<I18nProvider language="zh-CN"><AssociateSessionsModal open collab={client} project={project} accessGranted onGrantAccess={onGrantAccess} onClose={onClose} onLinked={onLinked} /></I18nProvider>));
    expect(listLocalSessions).toHaveBeenCalled();
    expect(document.querySelector("nav[aria-label='Agent']")?.textContent).toContain("WorkBuddy");
  });

  it("saves an individual exclusion without confirmation and retains the whole-group indication", async () => {
    await render();
    expect(button("保存").disabled).toBe(true);
    await expand();
    await act(async () => taskCheckbox("任务 one").click());
    expect(groupCheckbox().indeterminate).toBe(true);
    expect(document.body.textContent).toContain("整组关联，包含此后新增的任务");
    expect(document.body.textContent).toContain("已排除");
    await act(async () => button("保存").click());
    expect(saveLinks).toHaveBeenCalledExactlyOnceWith("p1", { groups: [{ ...whole.groups[0], excluded: ["one"] }], sessions: [] });
    expect(document.body.textContent).not.toContain("解除整组关联？");
    expect(onLinked).toHaveBeenCalledOnce();
  });

  it("keeps agents the person added out of the list, because Memmy cannot read their tasks", async () => {
    // 用户添加的 Agent 只能自己提交任务，没有可勾选的历史，所以左侧不出现它的行。
    await render(whole);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("nav[aria-label='Agent'] button"));
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("WorkBuddy")]);
  });

  it("asks once before unlinking a saved whole group, and cancel preserves the pending selection", async () => {
    await render();
    await act(async () => groupCheckbox().click());
    await act(async () => button("保存").click());
    expect(document.body.textContent).toContain("解除整组关联？");
    expect(saveLinks).not.toHaveBeenCalled();
    await act(async () => button("解除关联").click());
    expect(saveLinks).toHaveBeenCalledExactlyOnceWith("p1", { groups: [], sessions: [] });
  });

  it("saves a new individual task without asking to unlink a group", async () => {
    await render({ groups: [], sessions: [] });
    await expand();
    await act(async () => taskCheckbox("任务 one").click());
    await act(async () => button("保存").click());
    expect(saveLinks).toHaveBeenCalledExactlyOnceWith("p1", { groups: [], sessions: [{ sourceId: "workbuddy", conversationId: "one" }] });
  });

  it("preserves the pending selection and shows a fallback if saving fails", async () => {
    saveLinks.mockRejectedValueOnce(new Error(""));
    await render({ groups: [], sessions: [] });
    await expand();
    await act(async () => taskCheckbox("任务 one").click());
    await act(async () => button("保存").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("部分关联未完成，请重试保存");
    expect(taskCheckbox("任务 one").checked).toBe(true);
    expect(button("保存").disabled).toBe(false);
    expect(onLinked).not.toHaveBeenCalled();
  });
});
