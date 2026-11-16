// @vitest-environment happy-dom

/**
 * 新建项目之后落在哪儿。未开共享的项目直接进入它的新会话面板（与 Codex 一致：落地就能写第一句话）；
 * 试过共享的那条路径仍回看板，共享成功后的授权询问与共享/额度提示都挂在那里。
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { ApiClientsContext } from "../../app/providers.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider } from "../../lib/task-bus.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { defaultAgentSidebarState } from "../../state/agent-chat-slice.js";
import { AppStateProvider, useAppState, type AppStateContextValue } from "../../state/app-state.js";
import { AppFrame, resolveSelectedSidebarProjectId } from "../app-frame.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const runtime = vi.hoisted(() => ({
  enqueueSidebarIntent: vi.fn(() => Promise.resolve()),
  mutateProject: vi.fn()
}));

// 托管目录由本机后端准备：这里只关心建好之后落在哪儿。
vi.mock("../../api/projects-client.js", () => ({
  prepareProjectDirectory: () => Promise.resolve("/Users/me/.memmy/local-projects/测试")
}));

vi.mock("../../app/agent-runtime-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../app/agent-runtime-bridge.js")>(),
  useOptionalAgentRuntimeBridge: () => ({
    connection: { getReadyGeneration: () => 1, submitMessage: () => Promise.resolve() },
    ensureChatSubscription: () => undefined,
    taskStateCoordinator: {
      mutateProject: runtime.mutateProject,
      enqueueSidebarIntent: runtime.enqueueSidebarIntent,
      refreshTaskState: () => undefined
    }
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clients = {
  runtimeConfig: { baseUrl: "http://127.0.0.1:1", localToken: "token" },
  memmyAgent: null
} as unknown as AppClients;

const PROJECT = {
  id: "local-1",
  name: "测试",
  rootPath: "/Users/me/.memmy/local-projects/测试",
  pinned: false,
  createdAt: "2026-11-13T00:00:00.000Z"
};

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("new project landing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let app: AppStateContextValue;

  function ObserveState() {
    app = useAppState();
    return null;
  }

  function Shell() {
    const { dispatch } = useAppState();
    useEffect(() => {
      dispatch(appActions.bootstrapLoaded(mockBootstrap, "/main"));
      // 侧栏的「项目」分组默认是折叠的：新建之后应当自己展开，项目行才看得见。
      dispatch(agentActions.sidebarStateLoaded({
        ...defaultAgentSidebarState,
        collapsed_groups: { projects: true }
      }));
    }, [dispatch]);
    return (
      <AppFrame title="项目">
        <div>工作区</div>
      </AppFrame>
    );
  }

  beforeEach(async () => {
    resetCollabProjectsStore();
    vi.clearAllMocks();
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { platform: "darwin", getLogLevel: () => Promise.resolve("info") }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.mutateProject.mockImplementation(async () => {
      // 真实协调器提交后会把项目写回状态：这里同样补上，侧栏与草稿才找得到它。
      app.dispatch(agentActions.sessionSnapshotApplied({
        projectRegistryState: "ready",
        projects: [PROJECT],
        sessions: []
      }));
      return { status: "committed", project: { id: PROJECT.id } };
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <ApiClientsContext.Provider value={{ clients, setClients: () => undefined }}>
            <TaskBusProvider>
              <I18nProvider language="zh-CN">
                <ObserveState />
                <Shell />
              </I18nProvider>
            </TaskBusProvider>
          </ApiClientsContext.Provider>
        </AppStateProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    vi.unstubAllGlobals();
  });

  function dialogNameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    expect(input, "新建项目弹窗的名称输入框应已渲染").toBeTruthy();
    return input!;
  }

  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitButton(): HTMLElement {
    const target = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((button) => button.textContent?.trim() === "创建项目");
    expect(target, "创建项目按钮应已渲染").toBeTruthy();
    return target!;
  }

  async function createProject(options: { share: boolean }) {
    await act(async () => container.querySelector<HTMLButtonElement>("button.app-frame-workspace-add")!.click());
    await flush();
    await act(async () => type(dialogNameInput(), "测试"));
    if (options.share) {
      await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="switch"]')!.click());
    }
    await act(async () => submitButton().click());
    await flush();
  }

  it("lands a project that was never meant to be shared in its own new session", async () => {
    await createProject({ share: false });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(app.state.navigation.currentPath).toBe("/main");
    // 空白草稿的目标就是这个新项目：标题与输入框上方的项目选择器都靠它。
    expect(app.state.agent.draftTargetsByScope).toMatchObject({
      [`draft-${app.state.agent.newChatRequestId}`]: { kind: "project", projectId: PROJECT.id }
    });
    expect(resolveSelectedSidebarProjectId(app.state.agent, app.state.navigation.currentPath)).toBe(PROJECT.id);
    // 折叠着的「项目」分组被展开，项目行可见。
    expect(runtime.enqueueSidebarIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "set-collapsed",
      groupKey: "projects",
      collapsed: false
    }));
    expect(container.textContent).toContain("测试");
  });

  it("keeps a project whose sharing was attempted on its board", async () => {
    // 云端不可达：共享失败退回本机，但项目仍然回看板，提示显示在那里。
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await createProject({ share: true });

    expect(app.state.navigation.currentPath).toBe("/collab");
    expect(getCollabProjectsSnapshot().selectedId).toBe(PROJECT.id);
    expect(app.state.agent.draftTargetsByScope).not.toHaveProperty(
      `draft-${app.state.agent.newChatRequestId}`
    );
    warn.mockRestore();
  });
});
