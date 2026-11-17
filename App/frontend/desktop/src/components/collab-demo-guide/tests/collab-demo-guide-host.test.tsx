// @vitest-environment happy-dom

/**
 * 引导宿主的两件硬要求：
 *
 * - 换页面只在退回上一屏时发生：任务里的屏把对话页拉回来，看板上的屏把看板拉回来，蒙版才不会亮在空处。
 * - 收场立刻生效：演示一停就把项目列表重读一遍，蒙版下面不会留着旧数据。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../../api/collab-client.js";
import { DEMO_GUIDE_COPY_FALLBACK, type DemoGuideState } from "../../../app/collab-demo-guide-store.js";
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

/** 一条从「引导所在的这一步」出发的状态：项目 id 与本机项目 id 都是固定的。 */
function demoState(phase: DemoGuideState["phase"], overrides: Partial<DemoGuideState> = {}): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    copy: DEMO_GUIDE_COPY_FALLBACK,
    error: null,
    done: { task: false },
    skipped: { task: false },
    scan: { status: "idle", count: 0 },
    prefill: null,
    endReason: null,
    cloudEnded: false,
    ...overrides
  };
}

/** 宿主只用到客户端的协作项目接口；这里给一个空实现，具体调用都由用例自己断言。 */
function client(): CollabClient {
  return {} as unknown as CollabClient;
}

/** 在页面上挂一个 `data-demo-guide` 锚点，位置固定：happy-dom 里量不出布局，只能自己给。 */
function stubAnchor(name: string, box: { left: number; top: number; width: number; height: number }): void {
  const element = document.createElement("button");
  element.setAttribute("data-demo-guide", name);
  element.getBoundingClientRect = (() => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box
  })) as unknown as typeof element.getBoundingClientRect;
  document.body.append(element);
}

describe("the demo guide host", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(
    state: DemoGuideState,
    options: { route?: string; openBoard?: (localProjectId: string) => void; openTaskPage?: () => void } = {}
  ): Promise<CollabClient> {
    const collab = client();
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
    return collab;
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
    for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
    resetDemoGuideStore();
    vi.useRealTimers();
  });

  it("opens the walkthrough on the board with the join card and waits for the person", async () => {
    // 加入那一屏走看板蒙版：亮区套住成员徐章，卡片在旁边说这次由小饭团加入。
    stubAnchor("board-members", { left: 640, top: 48, width: 72, height: 26 });
    await mount(demoState("joined"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(document.querySelector("[data-demo-join]")).toBeNull();
    expect(document.querySelector("[data-demo-mask]")).not.toBeNull();
    expect(document.body.textContent).toContain("项目里还没有其他成员。这次先由我加入项目，带你完成一次协作。");
    expect(document.body.textContent).not.toContain("跳过这一步");
    expect(getDemoGuideState().phase).toBe("joined");

    const start = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "继续");
    await act(async () => start?.click());
    // 点完先进看板导览：第一步的蒙版此时才出现。
    expect(getDemoGuideState().phase).toBe("tour-board");
  });

  it("skips the join entry when the dialog does not show the join button", async () => {
    // API Key 模式下没有「加入项目」：不能把气泡指向空处，直接进「创建项目」。
    await mount(demoState("join-entry"));
    expect(getDemoGuideState().phase).toBe("create-project");
  });

  it("stays on the join entry while the join button is on screen", async () => {
    stubAnchor("create-join", { left: 320, top: 620, width: 88, height: 30 });
    await mount(demoState("join-entry"));
    expect(getDemoGuideState().phase).toBe("join-entry");
  });

  it("stays on the board for the whole tour and never pulls the page around", async () => {
    const openBoard = vi.fn();
    const openTaskPage = vi.fn();
    await mount(demoState("tour-new-task"), { openBoard, openTaskPage, route: "/collab" });
    // 导览全程停在同一个看板上：既不换页，也不把对话页拉回来。
    expect(openBoard).not.toHaveBeenCalled();
    expect(openTaskPage).not.toHaveBeenCalled();
  });

  it("drops back on the board once the completion dialog is closed", async () => {
    const openBoard = vi.fn();
    await mount(demoState("complete", { status: "complete", done: { task: true } }), { openBoard });
    const finish = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "完成");
    await act(async () => finish?.click());
    // 关掉完成弹窗回到这个项目的看板。
    expect(openBoard).toHaveBeenCalledWith("local-1");
    expect(getDemoGuideState().status).toBe("ended");
  });

  it("rereads the project list the moment the demo ends", async () => {
    const collab = await mount(demoState("reply-done"));
    store.loadCollabProjects.mockClear();

    await act(async () => {
      dispatchDemoGuide({ type: "end", reason: "exited" });
    });
    // 成员数、任务列表不等下一轮轮询：蒙版一收就重读。
    expect(store.loadCollabProjects).toHaveBeenCalledWith(collab);
  });

  it("refills the sentence when the person backs into the first step's composer", async () => {
    await mount(demoState("reply-waiting"));
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // 还在等结果：这一步能退回到输入框那一屏（退回表里的 "reply-waiting" → "compose"）。
    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    expect(back).toBeDefined();
    await act(async () => {
      back?.click();
    });
    // 回到输入框，那句话重新填上。
    expect(getDemoGuideState().phase).toBe("compose");
    expect(getDemoGuideState().prefill?.text).toContain("接着");
    expect(getDemoGuideState().prefill?.nonce).toBeGreaterThan(0);
  });

  it("goes back to the board when the previous screen is the read panel", async () => {
    // 输入框那一屏在任务里，上一屏是项目看板上成员任务的只读面板：退回去要先把看板拉回来。
    const openBoard = vi.fn();
    const openTaskPage = vi.fn();
    stubAnchor("composer", { left: 300, top: 600, width: 800, height: 120 });
    stubAnchor("composer-send", { left: 1040, top: 660, width: 36, height: 36 });
    await mount(demoState("compose"), { route: "/main", openBoard, openTaskPage });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    await act(async () => {
      back?.click();
    });
    expect(getDemoGuideState().phase).toBe("reader");
    expect(openBoard).toHaveBeenCalledWith("local-1");
    expect(openTaskPage).not.toHaveBeenCalled();
  });
});
