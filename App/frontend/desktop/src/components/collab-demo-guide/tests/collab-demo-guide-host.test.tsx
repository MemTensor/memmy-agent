// @vitest-environment happy-dom

/**
 * 引导宿主的两件硬要求：
 *
 * - 授权必须是人自己点的：请求到了、但还没处理时，卡片停在那儿等，不替人允许。
 * - 失败必须说出来：第二步发出去 20 秒还没有那一条请求、第三步执行失败，都切「这一步没有完成」，
 *   不能一直显示「请求已发出」或「完成」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../../api/collab-client.js";
import type { DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import {
  dispatchDemoGuide,
  getDemoGuideState,
  resetDemoGuideStore,
  setDemoGuideStateForTest
} from "../../../app/collab-demo-guide-store.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CollabDemoGuideHost } from "../collab-demo-guide-host.js";

const store = vi.hoisted(() => ({ loadCollabProjects: vi.fn() }));

vi.mock("../../../app/collab-projects-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../app/collab-projects-store.js")>();
  return { ...actual, loadCollabProjects: store.loadCollabProjects };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBER = { userId: "9001", name: "小饭团", mine: false };
const ME = { userId: "1", name: "孙起", mine: true };

/** 一条从「引导所在的这一步」出发的状态：项目 id 与本机项目 id 都是固定的。 */
function demoState(phase: DemoGuideState["phase"], overrides: Partial<DemoGuideState> = {}): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    error: null,
    done: { task: false, associate: false, ask: false, help: false },
    skipped: { task: false, associate: false, ask: false, help: false },
    askDelivered: false,
    prefill: null,
    endReason: null,
    cloudEnded: false,
    ...overrides
  };
}

/** 第二步：我发起、执行人是演示成员的那次协助。 */
function askThread(status: "pending" | "done" | "failed") {
  return {
    threadId: "thread-ask",
    requester: ME,
    executor: MEMBER,
    projectId: "cloud-1",
    title: "看一下《项目协作常见问题》",
    updatedAt: "2026-11-14T07:00:00.000Z",
    requests: [{ id: "req-1", status, title: "看一下《项目协作常见问题》" }]
  };
}

/** 第三步：演示成员发来、由我执行的请求。 */
function helpThread(status: "pending" | "running" | "done" | "failed", failure?: string) {
  return {
    threadId: "thread-help",
    requester: MEMBER,
    executor: ME,
    projectId: "cloud-1",
    title: "介绍一下项目协作",
    updatedAt: "2026-11-14T07:00:00.000Z",
    requests: [{ id: "req-2", status, title: "介绍一下项目协作", ...(failure ? { failure } : {}) }]
  };
}

function client(overrides: Partial<CollabClient>): CollabClient {
  return {
    assistThreads: vi.fn().mockResolvedValue({ threads: [], maxThreads: 20 }),
    assistInbox: vi.fn().mockResolvedValue({ requests: [] }),
    ...overrides
  } as unknown as CollabClient;
}

