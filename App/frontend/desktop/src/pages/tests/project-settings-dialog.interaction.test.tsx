// @vitest-environment happy-dom

/**
 * 项目设置弹窗：三张卡片各司其职。
 * 已共享的项目只报同步了几个任务、给出「选择任务」，右下角一个危险按钮；未共享的本机项目只有一个开关；
 * API Key 模式只有一句说明。两种情况下都没有页脚。停止共享与退出项目都要先确认，
 * 因为一个会删掉云端项目、一个会离开项目。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import type { CollabClient } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProjectBoardSettingsDialog } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjectTasks: vi.fn(),
  createProject: vi.fn(),
  bindLocalProject: vi.fn(),
  deleteProject: vi.fn(),
  leaveProject: vi.fn(),
  assistReceiving: vi.fn(),
  setAssistReceiving: vi.fn(),
  assistGrants: vi.fn(),
  assistAgents: vi.fn(),
  /** 退出项目成功后要把本机与云端记录对齐，这里只看它被调用过。 */
  removeProject: vi.fn(),
  reloadProjects: vi.fn()
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

vi.mock("../../app/collab-projects-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/collab-projects-store.js")>();
  return {
    ...actual,
    removeCollabProject: mocks.removeProject,
    loadCollabProjects: mocks.reloadProjects
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = {
  id: "local-1",
  name: "Memmy 内测反馈",
  rootPath: "/Users/sunq/.memmy/online-projects/Memmy",
  pinned: false,
  createdAt: "2026-10-21T03:00:00.000Z"
};

const SHARED = {
  id: "cloud-1",
  name: PROJECT.name,
  role: "owner",
  memberCount: 2,
  sessionCount: 0,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: PROJECT.id
};

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    listProjectTasks: mocks.listProjectTasks,
    createProject: mocks.createProject,
    bindLocalProject: mocks.bindLocalProject,
    deleteProject: mocks.deleteProject,
    leaveProject: mocks.leaveProject,
    assistReceiving: mocks.assistReceiving,
    setAssistReceiving: mocks.setAssistReceiving,
    assistGrants: mocks.assistGrants,
    assistAgents: mocks.assistAgents,
    ...overrides
  } as unknown as CollabClient;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === text);
}

