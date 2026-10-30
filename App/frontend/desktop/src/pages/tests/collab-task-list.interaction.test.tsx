// @vitest-environment happy-dom

/**
 * The board displays a continuous, paginated task list with a member filter and row timestamps.
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
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  knowledge: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
  listMembers: vi.fn(),
  /** 侧栏/看板用的本机任务列表与 dispatch：点开本人任务时要落到会话页。 */
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
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

vi.mock("../../state/app-state.js", () => ({
  // 内联在工厂里：vi.mock 会被提升到模块顶部，引用模块级常量会先在初始化前取到。
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "Memmy 开发", rootPath: "/Users/me/Memmy", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: mocks.tasks
      }
    },
    dispatch: mocks.dispatch
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: "Memmy 开发",
  role: "owner",
  memberCount: 2,
  sessionCount: 3,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: "local-1"
};

/* 看板属于本机的项目，共享是它上面的一层；云端项目通过 localProjectId 挂到该项目上（见上面的 mock）。 */

/** A moment today, yesterday, or `daysAgo` days back, so the day headings are stable whatever the hour. */
function daysBack(days: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function session(index: number, input: { title: string; lastQuestion: string; mine: boolean; lastActiveAt: string }) {
  return {
    id: `s-${index}`,
    projectId: CLOUD_PROJECT.id,
    projectName: CLOUD_PROJECT.name,
    title: input.title,
    lastQuestion: input.lastQuestion,
    memberName: input.mine ? "林晓" : "陈墨",
    mine: input.mine,
    source: "claude_code",
    turnCount: 4,
    lastActiveAt: input.lastActiveAt,
    link: `https://memmy.test/s/s-${index}`,
    shareText: `【Memmy】${input.title}`
  };
}

const SESSIONS = [
  session(1, { title: "事项页的视觉重做", lastQuestion: "C 端产品，高级简约最重要。", mine: true, lastActiveAt: daysBack(0, 9, 5) }),
  session(2, { title: "删除成员权重", lastQuestion: "权重相关的字段和文案都去掉。", mine: true, lastActiveAt: daysBack(1, 14, 20) }),
  session(3, { title: "任务按额度滚动保留", lastQuestion: "每人每项目保留多少个合适？", mine: false, lastActiveAt: daysBack(12, 11, 0) })
];

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab task list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tasks = [];
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([CLOUD_PROJECT]);
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: SESSIONS, total: SESSIONS.length });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.readSessionDetail.mockResolvedValue({ session: SESSIONS[2], turns: [] });
    // 默认没有待审核的申请：看板开着的轮询不该改到其它用例的界面。
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [],
      requests: []
    });

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

  it("displays every task on the page in the returned order, without time sections", async () => {
    await renderBoard();
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => SESSIONS.find((entry) => row.textContent?.includes(entry.title))?.id)).toEqual(["s-1", "s-2", "s-3"]);
    expect(container.querySelectorAll("h2 button")).toHaveLength(0);
    // 本人的任务也写昵称，不再用「你」。
    expect(document.body.textContent).toContain("林晓 · 09:05");
    expect(document.body.textContent).toContain("林晓 · 昨天");
    expect(document.body.textContent).toMatch(/陈墨 · \d{1,2}月\d{1,2}日/);
  });

  it("hides a summary that stopped on an agent's task notification", async () => {
    // Cursor 把 shell 完成通知写成了一轮，旧记录里摘要就停在这串标签上；任务行只留标题。
    const notified = session(9, {
      title: "Codex login record removal",
      lastQuestion: "<timestamp>Friday, Oct 30, 2026, 12:08 PM (UTC+8)</timestamp> <system_notification> The following task has finished.",
      mine: true,
      lastActiveAt: daysBack(0, 12, 8)
    });
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [notified], total: 1 });
    await renderBoard();

    expect(container.textContent).toContain("Codex login record removal");
    expect(container.textContent).not.toContain("<timestamp>");
    expect(container.textContent).not.toContain("system_notification");
  });

  it("shows the join requests waiting on the invite button, without opening the dialog", async () => {
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [],
      requests: [
        { userId: "10", name: "苏禾", inviterName: "林晓", createdAt: null },
        { userId: "11", name: "许一", inviterName: "林晓", createdAt: null }
      ]
    });
    await renderBoard();
    const invite = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent?.includes("邀请"));
    expect(invite, "看板头部应有「邀请」入口").toBeTruthy();
    expect(invite!.title).toBe("2 个加入申请待审核");
    expect(invite!.textContent).toContain("2");
  });

  it("shows 10 tasks on the first page and loads the next page", async () => {
    const all = Array.from({ length: 13 }, (_, index) => ({ ...SESSIONS[0]!, id: `page-${index}`, title: `任务 ${index + 1}` }));
    mocks.listSessions.mockImplementation(async (_project, options) => ({
      project: CLOUD_PROJECT,
      sessions: all.slice(options.offset, options.offset + options.limit),
      total: all.length
    }));
    await renderBoard();
    expect(container.querySelectorAll("li")).toHaveLength(10);
    const next = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((entry) => entry.textContent?.trim() === "下一页");
    expect(next).toBeTruthy();
    await act(async () => next!.click());
    await flush();
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.textContent).toContain("任务 11");
    expect(mocks.listSessions).toHaveBeenLastCalledWith(CLOUD_PROJECT.id, expect.objectContaining({ offset: 10, limit: 10 }));
  });

  it("filters by member from the segmented control", async () => {
    await renderBoard();
    const segment = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === "我的");
    expect(segment, "筛选胶囊里应有「我的」").toBeTruthy();
    expect(segment!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => segment!.click());
    await flush();

    expect(mocks.listSessions).toHaveBeenLastCalledWith(CLOUD_PROJECT.id, expect.objectContaining({ member: "me" }));
  });

  it("selects and clears only the current page's own tasks", async () => {
    const rows = SESSIONS.map((entry) => ({ ...entry, lastActiveAt: daysBack(0, 9, 5) }));
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: rows, total: rows.length });
    await renderBoard();
    const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((entry) => entry.textContent?.trim() === label);

    await act(async () => button("多选")!.click());
    const checks = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checks).toHaveLength(2);
    await act(async () => checks[0]!.click());
    expect(document.body.textContent).toContain("已选 1 个");
    expect(button("全选本页")).toBeTruthy();

    await act(async () => button("全选本页")!.click());
    expect(checks.every((check) => check.checked)).toBe(true);
    expect(document.body.textContent).toContain("已选 2 个");
    expect(button("取消全选")).toBeTruthy();
    await act(async () => button("取消全选")!.click());
    expect(checks.every((check) => !check.checked)).toBe(true);
    expect(button("全选本页")).toBeTruthy();
  });

  it("opens the member's own Memmy task in its conversation page instead of the read-only panel", async () => {
    // 本人在 Memmy 里建的任务正文就在本机：点开直接进会话页，不必先给一个只读面板。
    const own = { ...SESSIONS[1]!, source: "memmy", conversationId: "chat-7" };
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [own], total: 1 });
    mocks.tasks = [{ sessionKey: "websocket:chat-7", projectId: "local-1", title: own.title }];
    await renderBoard();

    const title = Array.from(document.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent?.trim() === own.title);
    expect(title, "列表应显示这条任务").toBeTruthy();
    await act(async () => title!.click());
    await flush();

    expect(mocks.readSessionDetail).not.toHaveBeenCalled();
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
    // 没有可用的 Agent 客户端时只切页面，但切换确实发生了。
    expect(mocks.dispatch).toHaveBeenCalled();
  });

  it("opens someone else's session as a floating panel, not a dialog", async () => {
    // 云端里别人的任务用右侧浮起的面板读：看板留在原处，不是抽屉也不是居中弹窗。
    mocks.readSessionDetail.mockResolvedValue({
      session: SESSIONS[2],
      turns: [
        { question: "每人每项目保留多少个？", reply: "先按 20 个滚动保留。", steps: ["Bash"], startedAt: "2026-10-26T15:11:00.000Z" },
        { question: "超出的怎么处理？", reply: "丢弃最早的一轮。", steps: [], startedAt: "2026-10-26T15:20:00.000Z" }
      ]
    });
    await renderBoard();
    const title = Array.from(document.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent?.trim() === SESSIONS[2]!.title);
    expect(title, "列表应显示这条任务").toBeTruthy();

    await act(async () => title!.click());
    await flush();

    const panel = document.querySelector<HTMLElement>("[data-collab-reader]");
    expect(panel, "读取视图应作为浮起的面板出现").toBeTruthy();
    // 面板浮在页面上，不接管整屏：没有 .modal，也不声明成模态
    expect(document.querySelector(".modal")).toBeNull();
    expect(panel!.getAttribute("aria-modal")).toBe("false");
    expect(panel!.querySelector("h2")?.textContent).toBe(SESSIONS[2]!.title);
    expect(panel!.textContent).toContain("仅供查看");
    // 轮次照旧：提问一条、回复一条，工具步骤不出现
    expect(panel!.querySelectorAll('[data-collab-role="user"]')).toHaveLength(2);
    expect(panel!.querySelectorAll('[data-collab-role="agent"]')).toHaveLength(2);
    expect(panel!.textContent).toContain("第 1 轮");
    expect(panel!.textContent).not.toContain("Bash");
    // 一个任务只标一次 Agent 名
    expect(panel!.textContent?.match(/Claude Code/g) ?? []).toHaveLength(1);

    // Esc 关闭，面板回到看板
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
  });
});
