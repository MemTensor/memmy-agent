// @vitest-environment happy-dom

/**
 * 开启共享后回到看板时的「在其他 Agent 中使用协作项目」授权询问。
 *
 * 看板不再有首次引导，所以询问从「引导结束」挪到了「共享刚开启、云端记录读回来之后」。断言落在四件事上：
 * 刚开启共享且未授权时问一次、关掉之后不再问；已授权或之前选过「暂不安装」不再问；
 * 选择任务的弹窗开着时先不问，关掉它之后再问；普通打开看板与加入他人项目的行为不变。
 * 样式与位置不在这里测。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView } from "../../api/collab-client.js";
import {
  requestCollabAccessPrompt,
  requestTaskPicker,
  resetCollabProjectsStore
} from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  readSessionDetail: vi.fn(),
  readReference: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  listProjectTasks: vi.fn(),
  saveProjectTasks: vi.fn(),
  getAgentAccess: vi.fn(),
  setAgentAccess: vi.fn(),
  markAgentAccessAsked: vi.fn(),
  dispatch: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{
          id: "local-1",
          name: "Memmy项目协作记忆",
          rootPath: "/tmp/memmy",
          pinned: false,
          createdAt: "2026-10-21T03:00:00.000Z"
        }],
        tasks: [],
        blankDraftActive: false,
        newChatRequestId: 2,
        composerDraftsByScope: {},
        composerPendingAttachmentsByScope: {},
        composerMentionsByScope: {}
      }
    },
    dispatch: mocks.dispatch
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 云端的授权状态：字段照 api/collab-client.ts 的 CollabAgentAccessView。 */
function accessView(overrides: Partial<CollabAgentAccessView> = {}): CollabAgentAccessView {
  return {
    granted: false,
    askedInProject: false,
    agents: [
      { sourceId: "cursor", name: "Cursor", available: true, enabled: true, installed: false, added: false },
      { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: false, added: false }
    ],
    ...overrides
  };
}

const ownerProject = {
  id: "p-1",
  name: "Memmy项目协作记忆",
  role: "owner",
  memberCount: 1,
  sessionCount: 0,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const memberProject = { ...ownerProject, role: "member", memberCount: 3 };

/** 云端此刻记着的授权状态：断言用它确认「已经问过」。 */
let currentAccess: CollabAgentAccessView;
/** 这次挂载读到的是哪个项目：所有者与加入者的用例各自替换。 */
let listedProject: typeof ownerProject | typeof memberProject;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function buttonByText(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("button"))
    .find((entry) => entry.textContent?.trim() === text);
}

/** 打开了哪个弹窗：按文案区分授权与选择任务，不依赖样式类名。 */
function dialogContaining(text: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    .find((entry) => entry.textContent?.includes(text)) ?? null;
}

function accessDialog(): HTMLElement | null {
  return dialogContaining("授权后，你可以：");
}

function taskPickerDialog(): HTMLElement | null {
  return dialogContaining("选择要同步的任务");
}

async function click(text: string): Promise<void> {
  const button = buttonByText(text);
  expect(button, `应有「${text}」按钮`).toBeTruthy();
  await act(async () => button!.click());
  await flush();
}