function switchNamed(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[role='switch'][aria-label='${label}']`);
}

describe("项目设置弹窗", () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = {
    onClose: vi.fn(),
    onShared: vi.fn(),
    onUnshared: vi.fn(),
    onLeft: vi.fn(),
    onPickSessions: vi.fn(),
    onReplayTour: vi.fn(),
    onNotice: vi.fn(),
    onFailed: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.assistReceiving.mockResolvedValue({ projectId: "cloud-1", enabled: false });
    mocks.setAssistReceiving.mockResolvedValue({ projectId: "cloud-1", enabled: true });
    mocks.assistGrants.mockResolvedValue({ grants: [], dailyLimit: 20 });
    mocks.assistAgents.mockResolvedValue({ agents: [], defaultAgent: "memmy" });
    mocks.reloadProjects.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(overrides: Partial<Parameters<typeof ProjectBoardSettingsDialog>[0]> = {}): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ProjectBoardSettingsDialog
            open
            project={PROJECT}
            shared={SHARED}
            collab={client()}
            shareAvailable
            taskCount={8}
            {...handlers}
            {...overrides}
          />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("未共享的本机项目没有页脚，关闭只在右上角", async () => {
    await render({ shared: null });

    expect(document.querySelector(".modal-footer")).toBeNull();
    expect(button("关闭")).toBeUndefined();
    expect(document.querySelector("button[aria-label='关闭']")).toBeTruthy();
  });

  it("所有者：同步行说明已同步几个任务，选择任务是按钮，右下角是停止共享", async () => {
    mocks.listProjectTasks.mockResolvedValue([{ synced: true }, { synced: false }]);
    await render();

    // 成员数在看板头部，设置里不再重复一行「已共享 · N 位成员」。
    expect(document.body.textContent).not.toContain("已共享");
    expect(document.body.textContent).toContain("同步的任务");
    expect(document.body.textContent).toContain("已同步 1 / 2 个任务");
    // 已共享之后没有共享开关，也不再解释成员为什么不能停。
    expect(switchNamed("与成员共享")).toBeNull();
    expect(document.body.textContent).not.toContain("只有项目所有者可以停止共享");

    const pick = button("选择任务")!;
    expect(pick.tagName).toBe("BUTTON");
    await act(async () => pick.click());
    expect(handlers.onPickSessions).toHaveBeenCalled();

    const stop = button("停止共享")!;
    expect(stop.tagName).toBe("BUTTON");
    expect(stop.closest(".modal-footer")).toBeTruthy();
  });

  it("所有者停止共享：先确认，确认后删除云端项目", async () => {
    mocks.deleteProject.mockResolvedValue({ instructions: "none" });
    await render();

    await act(async () => button("停止共享")!.click());
    const confirmBlock = document.querySelector("[role='alertdialog']")!;
    expect(confirmBlock.closest(".modal-footer")).toBeTruthy();
    expect(confirmBlock.textContent).toContain("停止共享这个项目？");
    // 确认区出现时底部那个按钮不再显示，避免同一句话两处可点。
    expect(Array.from(confirmBlock.querySelectorAll("button")).map((node) => node.textContent))
      .toEqual(["取消", "停止共享"]);

    await act(async () => button("停止共享")!.click());
    await flush();

    expect(mocks.deleteProject).toHaveBeenCalledWith("cloud-1");
    expect(mocks.removeProject).toHaveBeenCalledWith("cloud-1");
    expect(handlers.onUnshared).toHaveBeenCalled();
  });

  it("成员：没有共享开关，右下角是退出项目，确认后离开", async () => {
    mocks.leaveProject.mockResolvedValue(undefined);
    await render({ shared: { ...SHARED, role: "member" } });

    expect(switchNamed("与成员共享")).toBeNull();
    expect(button("停止共享")).toBeUndefined();

    const leave = button("退出项目")!;
    expect(leave.closest(".modal-footer")).toBeTruthy();
    await act(async () => leave.click());
    expect(document.body.textContent).toContain("退出「Memmy 内测反馈」后");
    await act(async () => button("退出项目")!.click());
    await flush();

    expect(mocks.leaveProject).toHaveBeenCalledWith("cloud-1");
    expect(mocks.removeProject).toHaveBeenCalledWith("cloud-1");
    expect(mocks.reloadProjects).toHaveBeenCalled();
    expect(handlers.onLeft).toHaveBeenCalled();
  });

  it("已经不在项目里（404）也算是退出了", async () => {
    mocks.leaveProject.mockRejectedValue(new ApiRequestError("not found", 404, "not_found"));
    await render({ shared: { ...SHARED, role: "member" } });

    await act(async () => button("退出项目")!.click());
    await act(async () => button("退出项目")!.click());
    await flush();

    expect(handlers.onLeft).toHaveBeenCalled();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });

  it("退出失败时说明原因，人还留在项目里", async () => {
    mocks.leaveProject.mockRejectedValue(new Error("network down"));
    await render({ shared: { ...SHARED, role: "member" } });

    await act(async () => button("退出项目")!.click());
    await act(async () => button("退出项目")!.click());
    await flush();

    expect(handlers.onLeft).not.toHaveBeenCalled();
    expect(handlers.onFailed).toHaveBeenCalledWith("network down");
  });

  it("未共享的本机项目：只有一个开关，没有协助卡片、引导行与右下角危险按钮", async () => {
    mocks.createProject.mockResolvedValue({ project: SHARED });
    mocks.bindLocalProject.mockResolvedValue(undefined);
    await render({ shared: null });

    expect(switchNamed("与成员共享")).toBeTruthy();
    expect(document.body.textContent).toContain("开启后可把任务共享给成员，本地文件不会上传。");
    expect(document.body.textContent).not.toContain("接收协助请求");
    expect(document.body.textContent).not.toContain("限时授权");
    expect(document.body.textContent).not.toContain("引导");
    expect(button("停止共享")).toBeUndefined();
    expect(button("退出项目")).toBeUndefined();
    // 没有右下角按钮时页脚整个不出现。
    expect(document.querySelector(".modal-footer")).toBeNull();
    // 未共享时没有同步行。
    expect(document.body.textContent).not.toContain("同步的任务");

    await act(async () => switchNamed("与成员共享")!.click());
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(PROJECT.name, PROJECT.rootPath);
    expect(handlers.onShared).toHaveBeenCalled();
  });

  it("API Key 模式：只有一句说明与项目卡片", async () => {
    await render({ shareAvailable: false, shared: null });

    expect(document.body.textContent).toContain("协作项目需要登录 Memmy 账号。当前是 API Key 模式，项目与任务只保存本机。");
    expect(document.querySelector("[role='switch']")).toBeNull();
    expect(document.body.textContent).toContain("文件夹");
    expect(button("停止共享")).toBeUndefined();
    expect(button("退出项目")).toBeUndefined();
    expect(document.querySelector(".modal-footer")).toBeNull();
  });

  it("同步的任务按读取结果给值：暂无任务、已同步 x / y、读取中写加载中", async () => {
    mocks.listProjectTasks.mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain("暂无任务");

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.listProjectTasks.mockResolvedValue([{ synced: true }, { synced: false }, { synced: true }]);
    await render();
    expect(document.body.textContent).toContain("已同步 2 / 3 个任务");

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.listProjectTasks.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(document.body.textContent).toContain("加载中");
    expect(document.body.textContent).not.toContain("暂无任务");
    expect(document.body.textContent).not.toContain("已同步");
  });

  it("文件夹按 ~ 缩写显示，引导行在项目卡片里", async () => {
    await render();

    expect(document.body.textContent).toContain("文件夹");
    expect(document.body.textContent).toContain("~/.memmy/online-projects/Memmy");
    expect(document.body.textContent).not.toContain("/Users/sunq/.memmy/online-projects/Memmy");
    expect(document.body.textContent).not.toContain(PROJECT.name);
    // 路径说明一行省略，完整路径放在 title 上。
    const path = document.querySelector("[title='/Users/sunq/.memmy/online-projects/Memmy']");
    expect(path?.textContent).toBe("~/.memmy/online-projects/Memmy");
    expect(document.body.textContent).toContain("再看一遍协作项目的首次引导");

    const reveal = button("在文件夹中显示")!;
    expect(reveal.tagName).toBe("BUTTON");
    const replay = button("重新查看")!;
    expect(replay.tagName).toBe("BUTTON");
    await act(async () => replay.click());
    expect(handlers.onReplayTour).toHaveBeenCalled();
  });

  it("限时授权：没有授权写「暂无」，有授权列出成员与换用、结束", async () => {
    await render();
    expect(document.body.textContent).toContain("接收协助请求");
    expect(document.body.textContent).not.toContain("限时授权");
    expect(document.body.textContent).not.toContain("单次最长 15 分钟");

    // 打开开关后读一次授权：先是空的。
    await act(async () => switchNamed("接收协助请求")!.click());
    await flush();
    expect(document.body.textContent).toContain("限时授权");
    expect(document.body.textContent).toContain("暂无");

    mocks.assistReceiving.mockResolvedValue({ projectId: "cloud-1", enabled: true });
    mocks.assistGrants.mockResolvedValue({
      grants: [{
        projectId: "cloud-1",
        projectName: PROJECT.name,
        grantee: { userId: "u-2", name: "孙起", mine: false },
        agent: "claude_code",
        active: true,
        minutes: 60,
        expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
        createdAt: null,
        revokedAt: null
      }],
      dailyLimit: 20
    });
    mocks.assistAgents.mockResolvedValue({
      agents: [{ sourceId: "claude_code", name: "Claude Code", available: true, group: "used", lastActiveAt: null }],
      defaultAgent: "claude_code"
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(document.body.textContent).toContain("限时授权");
    expect(document.body.textContent).toContain("孙起");
    // 首字头像与成员名分两行：头像上是「孙」。
    expect(document.body.textContent).toContain("孙");
    expect(document.body.textContent).toContain("由 Claude Code 执行 · 还剩 42 分钟");
    const revoke = button("结束授权")!;
    expect(revoke.tagName).toBe("BUTTON");
    expect(revoke.closest(".modal-footer")).toBeNull();
    const select = document.querySelector("select[aria-label='孙起的请求由哪个 Agent 执行']");
    expect(select).toBeTruthy();
    // 只剩同步任务那一处「暂无任务」，限时授权本身已有内容。
    expect(document.body.textContent?.split("暂无").length).toBe(2);
  });
});
