// @vitest-environment happy-dom

/**
 * 看板只跟「本机项目列表」和「任务列表」有关。全局状态的其它变化（消息流、连接状态、界面开关）
 * 每个事件都会换掉 context 的 value，这里锁定它们不该把整块看板重渲染一遍。
 */
import { act, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

/** 全局状态的最小替身：每 tick 换一个 state 对象，与真实 reducer 的行为一致。 */
const appState = vi.hoisted(() => {
  const projects = [{ id: "local-1", name: "Memmy 开发", rootPath: "/Users/me/Memmy", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }];
  let value = { state: { agent: { projects, tasks: [] as unknown[], tick: 0 } }, dispatch: () => undefined };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => value,
    tick() {
      value = { state: { agent: { ...value.state.agent, tick: value.state.agent.tick + 1 } }, dispatch: value.dispatch };
      for (const listener of listeners) listener();
    }
  };
});

/** 看板把 AppFrame 当自己的外壳：它被调用几次，就等于看板重渲染了几次。 */
const frameRenders = vi.hoisted(() => ({ count: 0 }));

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  knowledge: vi.fn(),
  listMembers: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => {
    frameRenders.count += 1;
    return <div>{props.children}</div>;
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => useSyncExternalStore(appState.subscribe, appState.get, appState.get)
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: "Memmy 开发",
  role: "owner",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: "local-1",
  instructions: ""
};

const SESSIONS = [{
  id: "s-1",
  projectId: CLOUD_PROJECT.id,
  projectName: CLOUD_PROJECT.name,
  title: "事项页的视觉重做",
  lastQuestion: "C 端产品，高级简约最重要。",
  memberName: "林晓",
  mine: true,
  source: "claude_code",
  turnCount: 4,
  lastActiveAt: "2026-10-29T04:05:00.000Z",
  link: "https://memmy.test/s/s-1",
  shareText: "【Memmy】事项页的视觉重做"
}];

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab board render isolation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    frameRenders.count = 0;
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([CLOUD_PROJECT]);
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: SESSIONS, total: SESSIONS.length });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listMembers.mockResolvedValue({ project: CLOUD_PROJECT, joinMode: "approval", canManage: false, members: [], requests: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function renderBoard(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("does not re-render the board for state changes it does not read", async () => {
    await renderBoard();
    const mounted = frameRenders.count;
    expect(container.textContent).toContain("事项页的视觉重做");

    // 模拟后台任务流式输出：每个事件都会让 context 的 value 换成新对象。
    for (let index = 0; index < 20; index += 1) {
      await act(async () => appState.tick());
    }
    await flush();

    expect(frameRenders.count).toBe(mounted);
  });

  it("still re-renders the board when the filter changes", async () => {
    await renderBoard();
    const mounted = frameRenders.count;
    const segment = Array.from(container.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === "我的");
    expect(segment).toBeTruthy();

    await act(async () => segment!.click());
    await flush();

    // 交互本身照旧重渲染：被挡住的只有无关状态变化。
    expect(frameRenders.count).toBeGreaterThan(mounted);
    expect(mocks.listSessions).toHaveBeenLastCalledWith(CLOUD_PROJECT.id, expect.objectContaining({ member: "me" }));
  });
});
