// @vitest-environment happy-dom

/**
 * 协作项目的首次引导（teach mode）。
 * 断言落在三件事上：第一次建立协作时才出现、六步的顺序与演示内容对得上、完成或跳过都记在本机，
 * 以及项目设置里能重新查看。样式与位置不在这里测。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestCollabTour,
  resetCollabProjectsStore
} from "../../app/collab-projects-store.js";
import { COLLAB_TOUR_SEEN_STORAGE_KEY } from "../collab-tour.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  readSessionDetail: vi.fn(),
  readReference: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  listProjectTasks: vi.fn(),
  dispatch: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

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
  memberCount: 1,
  sessionCount: 0,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
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

function tourDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    .find((entry) => entry.getAttribute("aria-modal") === "true" && entry.className.includes("bubble")) ?? null;
}

/** 一段文字在页面上出现几次：示例行只能渲染一份。 */
function countText(text: string): number {
  return Array.from(document.querySelectorAll("li"))
    .filter((entry) => entry.textContent?.includes(text)).length;
}

async function click(text: string): Promise<void> {
  const button = buttonByText(text);
  expect(button, `应有「${text}」按钮`).toBeTruthy();
  await act(async () => button!.click());
  await flush();
}

describe("collab board teach mode", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    window.localStorage.clear();
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.listProjectTasks.mockResolvedValue([]);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  it("走完六步，最后一步把完成记录写在本机", async () => {
    requestCollabTour("local-1");
    await mount();

    // 第一步先说清这个区域与项目里的任务是什么。
    expect(document.body.textContent).toContain("这里是项目看板");
    expect(document.body.textContent).toContain("1/6");
    // 第一步没有上一步。
    expect(buttonByText("上一步")).toBeUndefined();
    // 空项目的说明卡片让位给引导：同一件事不在两处讲。
    expect(document.body.textContent).not.toContain("项目暂无任务");
    // 还没到「通过对话共享」这一步，共享进来的那条示例任务不出现。
    expect(document.body.textContent).not.toContain("首页改版走查");
    // 示例行只能渲染一份：之前两处都渲染过，同一个成员任务会在列表里重复两次。
    expect(countText("支付接口联调")).toBe(1);

    await click("下一步"); // 邀请成员
    // 从第二步起可以回看。
    await click("上一步");
    expect(document.body.textContent).toContain("这里是项目看板");
    expect(buttonByText("上一步")).toBeUndefined();

    await click("下一步"); // 邀请成员
    await click("下一步"); // 关联任务
    await click("下一步"); // 通过对话共享任务
    expect(document.body.textContent).toContain("通过对话共享任务");
    expect(document.body.textContent).toContain("首页改版走查");
    expect(countText("支付接口联调")).toBe(1);
    expect(countText("首页改版走查")).toBe(1);
    // 对话示意里带上项目名，是成员真的会在 Agent 里说的那句话。
    expect(document.body.textContent).toContain("把这个任务加入 Memmy 的「Memmy项目协作记忆」项目");

    await click("下一步"); // 继续任务
    expect(document.body.textContent).toContain("继续任务");
    expect(document.body.textContent).toContain("帮我继续这部分工作");

    await click("下一步"); // 新建第一个任务
    expect(document.body.textContent).toContain("新建第一个任务");

    await click("开始使用");
    expect(tourDialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_TOUR_SEEN_STORAGE_KEY)).toBe("1");
  });

  it("跳过引导同样记为看过，再次建立协作时不再出现", async () => {
    requestCollabTour("local-1");
    await mount();
    expect(tourDialog()).toBeTruthy();

    await click("跳过引导");
    expect(tourDialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_TOUR_SEEN_STORAGE_KEY)).toBe("1");

    // 再建一个协作项目时不会重看一遍。
    await act(async () => root.unmount());
    resetCollabProjectsStore();
    root = createRoot(container);
    requestCollabTour("local-1");
    await mount();
    expect(tourDialog()).toBeNull();
  });

  it("看过之后，项目设置里可以重新查看引导", async () => {
    window.localStorage.setItem(COLLAB_TOUR_SEEN_STORAGE_KEY, "1");
    await mount();
    expect(tourDialog()).toBeNull();

    const settings = document.querySelector<HTMLElement>('button[aria-label="项目设置"]');
    expect(settings, "看板头部应有项目设置入口").toBeTruthy();
    await act(async () => settings!.click());
    await flush();

    await click("重新查看");
    expect(document.body.textContent).toContain("这里是项目看板");
    expect(tourDialog()).toBeTruthy();
  });

  it("重看引导时整页都是示例页，不混入项目里已有的任务", async () => {
    mocks.listSessions.mockResolvedValue({
      project,
      sessions: [{
        id: "s-1",
        projectId: project.id,
        projectName: project.name,
        title: "已有的真实任务",
        lastQuestion: "这条不该出现在引导里",
        memberName: "孙起",
        mine: true,
        source: "memmy",
        turnCount: 2,
        lastActiveAt: "2026-10-29T07:25:00.000Z",
        link: "memmy://collab/p-1/s-1",
        shareText: "Memmy 协作会话：已有的真实任务"
      }],
      total: 1
    });
    window.localStorage.setItem(COLLAB_TOUR_SEEN_STORAGE_KEY, "1");
    await mount();
    expect(document.body.textContent).toContain("已有的真实任务");

    const settings = document.querySelector<HTMLElement>('button[aria-label="项目设置"]');
    await act(async () => settings!.click());
    await flush();
    await click("重新查看");

    // 引导期间只展示示例行：真实任务、成员提示都不出现。
    expect(document.body.textContent).toContain("这里是项目看板");
    expect(document.body.textContent).not.toContain("已有的真实任务");
    expect(document.body.textContent).not.toContain("成员已在这里留下 1 条对话");
    expect(document.body.textContent).toContain("支付接口联调");

    await click("跳过引导");
    expect(document.body.textContent).toContain("已有的真实任务");
  });
});
