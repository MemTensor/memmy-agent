// @vitest-environment happy-dom

/**
 * 看板上的协助怎么摆：协助只对发起人和执行人可见，不混进项目共享的「全部」；等你处理的在任务列表上方单独提示；
 * 「协助」里没有执行过的请求默认收起，超过项目上限清理过较早的协助时注明；结束了的协助可以从自己的列表中移除。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistRequest, AssistThread } from "../../api/collab-client.js";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listAddedAgents: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn(),
  listMembers: vi.fn(),
  knowledge: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
  assistThreads: vi.fn(),
  assistThread: vi.fn(),
  hideAssistThread: vi.fn(),
  assistAgents: vi.fn().mockResolvedValue({ agents: [], defaultAgent: null }),
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
        projects: [{ id: "local-1", name: "Memmy 内测反馈", rootPath: "/tmp/feedback", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: []
      }
    },
    dispatch: mocks.dispatch
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "Memmy 内测反馈",
  role: "member",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const REQUESTER = { userId: "7", name: "孙起", mine: false };
const ME = { userId: "8", name: "王雨", mine: true };

const session = {
  id: "s-1",
  projectId: project.id,
  projectName: project.name,
  title: "分享弹窗的排查记录",
  lastQuestion: "分享弹窗点两次会报错",
  memberName: "孙起",
  mine: false,
  source: "memmy",
  turnCount: 2,
  lastActiveAt: "2026-11-05T04:08:00.000Z",
  link: "https://memmy.test/s/s-1",
  shareText: "【Memmy】分享弹窗的排查记录"
};

function request(id: string, status: AssistRequest["status"], overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id, projectId: project.id, projectName: project.name, threadId: `t-${id}`, attempt: 1, via: "DeepSeek Harness",
    title: `协助 ${id}`, reason: "", items: ["看版本"], status, agent: status === "done" ? "memmy" : null, scope: null, grant: null,
    steps: [], reply: "", resultItems: [], files: [], failure: null, requester: REQUESTER, executor: ME, mine: false,
    createdAt: "2026-11-05T04:00:00.000Z", decidedAt: null, finishedAt: status === "done" ? "2026-11-05T04:02:00.000Z" : null,
    sourceTask: null, autoRun: false, decidedMinutes: null, deliveredAt: null,
    ...overrides
  };
}

function thread(latest: AssistRequest, overrides: Partial<AssistThread> = {}): AssistThread {
  return {
    threadId: latest.threadId, projectId: project.id, title: latest.title, via: latest.via, agent: latest.agent,
    scope: latest.scope, grant: latest.grant, status: latest.status, attempt: latest.attempt,
    requester: REQUESTER, executor: ME, mine: false, createdAt: latest.createdAt, lastActiveAt: latest.createdAt,
    requests: [latest], conversationId: null,
    ...overrides
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function clickText(text: string): void {
  const target = [...document.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent?.trim() === text);
  if (!target) throw new Error(`没有找到按钮「${text}」`);
  act(() => target.click());
}

function clickTextIn(scope: string, text: string): void {
  const container = [...document.querySelectorAll(scope)].at(-1);
  const target = container ? [...container.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent?.trim() === text) : null;
  if (!target) throw new Error(`没有在 ${scope} 里找到按钮「${text}」`);
  act(() => target.click());
}

describe("assists on the project board", () => {
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
    mocks.listMembers.mockResolvedValue({ project, joinMode: "approval", canManage: false, members: [], requests: [] });
    mocks.listSessions.mockResolvedValue({ project, sessions: [session], total: 1 });
    mocks.readSessionDetail.mockResolvedValue({ session, turns: [] });
    // 首次进入有他人任务时的取用提示与本用例无关：先记为已看过。
    window.localStorage.setItem("memmy.collab.contextTipSeen", JSON.stringify(["local-1", "p-1"]));
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  async function renderBoard(threads: AssistThread[], limit: { maxThreads: number | null; prunedAt: string | null } = { maxThreads: 100, prunedAt: null }): Promise<void> {
    mocks.assistThreads.mockResolvedValue({ threads, open: 0, retentionDays: 30, ...limit });
    mocks.assistThread.mockImplementation(async (_projectId: string, threadId: string) => ({
      thread: { ...threads.find((item) => item.threadId === threadId)!, sourceTask: null },
      serverTime: new Date().toISOString()
    }));
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

  it("keeps assists out of 全部 and only raises the ones waiting for you above the tasks", async () => {
    const waiting = thread(request("w1", "pending"), { title: "看一下 ~/.memmy 的大小" });
    const done = thread(request("d1", "done"));
    await renderBoard([waiting, done]);

    // 「全部」里只有项目任务。
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(0);
    expect(document.body.textContent).toContain("分享弹窗的排查记录");
    // 等你授权的那一条单独提示；已完成的不提示。
    const banner = document.querySelector("[data-collab-assist-waiting]");
    expect(banner?.textContent).toContain("孙起请你协助「看一下 ~/.memmy 的大小」，等你处理");
    // 「协助」上的数字只数等你处理的。
    const filter = [...document.querySelectorAll("button")].find((node) => node.textContent?.startsWith("协助"));
    expect(filter?.textContent).toBe("协助1");

    clickText("去处理");
    await flush();
    expect(document.querySelector("[data-collab-assist-conversation]")?.textContent).toContain("看一下 ~/.memmy 的大小");
  });

  it("does not count an assist that a timed grant will run on its own", async () => {
    const autoRun = thread(request("a1", "pending", { autoRun: true }));
    await renderBoard([autoRun]);
    expect(document.querySelector("[data-collab-assist-waiting]")).toBeNull();
  });

  it("folds requests that never ran and notes when older assists were cleared", async () => {
    const done = thread(request("d1", "done"));
    const rejected = thread(request("r1", "rejected"), { title: "被拒绝的请求" });
    const expired = thread(request("e1", "expired"), { title: "过期的请求" });
    await renderBoard([done, rejected, expired], { maxThreads: 100, prunedAt: "2026-11-05T03:00:00Z" });

    clickText("协助");
    await flush();
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(1);
    expect(document.body.textContent).toContain("较早的协助已按项目上限清理（每个项目最多保留 100 次）");

    clickText("另有 2 条没有执行的请求（未允许、已撤回或已过期）");
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(3);
    clickText("收起没有执行的请求");
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(1);
  });

  it("removes a finished assist only from my own list, after confirming in the panel", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    await renderBoard([done]);
    mocks.hideAssistThread.mockResolvedValue({ threadId: done.threadId, removed: "hidden" });

    clickText("协助");
    await flush();
    act(() => document.querySelector<HTMLElement>("[data-collab-assist-row]")!.click());
    await flush();

    const panel = () => document.querySelector<HTMLElement>("[data-collab-assist-conversation]");
    act(() => [...panel()!.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent === "删除")!.click());
    expect(document.querySelector("[data-assist-remove-confirm]")?.textContent)
      .toContain("移除后你不再看到这次协助，孙起仍能看到；你们都移除后，记录会被删除。");
    mocks.assistThreads.mockResolvedValue({ threads: [], open: 0, retentionDays: 30, maxThreads: 100, prunedAt: null });
    act(() => [...document.querySelector("[data-assist-remove-confirm]")!.querySelectorAll<HTMLElement>("button")]
      .find((node) => node.textContent === "删除")!.click());
    await flush();

    expect(mocks.hideAssistThread).toHaveBeenCalledWith("p-1", done.threadId);
    expect(panel()).toBeNull();
    expect(document.body.textContent).toContain("已从你的列表中移除");
  });

  it("deletes an assist from the row menu, which offers nothing else", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    const running = thread(request("x1", "running", { agent: "memmy" }), { title: "还在跑" });
    await renderBoard([done, running]);
    mocks.hideAssistThread.mockResolvedValue({ threadId: done.threadId, removed: "deleted" });
    clickText("协助");
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>("[data-collab-assist-row]")];
    // 还没结束的那一行没有菜单。
    expect(rows.find((row) => row.textContent?.includes("还在跑"))!.querySelector("[aria-label='更多']")).toBeNull();
    const row = rows.find((item) => item.textContent?.includes("查版本"))!;
    act(() => row.querySelector<HTMLElement>("[aria-label='更多']")!.click());
    const items = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map((node) => node.textContent);
    expect(items).toEqual(["删除"]);
    clickTextIn("[role='menu']", "删除");
    expect(document.body.textContent).toContain("「查版本」将从你的列表中移除，孙起仍能看到；你们都移除后，记录会被删除。");
    mocks.assistThreads.mockResolvedValue({ threads: [running], open: 1, retentionDays: 30, maxThreads: 100, prunedAt: null });
    clickTextIn("[role='dialog']", "删除");
    await flush();

    expect(mocks.hideAssistThread).toHaveBeenCalledWith("p-1", done.threadId);
    expect(document.body.textContent).toContain("你们都已移除，这次协助的记录已删除");
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(1);
  });

  it("selects several finished assists and deletes them together", async () => {
    const first = thread(request("d1", "done"), { title: "第一次" });
    const second = thread(request("d2", "done"), { title: "第二次" });
    const running = thread(request("x1", "running", { agent: "memmy" }), { title: "还在跑" });
    await renderBoard([first, second, running]);
    mocks.hideAssistThread.mockImplementation(async (_project: string, threadId: string) => ({ threadId, removed: "hidden" }));
    clickText("协助");
    await flush();

    clickText("多选");
    // 还没结束的不可勾选。
    expect(document.querySelectorAll("[data-collab-assist-row] input[type='checkbox']")).toHaveLength(2);
    clickText("全选本页");
    expect(document.body.textContent).toContain("已选 2 个");
    clickText("删除");
    expect(document.body.textContent).toContain("选中的 2 次协助将从你的列表中移除，另一方仍能看到；双方都移除后，记录会被删除。");
    mocks.assistThreads.mockResolvedValue({ threads: [running], open: 1, retentionDays: 30, maxThreads: 100, prunedAt: null });
    clickTextIn("[role='dialog']", "删除");
    await flush();

    expect(mocks.hideAssistThread).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("已从你的列表中移除 2 次协助");
    expect(document.querySelectorAll("[data-collab-assist-row]")).toHaveLength(1);
  });

  it("offers no removal while an assist is still running", async () => {
    const running = thread(request("x1", "running", { agent: "memmy" }));
    await renderBoard([running]);
    clickText("协助");
    await flush();
    act(() => document.querySelector<HTMLElement>("[data-collab-assist-row]")!.click());
    await flush();
    const panel = document.querySelector("[data-collab-assist-conversation]")!;
    expect([...panel.querySelectorAll("button")].some((node) => node.textContent === "删除")).toBe(false);
  });
});