describe("collab board agent access prompt after sharing", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  async function remount(): Promise<void> {
    await act(async () => root.unmount());
    resetCollabProjectsStore();
    root = createRoot(container);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    window.localStorage.clear();
    currentAccess = accessView();
    listedProject = ownerProject;

    mocks.listProjects.mockImplementation(() => Promise.resolve([listedProject]));
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project: listedProject, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.getAgentAccess.mockImplementation(() => Promise.resolve(currentAccess));
    mocks.markAgentAccessAsked.mockImplementation(() => {
      currentAccess = { ...currentAccess, askedInProject: true };
      return Promise.resolve(currentAccess);
    });
    mocks.setAgentAccess.mockImplementation(() => Promise.resolve({
      view: { ...currentAccess, granted: true },
      results: []
    }));

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  it("刚刚开启共享时询问一次，关掉之后不再询问", async () => {
    requestCollabAccessPrompt("local-1");
    await mount();

    // 未授权、也没问过：开启共享后回到看板就弹出来。
    expect(accessDialog()).toBeTruthy();
    expect(accessDialog()?.textContent).toContain("在其他 Agent 中使用协作项目");
    // 看板本身照常渲染：空项目的说明还在，引导遮罩不再出现。
    expect(document.body.textContent).toContain("项目暂无任务");

    await click("暂不授权");
    expect(accessDialog()).toBeNull();
    expect(mocks.markAgentAccessAsked).toHaveBeenCalled();
    expect(currentAccess.askedInProject).toBe(true);

    // 再次开启共享回到看板：云端记着已经问过，不再弹第二次。
    await remount();
    requestCollabAccessPrompt("local-1");
    await mount();
    expect(accessDialog()).toBeNull();
  });

  it("已授权时不再询问", async () => {
    currentAccess = accessView({ granted: true });
    requestCollabAccessPrompt("local-1");
    await mount();

    expect(accessDialog()).toBeNull();
  });

  it("之前选过「暂不安装」时不再询问", async () => {
    currentAccess = accessView({ askedInProject: true });
    requestCollabAccessPrompt("local-1");
    await mount();

    expect(accessDialog()).toBeNull();
  });

  it("选择任务的弹窗开着时先不问，关掉之后再问", async () => {
    requestCollabAccessPrompt("local-1");
    requestTaskPicker("local-1");
    await mount();

    // 刚开启共享的两步有先后：先选哪些任务共享，再问授权，两个弹窗不叠在一起。
    expect(taskPickerDialog()).toBeTruthy();
    expect(accessDialog()).toBeNull();

    await click("取消");
    expect(taskPickerDialog()).toBeNull();
    expect(accessDialog()).toBeTruthy();
  });

  it("项目设置里开启共享：设置关掉后先选任务，关掉选择任务再问授权", async () => {
    await mount();
    expect(accessDialog()).toBeNull();

    // 设置打开着。
    const settings = document.querySelector<HTMLElement>('button[aria-label="项目设置"]');
    expect(settings, "看板头部应有项目设置入口").toBeTruthy();
    await act(async () => settings!.click());
    await flush();

    // 「开启共享」是一次点击里做完三件事：关掉设置、请求授权、请求选择任务。
    // 请求选择任务的 effect 先消化请求再打开弹窗，同一批里拿不到新的开关状态，所以这里按同样的顺序复现。
    const close = document.querySelector<HTMLElement>('button[aria-label="关闭"]');
    expect(close, "设置弹窗应有关闭按钮").toBeTruthy();
    await act(async () => {
      close!.click();
      requestCollabAccessPrompt("local-1");
      requestTaskPicker("local-1");
    });
    await flush();

    // 两个弹窗不叠在一起：先选任务，授权询问等着。
    expect(taskPickerDialog()).toBeTruthy();
    expect(accessDialog()).toBeNull();

    await click("取消");
    expect(taskPickerDialog()).toBeNull();
    expect(accessDialog()).toBeTruthy();
  });

  it("所有者普通打开看板时不询问", async () => {
    await mount();

    expect(document.body.textContent).toContain("项目暂无任务");
    expect(accessDialog()).toBeNull();
    expect(mocks.getAgentAccess).toHaveBeenCalled();
  });

  it("加入他人项目的人第一次打开看板时询问", async () => {
    listedProject = memberProject;
    mocks.listSessions.mockResolvedValue({ project: memberProject, sessions: [], total: 0 });
    await mount();

    expect(accessDialog()).toBeTruthy();
  });

  it("看板与项目设置里都不再有引导", async () => {
    requestCollabAccessPrompt("local-1");
    await mount();

    // 引导的按钮与示例任务行都不存在。
    expect(buttonByText("跳过引导")).toBeUndefined();
    expect(buttonByText("下一步")).toBeUndefined();
    expect(document.body.textContent).not.toContain("支付接口联调");
    expect(document.body.textContent).not.toContain("首页改版走查");

    const settings = document.querySelector<HTMLElement>('button[aria-label="项目设置"]');
    expect(settings, "看板头部应有项目设置入口").toBeTruthy();
    await act(async () => settings!.click());
    await flush();

    // 设置里不再有「再看一遍协作项目的首次引导」那一行。
    expect(document.body.textContent).not.toContain("再看一遍协作项目的首次引导");
    expect(buttonByText("重新查看")).toBeUndefined();
  });
});
