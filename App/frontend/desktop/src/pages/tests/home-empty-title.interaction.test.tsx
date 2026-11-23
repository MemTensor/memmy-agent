// @vitest-environment happy-dom

/**
 * 空白会话页的标题与焦点。草稿目标是一个项目时，标题带出项目名（悬停看完整路径），输入框直接获得焦点；
 * 纯本机草稿保持原来的标题与行为。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { AppProviders, useApiClients, type ApiClientsContextValue } from "../../app/providers.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { useAppState, type AppStateContextValue } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const runtime = vi.hoisted(() => ({
  connection: {
    getReadyGeneration: vi.fn(() => 1),
    submitMessage: vi.fn(() => Promise.resolve()),
    onStatusResult: vi.fn(() => () => undefined),
    onHistoryDagResult: vi.fn(() => () => undefined),
    onChat: vi.fn(() => () => undefined)
  },
  ensureChatSubscription: vi.fn(),
  taskStateCoordinator: { refreshTaskState: vi.fn(), mutateProject: vi.fn() }
}));

vi.mock("../../app/agent-runtime-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../app/agent-runtime-bridge.js")>(),
  useAgentRuntimeBridge: () => runtime
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = {
  id: "project-report",
  name: "测试",
  rootPath: "/Users/me/.memmy/local-projects/测试",
  pinned: false,
  createdAt: "2026-11-13T00:00:00.000Z"
};

type DraftTarget = { kind: "standalone" } | { kind: "project"; projectId: string };

describe("HomePage empty screen title", () => {
  let container: HTMLDivElement;
  let root: Root;
  let app: AppStateContextValue;
  let api: ApiClientsContextValue;

  function ObserveContexts() {
    app = useAppState();
    api = useApiClients();
    return null;
  }

  /** 只画一个空白草稿页：没有历史、没有当前会话。 */
  async function render(language: "zh-CN" | "en-US", target: DraftTarget): Promise<void> {
    await act(async () => root.render(<AppProviders><ObserveContexts /><HomePage /></AppProviders>));
    await act(async () => {
      api.setClients({
        runtimeConfig: {},
        memmyAgent: {
          readWorkspaceEnvironment: vi.fn().mockResolvedValue(null),
          listSlashCommands: vi.fn().mockResolvedValue([])
        }
      } as unknown as AppClients);
      app.dispatch(appActions.bootstrapLoaded({
        ...mockBootstrap,
        app: { ...mockBootstrap.app, language, userMode: "byok" }
      }, "/main"));
      app.dispatch(agentActions.sessionSnapshotApplied({
        projectRegistryState: "ready",
        projects: [PROJECT],
        sessions: []
      }));
      app.dispatch(agentActions.draftTargetUpdated(`draft-${app.state.agent.newChatRequestId}`, target));
    });
    // 焦点用的是 requestAnimationFrame：等这一帧过去再看。
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
  }

  function title(): HTMLHeadingElement {
    const heading = container.querySelector<HTMLHeadingElement>(".home-empty-title");
    expect(heading, "空白页标题应已渲染").toBeTruthy();
    return heading!;
  }

  function composerInput(): HTMLTextAreaElement {
    const input = container.querySelector<HTMLTextAreaElement>(".home-empty-composer textarea");
    expect(input, "空白页输入框应已渲染").toBeTruthy();
    return input!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("names the project in the title and points at its folder", async () => {
    await render("zh-CN", { kind: "project", projectId: PROJECT.id });

    expect(title().textContent).toBe("在 测试 中，我能为你做什么？");
    const name = title().querySelector<HTMLElement>(".home-empty-title__project");
    expect(name?.textContent).toBe("测试");
    // 悬停看完整路径，标题本身不必塞进一长串路径。
    expect(name?.getAttribute("title")).toBe(PROJECT.rootPath);
  });

  it("uses the same sentence in English", async () => {
    await render("en-US", { kind: "project", projectId: PROJECT.id });

    expect(title().textContent).toBe("What can I do for you in 测试?");
  });

  it("keeps the plain title for a standalone draft", async () => {
    await render("zh-CN", { kind: "standalone" });

    expect(title().textContent).toBe("我能为你做什么？");
    expect(title().querySelector(".home-empty-title__project")).toBeNull();
  });

  it("puts the caret in the composer when the draft belongs to a project", async () => {
    await render("zh-CN", { kind: "project", projectId: PROJECT.id });

    // 落地就能写第一句话：不用先点一下输入框。
    expect(document.activeElement).toBe(composerInput());
  });

  it("leaves focus alone for a standalone draft", async () => {
    await render("zh-CN", { kind: "standalone" });

    // 其他进入 /main 的场景保持原样：焦点不自己跑。
    expect(document.activeElement).not.toBe(composerInput());
  });
});