describe("the demo guide host", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(
    collab: CollabClient,
    state: DemoGuideState,
    options: { route?: string; openBoard?: (localProjectId: string) => void; openTaskPage?: () => void } = {}
  ): Promise<void> {
    setDemoGuideStateForTest(state, collab);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideHost
            collab={collab}
            route={options.route ?? "/main"}
            boardProjectId={null}
            openBoard={options.openBoard ?? vi.fn()}
            openTaskPage={options.openTaskPage ?? vi.fn()}
            onNotice={vi.fn()}
          />
        </I18nProvider>
      );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetDemoGuideStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDemoGuideStore();
    vi.useRealTimers();
  });

  it("stops waiting after twenty seconds without the assist request", async () => {
    // 请求根本没发出去（CLI 连不上、Agent 没照做）：本项目里一条都没有。
    await mount(client({}), demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19_000);
    });
    // 还没到时限：卡片仍然说「请求已发出」，不提前报警。
    expect(getDemoGuideState().error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().phase).toBe("ask-waiting");
    expect(getDemoGuideState().error).toBe("协助请求没有发出去。");
  });

  it("counts a rejected request as a step that did not finish", async () => {
    const threads = { threads: [askThread("pending")] };
    const collab = client({ assistThreads: vi.fn().mockResolvedValue(threads) });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // 只是一条还在跑的请求：不能当成结果已回。
    expect(getDemoGuideState().error).toBeNull();
    expect(getDemoGuideState().askDelivered).toBe(false);

    threads.threads = [askThread("failed")];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().error).toBe("协助请求没有发出去。");
    expect(getDemoGuideState().done.ask).toBe(false);
  });

  it("waits for the person to allow the request instead of allowing it for her", async () => {
    const threads = { threads: [helpThread("pending")], maxThreads: 20 };
    const collab = client({ assistThreads: vi.fn().mockResolvedValue(threads) });
    await mount(collab, demoState("help-dialog"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    // 请求到了但还没处理：卡片留在「由你决定」这一步，不替人点允许。
    expect(getDemoGuideState().phase).toBe("help-dialog");

    threads.threads = [helpThread("running")];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().phase).toBe("help-running");
  });

  it("says the assist failed rather than finished", async () => {
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [helpThread("failed", "Agent 没有完成这次执行")], maxThreads: 20 })
    });
    await mount(collab, demoState("help-running"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().phase).toBe("help-running");
    expect(getDemoGuideState().error).toBe("Agent 没有完成这次执行");
    expect(getDemoGuideState().done.help).toBe(false);
  });

  it("opens the walkthrough with the join notice and waits for the person", async () => {
    await mount(client({}), demoState("joined"));
    // 先出现的是那张居中的提示窗：有昵称、只有一个「开始体验」，没有跳过。
    expect(document.body.textContent).toContain("小饭团加入了项目，开始一起协作吧");
    expect(document.body.textContent).not.toContain("跳过这一步");
    expect(getDemoGuideState().phase).toBe("joined");

    const start = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.includes("开始体验"));
    await act(async () => start?.click());
    // 点完才进第一步；第一步的蒙版此时才出现。
    expect(getDemoGuideState().phase).toBe("task-row");
  });

  it("goes back to the board for the link-a-task step", async () => {
    const openBoard = vi.fn();
    await mount(client({}), demoState("associate"), { openBoard });
    // 关联任务按钮在看板上，人这时还在任务页：先回看板。
    expect(openBoard).toHaveBeenCalledWith("local-1");
  });

  it("returns to the task once the person is done linking a task", async () => {
    const openTaskPage = vi.fn();
    await mount(client({}), demoState("ask-compose"), { route: "/collab", openTaskPage });
    // 请成员协助要回到那条任务里发消息（看板没有输入框）。
    expect(openTaskPage).toHaveBeenCalled();
  });

  it("drops back on the board once the completion dialog is closed", async () => {
    const openBoard = vi.fn();
    await mount(client({}), demoState("complete", { status: "complete", done: { task: true, associate: true, ask: true, help: true } }), { openBoard });
    const finish = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "完成");
    await act(async () => finish?.click());
    // 第四步是在任务页里做完的：关掉完成弹窗回到这个项目的看板，两条记录留在眼前。
    expect(openBoard).toHaveBeenCalledWith("local-1");
    expect(getDemoGuideState().status).toBe("ended");
  });

  it("rereads the project list the moment the demo ends", async () => {
    const collab = client({});
    await mount(collab, demoState("help-done"));
    store.loadCollabProjects.mockClear();

    await act(async () => {
      dispatchDemoGuide({ type: "end", reason: "exited" });
    });
    // 成员数、任务列表不等下一轮轮询：蒙版一收就重读。
    expect(store.loadCollabProjects).toHaveBeenCalledWith(collab);
  });
});
