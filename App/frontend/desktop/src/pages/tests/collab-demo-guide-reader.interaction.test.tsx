// @vitest-environment happy-dom

/**
 * 引导第一步的只读面板要跟着屏开与关。
 *
 * - 点开成员的任务进 `reader`：面板打开，蒙版才有 `reader-panel` 可以框。
 * - 退回任务行（`task-row`）：面板必须关掉，不然它盖住那一行，蒙版亮的却是被盖住的位置。
 * - 再从输入框退回 `reader`：面板重新打开，否则锚点不存在，整块蒙版什么也画不出来。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import {
  DEMO_GUIDE_COPY_FALLBACK,
  resetDemoGuideStore,
  setDemoGuideStateForTest,
  type DemoGuidePhase,
  type DemoGuideState
} from "../../app/collab-demo-guide-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listAddedAgents: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  knowledge: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
  listLocalSessions: vi.fn(),
  listMembers: vi.fn(),
  readAssistThreads: vi.fn(),
  assistInbox: vi.fn(),
  tasks: [] as Array<{ sessionKey: string; projectId: string | null; title: string; archived?: boolean; updatedAt?: string }>,
  dispatch: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: React.ReactNode }) => <div>{props.children}</div>
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "项目协作体验", rootPath: "/Users/me/demo", pinned: false, createdAt: "2026-11-16T03:00:00.000Z" }],
        tasks: mocks.tasks
      }
    },
    dispatch: mocks.dispatch
  }),
  // 看板只用到可选的读取入口；同模块的 `useAppState` 在别的组件里被引用，补一个空实现避免取不到导出。
  useAppState: () => ({ state: { agent: { projects: [], tasks: [] } }, dispatch: mocks.dispatch })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: "项目协作体验",
  role: "owner",
  memberCount: 2,
  sessionCount: 2,
  createdAt: "2026-11-16T03:00:00.000Z",
  localProjectId: "local-1"
};

const MEMBER_SESSION = {
  id: "s-demo",
  projectId: CLOUD_PROJECT.id,
  projectName: CLOUD_PROJECT.name,
  title: "下周五的团队分享会",
  lastQuestion: "三楼哪个会议室合适？议程也帮我排一下。",
  memberName: "小饭团",
  mine: false,
  source: "memmy",
  turnCount: 2,
  lastActiveAt: "2026-11-16T09:05:00.000Z",
  link: "https://memmy.test/s/s-demo",
  shareText: "【Memmy】下周五的团队分享会"
};

const MY_SESSION = {
  ...MEMBER_SESSION,
  id: "s-mine",
  title: "通知文案",
  memberName: "孙起",
  mine: true
};

function demoState(phase: DemoGuidePhase): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    copy: DEMO_GUIDE_COPY_FALLBACK,
    error: null,
    done: { task: false, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    askSeen: false,
    askDelivered: false,
    askTurnEnded: false,
    scan: { status: "idle", count: 0 },
    prefill: null,
    endReason: null,
    cloudEnded: false
  } as DemoGuideState;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("the demo guide and the read panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tasks = [];
    resetCollabProjectsStore();
    resetDemoGuideStore();
    mocks.listProjects.mockResolvedValue([CLOUD_PROJECT]);
    mocks.listSessions.mockResolvedValue({
      project: CLOUD_PROJECT,
      sessions: [MEMBER_SESSION, MY_SESSION],
      total: 2
    });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.readSessionDetail.mockResolvedValue({ session: MEMBER_SESSION, turns: [] });
    mocks.listLocalSessions.mockResolvedValue({ sessions: [], refreshing: false });
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [],
      requests: []
    });
    mocks.readAssistThreads.mockResolvedValue({ threads: [], maxThreads: 20 });
    mocks.assistInbox.mockResolvedValue({ requests: [] });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    resetDemoGuideStore();
  });

  async function renderBoard(phase: DemoGuidePhase): Promise<void> {
    setDemoGuideStateForTest(demoState(phase), null);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  async function moveTo(phase: DemoGuidePhase): Promise<void> {
    setDemoGuideStateForTest(demoState(phase), null);
    await flush();
  }

  const panel = () => document.querySelector('[data-demo-guide="reader-panel"]');

  it("opens the member's task when the first step reaches the read panel", async () => {
    await renderBoard("reader");
    expect(panel()).not.toBeNull();
    expect(mocks.readSessionDetail).toHaveBeenCalledWith("s-demo");
  });

  it("closes the panel again when the person goes back to the task row", async () => {
    await renderBoard("reader");
    expect(panel()).not.toBeNull();

    await moveTo("task-row");
    // 面板关掉，任务行才露出来：蒙版亮的正是那一行。
    expect(panel()).toBeNull();
    expect(document.querySelector('[data-demo-guide="board-task-row"]')).not.toBeNull();
  });

  it("reopens the panel when the person backs out of the composer into the read panel", async () => {
    // 从输入框退回只读面板：面板不在时 `reader-panel` 锚点也没有，蒙版会一片空白。
    await renderBoard("compose");
    expect(panel()).toBeNull();

    await moveTo("reader");
    expect(panel()).not.toBeNull();
  });
});
