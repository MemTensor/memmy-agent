// @vitest-environment happy-dom

/**
 * 提示条怎么称呼留下任务的成员：一个人说名字，两个人并列，三个人以上只点第一位加人数。
 * 提示条只有一行，名字长了会把「输入 @ 可引用」挤掉，所以这里按人数分别固定住。
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
  listSessions: vi.fn(),
  listMembers: vi.fn(),
  knowledge: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
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
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "产品场景包", rootPath: "/tmp/scenarios", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: []
      }
    },
    dispatch: mocks.dispatch
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "产品场景包",
  role: "owner",
  memberCount: 4,
  sessionCount: 3,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

function otherSession(id: string, memberName: string) {
  return {
    id,
    projectId: project.id,
    projectName: project.name,
    title: `${memberName} 的任务`,
    lastQuestion: "这个场景怎么拆",
    memberName,
    mine: false,
    source: "codex",
    turnCount: 2,
    lastActiveAt: "2026-10-30T04:08:00.000Z",
    link: `https://memmy.test/s/${id}`,
    shareText: `【Memmy】${memberName} 的任务`
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab context tip members", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    window.localStorage.clear();
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.listMembers.mockResolvedValue({ project, joinMode: "approval", canManage: true, members: [], requests: [] });
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  async function renderBoard(sessions: ReturnType<typeof otherSession>[]): Promise<void> {
    mocks.listSessions.mockResolvedValue({ project, sessions, total: sessions.length });
    mocks.readSessionDetail.mockResolvedValue({ session: sessions[0], turns: [] });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("lists both names when two members left tasks", async () => {
    await renderBoard([otherSession("s-1", "李四"), otherSession("s-2", "王五")]);
    expect(document.body.textContent).toContain("李四、王五已在这里留下 2 条对话");
  });

  it("points at the first member and counts the rest past two", async () => {
    await renderBoard([otherSession("s-1", "李四"), otherSession("s-2", "王五"), otherSession("s-3", "赵六")]);
    expect(document.body.textContent).toContain("李四等 3 位成员已在这里留下 3 条对话");
  });

  it("counts a member's several tasks once in the name list", async () => {
    await renderBoard([otherSession("s-1", "李四"), otherSession("s-2", "李四")]);
    expect(document.body.textContent).toContain("李四已在这里留下 2 条对话");
  });
});
