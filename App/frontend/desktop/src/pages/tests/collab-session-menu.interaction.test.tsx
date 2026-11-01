// @vitest-environment happy-dom

/**
 * The board's row menu. A row opens the session reader when clicked, and the menu lives inside that row, so
 * every menu click has to stay inside the menu: copying a link shows only the toast, never the reader.
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
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  // 项目配置会读关联的知识库；这一层不关心内容，给空列表即可。
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  readSessionDetail: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  writeText: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

// The board's subject is a project on this computer; sharing only adds its cloud record.
vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "Memmy项目协作记忆", rootPath: "/tmp/memmy", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: []
      }
    },
    dispatch: vi.fn()
  })
}));

// The frame is the app chrome around the board; these tests only need the board.
vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "Memmy项目协作记忆",
  role: "owner",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const session = {
  id: "s-1",
  projectId: project.id,
  projectName: project.name,
  title: "Memmy项目协作记忆方案",
  lastQuestion: "关于Memmy项目协作事项的部分",
  memberName: "快乐团子",
  mine: true,
  source: "claude_code",
  turnCount: 1,
  lastActiveAt: "2026-10-23T03:11:00.000Z",
  link: "memmy://collab/p-1/s-1",
  shareText: "Memmy 协作会话：Memmy项目协作记忆方案"
};

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab session row menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: mocks.writeText },
      configurable: true
    });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project, sessions: [session], total: 1 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.readSessionDetail.mockResolvedValue({ session, turns: [] });
    mocks.writeText.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  function row(): HTMLElement {
    const rows = container.querySelectorAll<HTMLElement>("li");
    const target = Array.from(rows).find((entry) => entry.textContent?.includes(session.title));
    expect(target, "会话行应已渲染").toBeTruthy();
    return target!;
  }

  function moreButton(): HTMLElement {
    const button = row().querySelector<HTMLElement>('button[aria-label="更多"]');
    expect(button, "会话行应有「更多」按钮").toBeTruthy();
    return button!;
  }

  async function openMenu(): Promise<void> {
    await act(async () => moreButton().click());
    await flush();
  }

  function menuItem(label: string): HTMLElement | undefined {
    return Array.from(row().querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((entry) => entry.textContent?.trim() === label);
  }

  it("copies the link and only shows the toast", async () => {
    await openMenu();
    const copy = menuItem("复制链接");
    expect(copy, "菜单应提供「复制链接」").toBeTruthy();

    await act(async () => copy!.click());
    await flush();

    expect(mocks.writeText).toHaveBeenCalledWith(session.shareText);
    expect(document.body.textContent).toContain("链接已复制");
    expect(mocks.readSessionDetail).not.toHaveBeenCalled();
    // 复制不该把读取面板一起打开：面板是浮在看板上的那块，而不是弹窗。
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
    expect(menuItem("复制链接")).toBeUndefined();
  });

  it("opens the reader when the row itself is clicked", async () => {
    const title = Array.from(row().querySelectorAll<HTMLElement>("span"))
      .find((entry) => entry.textContent?.trim() === session.title);
    expect(title, "会话行应显示标题").toBeTruthy();

    await act(async () => title!.click());
    await flush();

    expect(mocks.readSessionDetail).toHaveBeenCalledWith(session.id);
  });

  it("deletes the selected sessions in one batch", async () => {
    mocks.removeSession.mockResolvedValue({ ok: true });
    const buttonByText = (text: string): HTMLElement | undefined =>
      Array.from(document.querySelectorAll<HTMLElement>("button")).find((entry) => entry.textContent?.trim() === text);

    await act(async () => buttonByText("多选")!.click());
    await flush();
    await act(async () => buttonByText("全选本页")!.click());
    await flush();
    expect(document.body.textContent).toContain("已选 1 个");
    expect(buttonByText("取消全选")).toBeTruthy();
    await act(async () => buttonByText("取消全选")!.click());
    expect(document.body.textContent).toContain("已选 0 个");
    expect(buttonByText("全选本页")).toBeTruthy();
    await act(async () => buttonByText("全选本页")!.click());

    await act(async () => buttonByText("删除")!.click());
    await flush();
    // 确认框里只有「删除」这一个同名按钮，另一个带「选中」二字。
    const confirm = Array.from(document.querySelectorAll<HTMLElement>(".modal button"))
      .find((entry) => entry.textContent?.trim() === "删除");
    await act(async () => confirm!.click());
    await flush();

    expect(mocks.removeSession).toHaveBeenCalledWith("p-1", "s-1");
    expect(document.body.textContent).toContain("已删除 1 个任务");
  });

  it("renders a session as a question and a markdown answer, without tool steps", async () => {
    mocks.readSessionDetail.mockResolvedValue({
      session,
      turns: [
        {
          question: "帮我看下部署 *原样*",
          reply: "可以部署。\n\n- 已带上 `memmy-project`\n- 见 [部署说明](/tmp/deploy.md)",
          steps: ["Bash", "Edit"],
          startedAt: "2026-10-26T15:11:00.000Z"
        },
        {
          question: "",
          reply: "",
          steps: ["ReadFile"],
          startedAt: "2026-10-26T15:12:00.000Z"
        },
        {
          question: "再确认一下",
          reply: "已经改完。",
          steps: [],
          startedAt: "2026-10-26T15:20:00.000Z"
        }
      ]
    });
    const title = Array.from(row().querySelectorAll<HTMLElement>("span"))
      .find((entry) => entry.textContent?.trim() === session.title);

    await act(async () => title!.click());
    await flush();

    const users = document.querySelectorAll<HTMLElement>('[data-collab-role="user"]');
    const agents = document.querySelectorAll<HTMLElement>('[data-collab-role="agent"]');
    expect(users).toHaveLength(2);
    expect(agents).toHaveLength(2);
    expect(users[0]?.textContent).toContain("帮我看下部署 *原样*");
    expect(users[0]?.querySelector("em")).toBeNull();
    expect(agents[0]?.textContent).toContain("Claude Code");
    expect(agents[0]?.querySelector("code")?.textContent).toBe("memmy-project");
    expect([...agents[0]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "已带上 memmy-project",
      "见 部署说明"
    ]);
    expect(agents[0]?.querySelector("a")).toBeNull();
    expect(agents[0]?.querySelector("button")).toBeNull();
    expect(agents[1]?.textContent).toContain("已经改完。");
    expect(document.body.textContent).toContain("第 1 轮");
    expect(document.body.textContent).toContain("第 2 轮");
    expect(document.body.textContent).not.toContain("第 3 轮");
    expect(document.body.textContent).not.toContain("执行步骤");
    expect(document.body.textContent).not.toContain("Bash");
    expect(document.body.textContent).not.toContain("ReadFile");
    expect(document.body.textContent).not.toContain("回复");
  });

  it("tells the reader when only the recent turns are kept", async () => {
    mocks.readSessionDetail.mockResolvedValue({ session: { ...session, trimmed: true }, turns: [] });
    const title = Array.from(row().querySelectorAll<HTMLElement>("span"))
      .find((entry) => entry.textContent?.trim() === session.title);

    await act(async () => title!.click());
    await flush();

    // 单会话超出容量上限时，云端只保留近期轮次，阅读弹窗要说清楚。
    expect(document.body.textContent).toContain("该任务仅保留近期记录");
  });

  it("closes the menu without opening the reader when the backdrop is clicked", async () => {
    await openMenu();
    const backdrop = row().querySelector<HTMLElement>('button[aria-label="取消"]');
    expect(backdrop, "菜单打开时应有遮罩").toBeTruthy();

    await act(async () => backdrop!.click());
    await flush();

    expect(menuItem("复制链接")).toBeUndefined();
    expect(mocks.readSessionDetail).not.toHaveBeenCalled();
  });
});
