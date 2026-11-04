// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksSubPage } from "../tasks-sub-page.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
import type { PanelTaskItem, PanelTasksOutput } from "@memmy/local-api-contracts";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => clearMemoryPanelCache());
const now = "2026-10-29T08:00:00Z";
const task: PanelTaskItem = {
  id: "task", episode: {id:"task", title:"任务示例", sessionId:"session", status:"closed", turnCount:2}, memoryIds:[], updatedAt:now,
  turns:[{rawTurnId:"turn",turnId:"turn",episodeId:"task",createdAt:now,userText:"**用户消息**",reasoningSummary:"先检查文件",assistantText:"完成 `检查`",toolCalls:[{id:"call",name:"read_file",success:false,error:"访问失败",startedAt:now,endedAt:"2026-10-29T08:00:00.125Z"}],toolResults:[]}]
};
const output = (tasks: PanelTaskItem[]): PanelTasksOutput => ({tasks,page:1,pageSize:20,total:tasks.length,totalPages:1,hasNext:false,hasPrev:false,serverTime:now});
describe("task details use the original chat UI", () => {
  it("opens a lightweight list item through the baseline detail reader and renderer", async () => {
    const {turns: _turns, ...summary} = task;
    const listPanelTasks = vi.fn(async () => output([task]));
    const listPanelTaskSummaries = vi.fn(async () => ({...output([]),tasks:[{...summary,firstUserText:"用户消息",firstAssistantText:"完成",toolCallCount:1}]}));
    const client = createMemoryRuntimeClientStub({listPanelTaskSummaries,listPanelTasks});
    const container = document.createElement("div"), root = createRoot(container);
    try {
      await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><TasksSubPage client={client}/></I18nProvider></AppStateProvider>));
      expect(listPanelTasks).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLElement>(".memory-card")!.click());
      expect(listPanelTasks).toHaveBeenCalledWith({q:"task",page:1},expect.any(AbortSignal));
      expect([...container.querySelectorAll(".memory-chat-item")].map(node=>node.className)).toEqual(["user","thinking","tool","assistant"].map(role=>`memory-chat-item memory-chat-item--${role}`));
      expect(container.querySelector(".memory-chat-bubble strong")?.textContent).toBe("用户消息");
      expect(container.querySelector(".memory-chat-bubble code")?.textContent).toBe("检查");
      expect(container.querySelector(".memory-chat-status--error")?.textContent).toBe("失败");
      expect(container.querySelector(".memory-chat-duration")?.textContent).toBe("125 ms");
      expect(container.querySelector(".memory-tool-section[open] pre")?.textContent).toBe("访问失败");
    } finally { await act(async () => root.unmount()); }
  });
  it("aborts a pending detail read on unmount", async () => {
    let finish!: (value: PanelTasksOutput) => void;
    const read = vi.fn((_input, _signal?: AbortSignal) => new Promise<PanelTasksOutput>(resolve=>{finish=resolve;}));
    const client = createMemoryRuntimeClientStub({listPanelTasks:read});
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><TasksSubPage client={client} openRequest={{id:"task",requestId:1}}/></I18nProvider></AppStateProvider>));
    const signals = read.mock.calls.map(call=>call[1]);
    await act(async () => root.unmount());
    expect(signals.every(signal=>signal?.aborted)).toBe(true);
    await act(async () => finish(output([task])));
  });
});
