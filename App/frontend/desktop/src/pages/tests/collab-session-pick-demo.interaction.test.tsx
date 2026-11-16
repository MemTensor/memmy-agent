// @vitest-environment happy-dom

/**
 * 新手引导里的「关联会话」：弹窗真的去扫这台电脑上的会话，但不给勾选、不给保存。
 *
 * 只测弹窗本身：扫描走 `listLocalSessions`（`fresh: true`，不等缓存），扫完把条数交给引导，
 * 引导据此才让「下一步」可用。顺带钉住展示模式不出现「保存」与关闭按钮。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient, CollabProject } from "../../api/collab-client.js";
import type { LocalAgentSession } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AssociateSessionsModal } from "../collab-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = { id: "cloud-1", name: "项目协作体验" } as CollabProject;

function session(id: string, title: string): LocalAgentSession {
  return {
    sourceId: "claude-code",
    agentName: "Claude Code",
    sessionId: id,
    // 行 key 用 sourceId + conversationId：两个会话要各自唯一，不然列表会合并成一行。
    conversationId: id,
    title,
    lastQuestion: "",
    updatedAt: "2026-11-16T02:24:00.000Z"
  } as LocalAgentSession;
}

/** 只提供这个弹窗会用到的那几个方法：其余调用在这些用例里不会发生。 */
function stubClient(listLocalSessions: ReturnType<typeof vi.fn>): CollabClient {
  return {
    listLocalSessions,
    // 普通打开时还会读已关联的勾选：这些用例都不关心，给一份空的选择。
    getLinks: vi.fn().mockResolvedValue({ groups: [], sessions: [] })
  } as unknown as CollabClient;
}

describe("the session picker inside the demo guide", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(props: {
    demoGuide?: boolean;
    listLocalSessions: ReturnType<typeof vi.fn>;
    onDemoScanSettled?: (count: number) => void;
  }): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AssociateSessionsModal
            open
            collab={stubClient(props.listLocalSessions)}
            project={PROJECT}
            onClose={() => undefined}
            onLinked={() => undefined}
            demoGuide={props.demoGuide}
            onDemoScanSettled={props.onDemoScanSettled}
          />
        </I18nProvider>
      );
    });
    await act(async () => undefined);
  }

  it("really scans the computer and reports how many sessions it found", async () => {
    const listLocalSessions = vi.fn().mockResolvedValue({
      sessions: [session("s-1", "把分享会的议程拆成待办"), session("s-2", "核对上次分享会的签到表")],
      refreshing: false
    });
    const settled = vi.fn();

    await render({ demoGuide: true, listLocalSessions, onDemoScanSettled: settled });

    // 不等上次缓存：这一步要的是这台电脑此刻的真实结果。
    expect(listLocalSessions).toHaveBeenCalledWith(expect.objectContaining({ fresh: true }));
    // 扫完把条数交给引导：卡片据此才放开「下一步」。
    expect(settled).toHaveBeenCalledWith(2);
    expect(document.body.textContent).toContain("把分享会的议程拆成待办");
    // 亮区锚点挂在弹窗上，蒙版会罩住整张弹窗。
    expect(document.querySelector("[data-demo-guide='associate-pick']")).toBeTruthy();
  });

  it("lets nobody tick or save while it is only being shown", async () => {
    const listLocalSessions = vi.fn().mockResolvedValue({ sessions: [session("s-1", "把分享会的议程拆成待办")], refreshing: false });
    await render({ demoGuide: true, listLocalSessions });

    // 正文整块 inert：勾选框、Agent 切换、搜索都点不到也聚焦不到。
    expect(document.querySelector("[inert]")).toBeTruthy();
    const buttons = () => Array.from(document.querySelectorAll("button")).map((entry) => entry.textContent?.trim() ?? "");
    expect(buttons()).not.toContain("保存");
    // 关闭按钮也收起：不能把人从引导里带出去。
    expect(document.querySelector("[aria-label='关闭']")).toBeNull();
    // 底部只写「这里只做展示」，没有可点的按钮。
    expect(document.body.textContent).toContain("这里只做展示，不会改动任何任务。");
  });

  it("keeps the normal picker untouched when the guide is not showing it", async () => {
    const listLocalSessions = vi.fn().mockResolvedValue({ sessions: [session("s-1", "把分享会的议程拆成待办")], refreshing: false });
    await render({ listLocalSessions });

    // 普通打开：没有展示锚点，正文可以操作，「保存」照常出现。
    expect(document.querySelector("[data-demo-guide='associate-pick']")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.body.textContent).toContain("保存");
    // 普通路径先读缓存，不是每次都等一次全量扫描。
    expect(listLocalSessions).toHaveBeenCalledWith(expect.not.objectContaining({ fresh: true }));
  });
});
