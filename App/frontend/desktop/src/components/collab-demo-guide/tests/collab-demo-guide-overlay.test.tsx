// @vitest-environment happy-dom

/**
 * 蒙版的亮区必须跟住目标：侧滑、缩放、居中补高这些入场过程里量到的位置不能画出来，
 * 元素停下之后亮区要正好盖住它，描边正好包住要点的那一个控件。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import type { DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import { CollabDemoGuideOverlay } from "../collab-demo-guide-overlay.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 一组可以随时改动的矩形：模拟入场动画期间目标每帧都在动。 */
interface FakeRect { left: number; top: number; width: number; height: number }

function rect(overrides: Partial<FakeRect> = {}): FakeRect {
  return { left: 800, top: 80, width: 420, height: 680, ...overrides };
}

function stubRect(element: HTMLElement, read: () => FakeRect): void {
  element.getBoundingClientRect = (() => {
    const value = read();
    return {
      ...value,
      x: value.left,
      y: value.top,
      right: value.left + value.width,
      bottom: value.top + value.height,
      toJSON: () => value
    } as DOMRect;
  }) as typeof element.getBoundingClientRect;
}

function activeState(phase: DemoGuideState["phase"]): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    error: null,
    done: { task: false, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    askDelivered: false,
    prefill: null,
    endReason: null,
    cloudEnded: false
  };
}

/** 内联的定位写的是亮区本身，happy-dom 里量不出布局，所以直接读这四组数。 */
function boxOf(element: HTMLElement): { left: number; top: number; width: number; height: number } {
  const style = element.style;
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height)
  };
}

/** 遮罩的四块：上、下、左、右。由它们的尺寸反推出亮区。 */
function holeOf(): { left: number; top: number; right: number; bottom: number } | null {
  const masks = Array.from(document.querySelectorAll<HTMLElement>("[data-demo-mask]"));
  if (masks.length !== 4) return null;
  const [top, bottom, left, right] = masks.map(boxOf);
  return {
    left: left!.width,
    top: top!.height,
    right: right!.left,
    bottom: bottom!.top
  };
}

function strokeOf(): { left: number; top: number; width: number; height: number } | null {
  const stroke = document.querySelector<HTMLElement>("[data-demo-stroke]");
  if (!stroke) return null;
  return boxOf(stroke);
}

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    });
  }
}

