// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistInboxItem, AssistRequest, CollabClient } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabAssistDialog } from "../collab-assist-dialog.js";
import { CollabAssistTask } from "../collab-assist-task.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUESTER = { userId: "2102247370314383361", name: "孙起", mine: false };
const ME = { userId: "2102247370314383362", name: "王雨", mine: true };

function request(overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id: "r1",
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "t1",
    attempt: 1,
    via: "Codex",
    title: "收集 Cursor 任务读取相关的信息",
    reason: "关联任务弹窗里看不到 Cursor 的任务",
    items: ["查看 Memmy、Cursor 与系统的版本"],
    status: "pending",
    agent: null,
    scope: null,
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    requester: REQUESTER,
    executor: ME,
    mine: false,
    createdAt: "2026-11-04T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    ...overrides
  };
}

const inbox: AssistInboxItem = {
  ...request(),
  granted: false,
  grantAgent: null,
  usedToday: 0
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
}

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    assistAgents: vi.fn().mockResolvedValue([
      { sourceId: "memmy", name: "Memmy", available: true },
      { sourceId: "claude_code", name: "Claude Code", available: true },
      { sourceId: "cursor", name: "Cursor", available: true }
    ]),
    decideAssist: vi.fn().mockResolvedValue(request({ status: "running" })),
    stopAssist: vi.fn().mockResolvedValue(request({ status: "stopped" })),
    noteAssist: vi.fn().mockResolvedValue(undefined),
    revokeAssistGrant: vi.fn().mockResolvedValue({ grants: [], dailyLimit: 20 }),
    ...overrides
  } as unknown as CollabClient;
}

describe("成员协助的授权弹窗", () => {
  it("默认选「仅这一次」，并预选一个可用的 Agent", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    // 原型：默认「仅这一次」，之后的请求还会先问她；执行方默认选列表里第一个可用的。
    expect(document.body.textContent).toContain("仅这一次");
    expect(document.body.textContent).toContain("孙起之后的请求还会先问你。");
    expect(document.body.textContent).toContain("由谁执行");

    await act(async () => button("允许")?.click());
    expect(onDecided).toHaveBeenCalledWith({ action: "allow", agent: "memmy", scope: "once" });
  });

  it("选「以后都直接执行」时把授权方式一起交上去", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent?.includes("以后孙起的请求都直接执行"))?.click();
    });
    await act(async () => button("允许")?.click());

    expect(onDecided).toHaveBeenCalledWith({ action: "allow", agent: "memmy", scope: "always" });
  });

  it("拒绝时不带执行方", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    await act(async () => button("拒绝")?.click());
    expect(onDecided).toHaveBeenCalledWith({ action: "reject" });
  });
});

describe("执行方的协助任务页", () => {
  it("她上次选的是「仅这一次」时，给出三个选择而不是替她决定", async () => {
    const collab = client();
    const onChanged = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTask
          request={request({ status: "confirm", scope: "once", attempt: 2 })}
          collab={collab}
          onChanged={onChanged}
        />
      </I18nProvider>
    ));

    expect(document.body.textContent).toContain("孙起发来第 2 次请求，需要你确认");
    expect(button("不允许")).toBeTruthy();
    expect(button("允许这一次")).toBeTruthy();
    expect(button("以后都直接执行")).toBeTruthy();

    await act(async () => button("允许这一次")?.click());
    expect(collab.decideAssist).toHaveBeenCalledWith("r1", { action: "allow", agent: undefined, scope: "once" });
  });

  it("执行中能停止，并把结果发给谁写清楚", async () => {
    const collab = client();
    const onChanged = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTask
          request={request({
            status: "done",
            scope: "always",
            agent: "claude_code",
            reply: "版本：Memmy 1.2.6",
            files: [{ name: "backend-cursor.log", size: "200 行", content: null }]
          })}
          collab={collab}
          agentKeepsHistory
          onChanged={onChanged}
        />
      </I18nProvider>
    ));

    expect(document.body.textContent).toContain("由 Claude Code 执行 · 以后孙起的请求都直接执行");
    expect(document.body.textContent).toContain("结果已发给孙起");
    expect(document.body.textContent).toContain("附 1 个文件");
    expect(document.body.textContent).toContain("这条会话也在 Claude Code 的历史记录里");

    await act(async () => button("停止")?.click());
    expect(collab.stopAssist).toHaveBeenCalledWith("r1");
  });

  it("结束授权之后只留一句说明", async () => {
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTask
          request={request({ status: "cancelled", scope: null })}
          collab={client()}
          onChanged={() => undefined}
        />
      </I18nProvider>
    ));

    expect(document.body.textContent).toContain("授权已结束。孙起之后的请求会重新询问你");
    expect(button("结束授权")).toBeUndefined();
  });
});