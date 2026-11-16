// @vitest-environment happy-dom

/**
 * 新手引导演示期间的授权询问：演示进行中一律压住，「在其他 Agent 中使用协作项目」的请求留在 store 里，
 * 演示一结束再按原来的时机弹出。没有授权过的用户体验完引导，才第一次被问到这件事。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView } from "../../api/collab-client.js";
import { resetLaunchAuthorizationRuntime } from "../../app/collab-launch-authorization.js";
import {
  getCollabProjectsSnapshot,
  requestCollabAccessPrompt,
  resetCollabProjectsStore
} from "../../app/collab-projects-store.js";
import {
  DEMO_GUIDE_COPY_FALLBACK,
  dispatchDemoGuide,
  resetDemoGuideStore,
  setDemoGuideStateForTest,
  type DemoGuideState
} from "../../app/collab-demo-guide-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
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
  installAgentAccess: vi.fn(),
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
          name: "项目协作体验",
          rootPath: "/tmp/memmy",
          pinned: false,
          createdAt: "2026-11-14T03:00:00.000Z"
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

const project = {
  id: "p-1",
  name: "项目协作体验",
  role: "owner",
  memberCount: 2,
  sessionCount: 0,
  createdAt: "2026-11-14T03:00:00.000Z",
  localProjectId: "local-1",
  demo: { active: true, memberUserId: "9001", memberName: "小饭团", step: "1" }
};

function accessView(overrides: Partial<CollabAgentAccessView> = {}): CollabAgentAccessView {
  return {
    granted: false,
    askedInProject: false,
    agents: [{ sourceId: "cursor", name: "Cursor", available: true, enabled: true, installed: false, added: false }],
    ...overrides
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function accessDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    .find((entry) => entry.textContent?.includes("授权后，你可以：")) ?? null;
}

/** 演示正压在这个项目上：第一步，等待点开小饭团的任务。 */
function activeDemo(): DemoGuideState {
  return {
    status: "active",
    phase: "task-row",
    projectId: "p-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    copy: DEMO_GUIDE_COPY_FALLBACK,
error: null,
    done: { task: false, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    askDelivered: false,
    askTurnEnded: false,
    prefill: null,
    endReason: null,
    cloudEnded: false
  };
}

describe("agent access prompt while the demo guide runs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    resetDemoGuideStore();
    resetLaunchAuthorizationRuntime();
    window.localStorage.clear();
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.getAgentAccess.mockResolvedValue(accessView());

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    resetDemoGuideStore();
    resetLaunchAuthorizationRuntime();
    window.localStorage.clear();
  });

  it("holds the ask until the demo ends, then asks as before", async () => {
    setDemoGuideStateForTest(activeDemo());
    requestCollabAccessPrompt("local-1");
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();

    // 演示里不问：请求留在 store 里等演示结束（引导的蒙版挂在应用根部，不在看板这一层）。
    expect(accessDialog()).toBeNull();
    expect(getCollabProjectsSnapshot().accessPromptFor).toBe("local-1");

    // 演示结束（走完三步）：请求还在，按原来的时机问一次。
    await act(async () => dispatchDemoGuide({ type: "end", reason: "finished" }));
    await flush();
    expect(accessDialog()).toBeTruthy();
    expect(accessDialog()?.textContent).toContain("在其他 Agent 中使用协作项目");
  });
});