describe("demo guide overlay tracking", () => {
  let container: HTMLDivElement;
  let root: Root;
  let panelRect: FakeRect;
  let continueRect: FakeRect;

  async function mount(phase: DemoGuideState["phase"]): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={activeState(phase)}
            onJoined={vi.fn()}
            onNext={vi.fn()}
            onSkip={vi.fn()}
            onExit={vi.fn()}
            onRetry={vi.fn()}
            onCloseComplete={vi.fn()}
            onInvite={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await frames(6);
  }

  beforeEach(() => {
    panelRect = rect();
    continueRect = rect({ left: 1130, top: 96, width: 74, height: 28 });
    const panel = document.createElement("aside");
    panel.setAttribute("data-demo-guide", "reader-panel");
    stubRect(panel, () => panelRect);
    const continueButton = document.createElement("button");
    continueButton.setAttribute("data-demo-guide", "reader-continue");
    stubRect(continueButton, () => continueRect);
    document.body.append(panel, continueButton);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
  });

  it("covers the settled target and keeps tracking while it is still moving", async () => {
    await mount("reader");

    // 停稳之后：亮区正好是面板外扩 6px，描边正好包住「继续任务」外扩 3px。
    expect(holeOf()).toEqual({ left: 794, top: 74, right: 1226, bottom: 766 });
    expect(strokeOf()).toEqual({ left: 1127, top: 93, width: 80, height: 34 });

    // 入场动画还在走：位置变了，亮区要跟着变，不能停在第一次量到的位置。
    panelRect = rect({ left: 814, width: 399 });
    continueRect = rect({ left: 1144, top: 96, width: 70, height: 27 });
    // 只改矩形、不发 DOM 事件：靠跟踪循环自己发现。
    const mask = document.querySelector<HTMLElement>("[data-demo-mask]");
    mask?.dispatchEvent(new Event("animationend"));
    await frames(6);

    expect(holeOf()).toEqual({
      left: panelRect.left - 6,
      top: panelRect.top - 6,
      right: panelRect.left + panelRect.width + 6,
      bottom: panelRect.top + panelRect.height + 6
    });
    expect(strokeOf()).toEqual({
      left: continueRect.left - 3,
      top: continueRect.top - 3,
      width: continueRect.width + 6,
      height: continueRect.height + 6
    });
  });

  it("lights only Create project before the project exists", async () => {
    const submit = document.createElement("button");
    submit.setAttribute("data-demo-guide", "create-project-submit");
    stubRect(submit, () => rect({ left: 900, top: 600, width: 96, height: 32 }));
    await act(async () => {
      document.body.append(submit);
    });
    // 建项目之前还不知道演示成员是谁：卡片用中性叫法，也不出现进度条与「跳过这一步」。
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={{ ...activeState("create-project"), projectId: null, localProjectId: null, memberUserId: null, memberName: "" }}
            onJoined={vi.fn()}
            onNext={vi.fn()}
            onSkip={vi.fn()}
            onExit={vi.fn()}
            onRetry={vi.fn()}
            onCloseComplete={vi.fn()}
            onInvite={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await frames(6);

    expect(strokeOf()).toEqual({ left: 897, top: 597, width: 102, height: 38 });
    const card = document.querySelector<HTMLElement>('[role="dialog"][aria-label="新手引导"]');
    expect(card?.textContent).toContain("项目名已经填好了");
    expect(card?.textContent).toContain("一位同事");
    expect(card?.textContent).toContain("退出引导");
    expect(card?.textContent).not.toContain("跳过这一步");
    expect(card?.textContent).not.toContain("下一步");
    // 还没有「第几步」：徽章与步骤名都不出现。
    expect(card?.textContent).not.toContain("接着成员的任务做");
  });

  it("lights the link-a-task button during the tour without letting anyone use it", async () => {
    const associate = document.createElement("button");
    associate.setAttribute("data-demo-guide", "board-associate");
    stubRect(associate, () => rect({ left: 1060, top: 250, width: 92, height: 28 }));
    await act(async () => {
      document.body.append(associate);
    });
    await mount("tour-associate");

    // 亮区就是这个按钮，但不描边：描边意味着「这里可以点」，导览只讲给人听，不打开关联弹窗、不写数据。
    expect(strokeOf()).toBeNull();
    expect(holeOf()).toEqual({ left: 1054, top: 244, right: 1158, bottom: 284 });
    const card = document.querySelector<HTMLElement>('[role="dialog"][aria-label="新手引导"]');
    // 导览段没有「1 / 3」这种进度，只有一个「介绍」徽章；也没有「跳过这一步」。
    expect(card?.textContent).not.toContain("1 / 3");
    expect(card?.textContent).toContain("介绍");
    expect(card?.textContent).not.toContain("跳过这一步");
    expect(card?.textContent).toContain("下一步");
  });

  it("stands in the task itself on the last step and names who gets the result", async () => {
    const task = document.createElement("div");
    task.setAttribute("data-demo-guide", "assist-task");
    stubRect(task, () => rect({ left: 100, top: 60, width: 1000, height: 620 }));
    await act(async () => {
      document.body.append(task);
    });
    await mount("help-running");

    // 人在那条任务里，卡片说清结果会发给谁；第三步的亮区就是这个任务页。
    expect(holeOf()).toEqual({ left: 94, top: 54, right: 1106, bottom: 686 });
    expect(document.body.textContent).toContain("3 / 3");
    expect(document.body.textContent).toContain("结果会直接发给小饭团");
  });

  it("waits for the target instead of drawing an overlay over nothing", async () => {
    for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
    await mount("reader");
    expect(document.querySelector("[data-demo-mask]")).toBeNull();

    // 目标晚一步出现（弹窗、面板挂载得比引导晚）：出现之后仍要画出来。
    const panel = document.createElement("aside");
    panel.setAttribute("data-demo-guide", "reader-panel");
    stubRect(panel, () => panelRect);
    const continueButton = document.createElement("button");
    continueButton.setAttribute("data-demo-guide", "reader-continue");
    stubRect(continueButton, () => continueRect);
    await act(async () => {
      document.body.append(panel, continueButton);
    });
    await frames(6);

    expect(holeOf()).toEqual({ left: 794, top: 74, right: 1226, bottom: 766 });
  });
});
