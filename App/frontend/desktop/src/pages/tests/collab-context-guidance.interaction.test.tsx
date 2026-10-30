// @vitest-environment happy-dom

/**
 * 看板上的三处引导：成员首次进入的单行提示、「使用方式」浮层，以及任务行的「继续任务」。
 * 三者的共同前提是“任务即对话”这件事要被看见，所以断言也落在“话有没有说出口”和
 * “点了之后新任务有没有带上引用”上，而不是样式。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  readSessionDetail: vi.fn(),
  readReference: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  dispatch: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

/** 草稿状态齐全：继续任务要读 newChatRequestId 与草稿内容来判断是复用还是另开一张。 */
vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{
          id: "local-1",
          name: "Memmy项目协作记忆",
          rootPath: "/tmp/memmy",
          pinned: false,
          createdAt: "2026-10-21T03:00:00.000Z"
        }],
        tasks: [],
        blankDraftActive: false,
        newChatRequestId: 2,
        composerDraftsByScope: {},
        composerPendingAttachmentsByScope: {},
        composerMentionsByScope: {}
      }
    },
    dispatch: mocks.dispatch
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "Memmy项目协作记忆",
  role: "owner",
  memberCount: 3,
  sessionCount: 2,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const otherSession = {
  id: "s-2",
  projectId: project.id,
  projectName: project.name,
  title: "接口联调：knowledge search 的 projectOnly",
  lastQuestion: "云端还没升级，先按 projectId 退回",
  memberName: "李四",
  mine: false,
  source: "cursor",
  turnCount: 5,
  lastActiveAt: "2026-10-23T01:12:00.000Z",
  link: "memmy://collab/p-1/s-2",
  shareText: "Memmy 协作会话：接口联调"
};

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function buttonByText(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("button"))
    .find((entry) => entry.textContent?.trim() === text);
}

describe("collab board guidance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    window.localStorage.clear();
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project, sessions: [otherSession], total: 1 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.readSessionDetail.mockResolvedValue({ session: otherSession, turns: [] });
    mocks.readReference.mockResolvedValue({ session: otherSession, text: "第 5 轮：已合入 test 分支。" });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  it("tells a member once that the synced tasks can be referenced with @", async () => {
    expect(document.body.textContent).toContain("成员已在这里留下 1 条对话");

    await act(async () => buttonByText("知道了")!.click());
    await flush();

    expect(document.body.textContent).not.toContain("成员已在这里留下 1 条对话");
    // 按本机项目记住：云端记录重建（停止共享后再共享）时不会重新提示一遍。
    expect(window.localStorage.getItem("memmy.collab.contextTipSeen")).toContain("local-1");
  });

  it("keeps the header free of its own help entry", async () => {
    // 头部不再放「使用方式」浮层：引导交给后续的 teach mode，看板只保留就地的一行提示。
    expect(buttonByText("使用方式")).toBeUndefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("continues someone else's read-only task in a new task with its reference", async () => {
    const row = Array.from(container.querySelectorAll<HTMLElement>("li"))
      .find((entry) => entry.textContent?.includes(otherSession.title));
    expect(row, "任务行应已渲染").toBeTruthy();

    await act(async () => row!.querySelector<HTMLElement>('button[aria-label="更多"]')!.click());
    await flush();

    const action = Array.from(row!.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((entry) => entry.textContent?.trim() === "继续任务");
    expect(action, "菜单应提供「继续任务」").toBeTruthy();

    await act(async () => action!.click());
    await flush();

    // 引用取的是任务全文，取不到才退回链接；这里走的是取到的那条。
    expect(mocks.readReference).toHaveBeenCalledWith(otherSession.shareText);
    const actions = mocks.dispatch.mock.calls.map(([action]) => action);
    expect(actions).toContainEqual({
      type: "agent/draftTargetUpdated",
      scopeKey: "draft-3",
      target: { kind: "project", projectId: "local-1" }
    });
    expect(actions).toContainEqual({
      type: "agent/composerMentionsUpdated",
      scopeKey: "draft-3",
      mentions: [{ id: otherSession.id, title: otherSession.title, reference: "第 5 轮：已合入 test 分支。" }]
    });
    expect(actions).toContainEqual({ type: "navigation/changed", path: "/main" });
  });
});
