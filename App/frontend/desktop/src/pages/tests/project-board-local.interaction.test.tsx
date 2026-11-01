// @vitest-environment happy-dom

/**
 * The project board covers every project. A project that is only on this computer lists its own tasks and leads to
 * the sharing switch; a shared one reads the cloud list, and the same switch stops sharing.
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCollabProjectsSnapshot, loadCollabProjects, resetCollabProjectsStore, showCollabNotice } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  // 项目配置会读关联的知识库；这一层不关心内容，给空列表即可。
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  createProject: vi.fn(),
  bindLocalProject: vi.fn(),
  deleteProject: vi.fn(),
  listLocalSessions: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  saveProjectTasks: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

// The frame is the app chrome around the board; these tests only need the board.
vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

const PROJECT = {
  id: "local-1",
  name: "MemOS产品",
  rootPath: "/Users/me/MemOS-WorkSpace",
  pinned: false,
  createdAt: "2026-10-21T03:00:00.000Z"
};

const TASK = {
  sessionKey: "sess-1",
  chatId: "chat-1",
  title: "整理项目看板需求",
  preview: "把本地项目和协作项目合成一个",
  updatedAt: "2026-10-23T03:11:00.000Z",
  runStartedAt: null,
  completedUnseen: false,
  pinned: false,
  archived: false,
  tags: [],
  projectId: PROJECT.id,
  groupProjectId: PROJECT.id,
  cwd: PROJECT.rootPath,
  missingProject: false
};

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: PROJECT.name,
  role: "owner",
  memberCount: 2,
  sessionCount: 0,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: PROJECT.id
};

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: { agent: { projects: [PROJECT], tasks: [TASK] } },
    dispatch: vi.fn()
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("project board", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.createProject.mockResolvedValue({ project: { ...CLOUD_PROJECT, localProjectId: null } });
    mocks.bindLocalProject.mockResolvedValue(undefined);
    mocks.deleteProject.mockResolvedValue({ instructions: "none" });
    mocks.listLocalSessions.mockResolvedValue({ sessions: [], refreshing: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([
      { conversationId: "conv-1", title: TASK.title, lastQuestion: TASK.preview, updatedAt: TASK.updatedAt, turnCount: 3, included: true, synced: false },
      { conversationId: "conv-2", title: "另一条会话", lastQuestion: "只留本机", updatedAt: "2026-10-22T03:00:00.000Z", turnCount: 1, included: true, synced: false }
    ]);
    mocks.saveProjectTasks.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0, started: 1 });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function renderBoard() {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  function iconButton(label: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    expect(found, `按钮「${label}」应已渲染`).toBeTruthy();
    return found!;
  }

  function button(label: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === label);
    expect(found, `按钮「${label}」应已渲染`).toBeTruthy();
    return found!;
  }

  it("keeps the local board usable and silent when the cloud list fails", async () => {
    // 本地项目与云端无关：云端异常时照常渲染，也不该提示用户云端出问题了。
    mocks.listProjects.mockRejectedValue(new Error("云端返回错误码 50000"));
    await renderBoard();

    expect(document.body.textContent).toContain(PROJECT.name);
    expect(document.body.textContent).toContain(TASK.title);
    expect(document.body.textContent).not.toContain("云端暂时不可用");
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it("tells the person when a shared project cannot reach the cloud", async () => {
    // 已共享的项目依赖云端，刷新失败时提示共享内容读不到，并提供重试。
    mocks.listProjects.mockResolvedValueOnce([CLOUD_PROJECT]);
    await renderBoard();
    mocks.listProjects.mockRejectedValueOnce(new Error("云端返回错误码 50000"));
    await act(async () => {
      await loadCollabProjects(mocks as never);
    });
    await flush();

    expect(document.body.textContent).toContain("云端暂时不可用");
    expect(document.body.textContent).toContain("重试");
  });

  it("shows a transient notice at the top of the board and clears it", async () => {
    // 新建项目时勾了共享但云端失败：落到看板后提示一次，几秒后自动消失。
    vi.useFakeTimers();
    try {
      showCollabNotice("协作项目服务暂时不可用，已先创建为本地项目；稍后可在项目配置中重试。");
      await act(async () => {
        root.render(
          <I18nProvider language="zh-CN">
            <CollabPage />
          </I18nProvider>
        );
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });

      expect(document.body.textContent).toContain("协作项目服务暂时不可用");
      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });
      expect(getCollabProjectsSnapshot().notice).toBeNull();
      expect(document.body.textContent).not.toContain("协作项目服务暂时不可用");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists a local project's own tasks without a sharing reminder", async () => {
    await renderBoard();

    expect(document.body.textContent).toContain("仅本机");
    expect(document.body.textContent).toContain(TASK.title);
    // Nothing is shared yet, so there is nothing to associate with the cloud.
    expect(Array.from(document.querySelectorAll("button")).some((element) => element.textContent?.trim() === "关联任务")).toBe(false);
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it("asks which of the project's own sessions to sync after sharing starts", async () => {
    await renderBoard();

    // Sharing lives in the project settings (右侧是项目配置), so the sessions tab carries no reminder button.
    await act(async () => iconButton("项目设置").click());
    // The settings row uses a switch, not a checkbox.
    await act(async () => document.querySelector<HTMLElement>(".modal-body [role='switch']")!.click());
    await flush();

    expect(mocks.createProject).toHaveBeenCalledWith(PROJECT.name, PROJECT.rootPath);
    expect(mocks.bindLocalProject).toHaveBeenCalledWith(CLOUD_PROJECT.id, PROJECT.id);
    // The project already has sessions, so the person picks which of them members may read.
    expect(document.body.textContent).toContain("选择要同步的任务");
    expect(mocks.listProjectTasks).toHaveBeenCalledWith(CLOUD_PROJECT.id);
    // The request is one-shot: the board consumed it when it opened the picker.
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();

    // Unchecking a session keeps it on this computer, which is what the saved selection says.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("li"));
    const second = rows.find((row) => row.textContent?.includes("另一条会话"));
    expect(second, "会话行应已渲染").toBeTruthy();
    await act(async () => second!.click());
    await act(async () => button("确定").click());
    await flush();

    expect(mocks.saveProjectTasks).toHaveBeenCalledWith(CLOUD_PROJECT.id, ["conv-1"]);
  });
});
