// @vitest-environment happy-dom

/**
 * 蒙版的亮区必须跟住目标：侧滑、缩放、居中补高这些入场过程里量到的位置不能画出来，
 * 元素停下之后亮区要正好盖住它，第二圈描边正好包住要点的那一个控件。
 *
 * 第六版起暗色由亮区自己投出来（一层 9999px 的投影），四块遮罩只剩挡点击：
 * 亮区的圆角、每屏说什么、加入那一屏是不是看板蒙版，都在这里钉住。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { zhCNMessages, type MessageKey } from "../../../i18n/messages.js";
import { DEMO_GUIDE_COPY_FALLBACK, type DemoGuidePhase, type DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import { CollabDemoGuideOverlay } from "../collab-demo-guide-overlay.js";
import styles from "../collab-demo-guide.module.css";

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

/** 在页面上挂一个锚点，位置由 `read` 决定：与业务组件里那行 `data-demo-guide` 等价。 */
function anchor(name: string, read: () => FakeRect, tag = "div"): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute("data-demo-guide", name);
  stubRect(element, read);
  document.body.append(element);
  return element;
}

function activeState(phase: DemoGuideState["phase"]): DemoGuideState {
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

/** 亮区那一圈：负责压暗，圆角按阶段配置。 */
function litRingOf(): (FakeRect & { radius: number; quiet: boolean }) | null {
  const element = document.querySelector<HTMLElement>("[data-demo-stroke]");
  if (!element) return null;
  return {
    ...boxOf(element),
    radius: Number.parseFloat(element.style.borderRadius),
    quiet: element.classList.contains(styles.quiet)
  };
}

/** 亮区里负责挡点击的那几块：尺寸由它们反推「哪些位置点不到」。 */
function blockersOf(): Array<FakeRect> {
  return Array.from(document.querySelectorAll<HTMLElement>(`.${styles.blocker}`)).map(boxOf);
}

/** 亮区里再点一个控件的第二圈描边：不压暗，只是把那个控件圈出来。 */
function innerRingOf(): (FakeRect & { radius: number }) | null {
  const element = document.querySelector<HTMLElement>("[data-demo-stroke2]");
  if (!element) return null;
  return { ...boxOf(element), radius: Number.parseFloat(element.style.borderRadius) };
}

function cardText(): string {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="新手引导"]')?.textContent ?? "";
}

/** 卡片底部那个主按钮：「下一步 / 开始协作 / 完成」。 */
function nextButton(): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((entry) => entry.textContent?.trim() === "下一步");
  if (!found) throw new Error("no next button on the card");
  return found;
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

  async function mount(
    phase: DemoGuidePhase,
    extra: { onSkipJoinEntry?: () => void; onBack?: () => void; state?: Partial<DemoGuideState> } = {}
  ): Promise<void> {
    const { state: overrides, ...rest } = extra;
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={{ ...activeState(phase), ...overrides }}
            onNext={vi.fn()}
            onBack={vi.fn()}
            onSkip={vi.fn()}
            onExit={vi.fn()}
            onRetry={vi.fn()}
            onCloseComplete={vi.fn()}
            onInvite={vi.fn()}
            {...rest}
          />
        </I18nProvider>
      );
    });
    await frames(6);
  }

  beforeEach(() => {
    panelRect = rect();
    continueRect = rect({ left: 1130, top: 96, width: 74, height: 28 });
    anchor("reader-panel", () => panelRect, "aside");
    anchor("reader-continue", () => continueRect, "button");

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

  it("keeps the step name but drops the pointless 1 / 1 progress on the single hands-on step", async () => {
    await mount("reader");

    const text = cardText();
    // 动手体验只有一步：进度「1 / 1」不说任何事，头部只留步骤名。
    expect(text).toContain("接续成员的任务");
    expect(text).not.toContain("1 / 1");
    expect(document.querySelector(`.${styles.head}`)).not.toBeNull();
  });

  it("covers the settled target and keeps tracking while it is still moving", async () => {
    await mount("reader");

    // 停稳之后：亮区正好是面板外扩 6px，第二圈描边正好包住「继续任务」外扩 3px。
    expect(holeOf()).toEqual({ left: 794, top: 74, right: 1226, bottom: 766 });
    expect(innerRingOf()).toMatchObject({ left: 1127, top: 93, width: 80, height: 34 });
    expect(litRingOf()).toMatchObject({ left: 794, top: 74, width: 432, height: 692 });

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
    expect(innerRingOf()).toMatchObject({
      left: continueRect.left - 3,
      top: continueRect.top - 3,
      width: continueRect.width + 6,
      height: continueRect.height + 6
    });
  });

  it("lights only Create project before the project exists", async () => {
    anchor("create-project-submit", () => rect({ left: 900, top: 600, width: 96, height: 32 }), "button");
    // 建项目之前还不知道演示成员是谁：卡片里没有进度徽章，也没有「跳过这一步」与「下一步」。
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={{ ...activeState("create-project"), projectId: null, localProjectId: null, memberUserId: null, memberName: "" }}
            onNext={vi.fn()}
            onBack={vi.fn()}
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

    // 亮区是按钮外扩 7px（规格里这一屏的 pad），圆角 10；没有第二圈描边。
    expect(holeOf()).toEqual({ left: 893, top: 593, right: 1003, bottom: 639 });
    expect(litRingOf()).toMatchObject({ left: 893, top: 593, width: 110, height: 46, radius: 10, quiet: false });
    expect(innerRingOf()).toBeNull();

    const text = cardText();
    expect(text).toContain(zhCNMessages["collab.demo.submit.body"]);
    expect(text).toContain("退出引导");
    expect(text).not.toContain("跳过这一步");
    expect(text).not.toContain("下一步");
    // 还没有「第几步」：徽章与步骤名都不出现。
    expect(text).not.toContain("接续成员的任务");
    expect(document.querySelector(`.${styles.head}`)).toBeNull();
  });

  it("does not let the settings screens be clicked inside the dialog", async () => {
    // 建项目之前的每一屏只介绍设置项：亮区里一个控件都不给点，包括描边圈住的那一项。
    for (const phase of ["intro", "name", "folder", "collab", "join-entry"] as const) {
      document.querySelectorAll("[data-demo-guide]").forEach((element) => element.remove());
      anchor("create-dialog", () => rect({ left: 336, top: 70, width: 528, height: 620 }));
      anchor("create-name", () => rect({ left: 360, top: 130, width: 480, height: 44 }), "input");
      anchor("create-folder", () => rect({ left: 360, top: 200, width: 480, height: 120 }));
      anchor("create-collab", () => rect({ left: 360, top: 340, width: 480, height: 40 }));
      anchor("create-join", () => rect({ left: 360, top: 620, width: 90, height: 32 }), "button");
      await mount(phase);

      const hole = holeOf()!;
      const blockers = blockersOf();
      const area = blockers.reduce((sum, entry) => sum + entry.width * entry.height, 0);
      // 整块亮区都被挡住：描边那一项没留出可点的缺口。
      expect(area, phase).toBeCloseTo((hole.right - hole.left) * (hole.bottom - hole.top));
      // 不描边、不呼吸：描边的意思就是「这里可以点」，这几屏并不给人点。
      expect(litRingOf(), phase).toMatchObject({ quiet: true });
    }
  });

  it("narrows the card to the space beside the dialog instead of covering it", async () => {
    // 1200 宽的窗口里，528 宽的弹窗居中后两侧各约 314px：340px 的卡片放不进去。
    // 以前会退到「压在亮区里」，把弹窗左下角（「添加」「取消」）盖住；现在收窄到恰好的宽度贴在旁边。
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    anchor("create-dialog", () => rect({ left: 336, top: 70, width: 528, height: 620 }));
    await mount("intro");

    const card = document.querySelector<HTMLElement>('[role="dialog"][aria-label="新手引导"]');
    expect(card).not.toBeNull();
    const left = Number.parseFloat(card!.style.left);
    const width = Number.parseFloat(card!.style.width);
    // 收窄了，但没有窄到挤不下文字。
    expect(width).toBeLessThan(340);
    expect(width).toBeGreaterThanOrEqual(268);
    // 整张卡片都在弹窗右侧之外：不压住弹窗里的任何控件。
    expect(left).toBeGreaterThanOrEqual(336 + 528);
  });

  it("lights the link-a-task button during the tour without ringing it", async () => {    anchor("board-associate", () => rect({ left: 1060, top: 250, width: 92, height: 28 }), "button");
    await mount("tour-associate");

    // 亮区就是这个按钮，但不描边：描边意味着「这里可以点」，导览只讲给人听，不打开关联弹窗、不写数据。
    expect(holeOf()).toEqual({ left: 1054, top: 244, right: 1158, bottom: 284 });
    expect(litRingOf()).toMatchObject({ radius: 10, quiet: true });
    expect(innerRingOf()).toBeNull();

    const text = cardText();
    // 导览段没有「1 / 1」这种进度，只有一个「介绍」徽章；也没有「跳过这一步」。
    expect(text).not.toContain("1 / 1");
    expect(text).toContain("介绍");
    expect(text).not.toContain("跳过这一步");
    expect(text).toContain("下一步");
  });

  it("holds the next button on the link-session step until the scan has a result", async () => {
    // 「关联会话」：整张弹窗是亮区，里面一个控件也不给点。
    anchor("associate-pick", () => rect({ left: 360, top: 90, width: 560, height: 560 }), "section");
    await mount("tour-associate-pick", { state: { scan: { status: "scanning", count: 0 } } });
    expect(cardText()).toContain("关联会话");
    expect(cardText()).toContain("正在扫描这台电脑上的历史会话…");
    const scanning = nextButton();
    expect(scanning.disabled).toBe(true);
    // 亮区里不接点击：弹窗这些控件一个都不亮描边。
    expect(innerRingOf()).toBeNull();
    expect(litRingOf()).toMatchObject({ quiet: true });

    // 扫描出结果之后按钮才能点，卡片写出计数。
    await mount("tour-associate-pick", { state: { scan: { status: "done", count: 7 } } });
    expect(cardText()).toContain("已扫描到 7 个会话");
    expect(nextButton().disabled).toBe(false);
  });

  it("asks before leaving with a title and the line naming who leaves", async () => {
    await mount("reader");
    const exit = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "退出引导");
    await act(async () => {
      exit?.click();
    });
    await frames(4);

    // 定稿把这一屏拆成标题与正文两句，正文里的名字是写死的演示成员。
    const text = cardText();
    expect(text).toContain(zhCNMessages["collab.demo.exit.title"]);
    expect(text).toContain(zhCNMessages["collab.demo.exit.body"]);
    expect(text).not.toContain("{name}");
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button')).map((entry) => entry.textContent?.trim());
    expect(buttons).toContain(zhCNMessages["collab.demo.exit.continue"]);
    expect(buttons).toContain(zhCNMessages["collab.demo.exit.confirm"]);
  });

  it("asks the host to skip the join entry when the dialog has no join button", async () => {
    const skip = vi.fn();
    // 眼下的锚点都没有 create-join（API Key 模式下这个按钮根本不渲染）：不能把气泡指向空处。
    await mount("join-entry", { onSkipJoinEntry: skip });
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("keeps the join entry when the dialog really shows the join button", async () => {
    const skip = vi.fn();
    anchor("create-join", () => rect({ left: 320, top: 620, width: 88, height: 30 }), "button");
    await mount("join-entry", { onSkipJoinEntry: skip });
    expect(skip).not.toHaveBeenCalled();
    expect(litRingOf()).not.toBeNull();
  });

  it("draws the board mask on the join screen instead of a separate notice", async () => {
    anchor("board-members", () => rect({ left: 640, top: 48, width: 72, height: 26 }), "button");
    await mount("joined");

    // 加入那一屏不再是一张居中的提示窗：亮区套住看板上的成员徽章，卡片照常出现在旁边。
    expect(document.querySelector("[data-demo-join]")).toBeNull();
    expect(document.querySelector("[data-demo-mask]")).not.toBeNull();
    expect(litRingOf()).toMatchObject({ left: 633, top: 41, width: 86, height: 40, radius: 10, quiet: true });
    const text = cardText();
    expect(text).toContain(zhCNMessages["collab.demo.joined.body"]);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button')).map((entry) => entry.textContent?.trim()))
      .toContain(zhCNMessages["collab.demo.joined.continue"]);
    // 没有徽章、没有步骤名：头部那一行整个不出现。
    expect(document.querySelector(`.${styles.head}`)).toBeNull();
    expect(text).not.toContain("跳过这一步");
  });

  it("writes each of the six screens before the project with its own words and radius", async () => {
    const screens: Array<[DemoGuidePhase, string, number, MessageKey]> = [
      ["intro", "create-dialog", 18, "collab.demo.intro.body"],
      ["name", "create-name", 13, "collab.demo.name.body"],
      ["folder", "create-folder", 14, "collab.demo.folder.body"],
      ["collab", "create-collab", 13, "collab.demo.collab.body"],
      ["join-entry", "create-join", 10, "collab.demo.joinEntry.body"]
    ];
    for (const [phase, name, radius, key] of screens) {
      for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
      anchor(name, () => rect({ left: 480, top: 300, width: 300, height: 60 }));
      await mount(phase);

      // 圆角按规格的表格给：一屏一个数，不出现在 CSS 里。
      expect(litRingOf(), phase).toMatchObject({ radius });
      // 正文就是规格里那一句，逐屏对过一遍。
      expect(cardText(), phase).toContain(zhCNMessages[key]);
    }
  });

  it("keeps the intro screen's ring hidden and shows who is talking", async () => {
    anchor("create-dialog", () => rect({ left: 400, top: 120, width: 480, height: 560 }));
    await mount("intro");

    // 出场那一屏只压暗、不画描边：证件上没有人要点的东西。
    expect(litRingOf()).toMatchObject({ radius: 18, quiet: true });
    const text = cardText();
    // 唯一带徽章的建项目前屏：徽章写「官方」，步骤名是小饭团。
    expect(text).toContain(zhCNMessages["collab.demo.intro.badge"]);
    expect(text).toContain(zhCNMessages["collab.demo.intro.name"]);
    expect(text).toContain(zhCNMessages["collab.demo.intro.body"]);
    expect(document.querySelector(`.${styles.head}`)).not.toBeNull();
  });

  it("closes the walkthrough with the approved words, invite before done", async () => {
    const invite = vi.fn();
    const close = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={{
              ...activeState("complete"),
              status: "complete",
              done: { task: true },
              endReason: "finished"
            }}
            onNext={vi.fn()}
            onSkip={vi.fn()}
            onExit={vi.fn()}
            onRetry={vi.fn()}
            onCloseComplete={close}
            onInvite={invite}
          />
        </I18nProvider>
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("体验完成");
    // 回顾只说做了什么，不再复述剧本内容（内容随云端剧本走，见 copy 测试）。
    expect(dialog?.textContent).toContain("接续了成员的任务，写一段分享会的通知");
    // 那段讲机制的话已经不显示了：完成弹窗只列做过的事，再加一句说明与两个按钮。
    expect(dialog?.textContent).not.toContain("项目协作以项目内的上下文为基础");
    expect(dialog?.textContent).toContain("成员之间可以直接接着推进");
    expect(dialog?.textContent).not.toContain("{name}");

    // 按钮顺序与原型一致：左边是次要的「邀请同事」，右边才是主按钮「完成」。
    const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
    expect(buttons.map((entry) => entry.textContent?.trim())).toEqual(["邀请同事", "完成"]);
    await act(async () => {
      buttons[0]?.click();
    });
    expect(invite).toHaveBeenCalledTimes(1);
    await act(async () => {
      buttons[1]?.click();
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("offers Back on every screen that has one, and keeps it off the ones that already happened", async () => {
    // 第一步的只读面板：上一屏是任务行，能退。
    await mount("reader");
    expect(cardText()).toContain("上一步");

    // 第一步已经拿到回复：退不回去了，按钮不出现。
    anchor("conversation", () => rect({ left: 100, top: 60, width: 1000, height: 620 }));
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideOverlay
            state={activeState("reply-done")}
            onNext={vi.fn()}
            onBack={vi.fn()}
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
    expect(cardText()).toContain("任务已接续");
    expect(cardText()).not.toContain("上一步");
  });

  it("keeps Skip and Back in the same bottom row", async () => {
    const back = vi.fn();
    const skip = vi.fn();
    await mount("reader", { onBack: back, onSkip: skip });
    const labels = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .map((button) => button.textContent?.trim());
    expect(labels).toContain("退出引导");
    expect(labels).toContain("上一步");
    expect(labels).toContain("跳过这一步");

    // 三个小字与按钮都归在底部那一行里：曾经「跳过这一步」单独占正文下面一行，与右上对齐的
    // 「上一步」叠成上下两行，看着像挤在一起。
    const foot = document.querySelector<HTMLElement>(`.${styles.foot}`);
    expect(foot).not.toBeNull();
    const inFoot = Array.from(foot!.querySelectorAll<HTMLButtonElement>("button"))
      .map((button) => button.textContent?.trim());
    expect(inFoot).toEqual(["退出引导", "跳过这一步", "上一步"]);
    // 正文下面不再有单独的「跳过这一步」那一行。
    expect(document.querySelector(`.${styles.aside}`)).toBeNull();

    await act(async () => {
      foot!.querySelectorAll<HTMLButtonElement>("button")[2]?.click();
    });
    expect(back).toHaveBeenCalledTimes(1);
    await act(async () => {
      foot!.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    });
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("shakes once for a blocked click and never carries it into the next screen", async () => {
    await mount("reader");
    const shakeOf = () => document.querySelector<HTMLElement>("[data-demo-stroke]")?.classList.contains(styles.shake);
    // 点在不接点击的地方：抖一下，这是提示。
    document.querySelector<HTMLElement>("[data-demo-mask]")?.click();
    await frames(2);
    expect(shakeOf()).toBe(true);

    // 换屏：新的一屏不再带着上一屏的抖动（以前会，于是每点一次「下一步」都莫名抖一下）。
    anchor("board-task-row", () => rect({ left: 300, top: 300, width: 700, height: 60 }));
    await mount("task-row");
    expect(shakeOf()).toBe(false);
  });

  it("never prints a raw placeholder on the card", async () => {
    // 任务页那几句带成员名与剧本内容：渲染出来不能留下任何 { 占位符。
    anchor("conversation", () => rect({ left: 794, top: 74, width: 432, height: 400 }), "section");
    await mount("reply-done");

    expect(cardText()).toContain(zhCNMessages["collab.demo.reply.title"]);
    expect(cardText()).not.toContain("{");
    expect(document.body.textContent).not.toContain("{name}");
  });

  it("points a breathing arrow at the one control a screen asks people to click", async () => {
    // 第一步亮的是一整条任务行：箭头从下往上指着行下沿中点，尖钉在边沿上、箭身整个在行外。
    anchor("board-task-row", () => rect({ left: 90, top: 300, width: 1000, height: 100 }));
    await mount("task-row");

    const hint = document.querySelector<HTMLElement>("[data-demo-click-hint]");
    expect(hint).toBeTruthy();
    // 描边是任务行外扩 3px（87,297,1006,106）：尖 = 横向中点、下沿。
    expect(hint!.dataset.demoClickHint).toBe("bottom");
    expect(Number.parseFloat(hint!.style.left)).toBe(590);
    expect(Number.parseFloat(hint!.style.top)).toBe(403);
    // 朝控件指：从下往上指就是整体转 180°。
    expect(hint!.style.getPropertyValue("--hint-turn")).toBe("180deg");
    // 一枚箭头 + 两圈波纹：呼吸由 CSS 负责，波纹圆心就是箭尖这一个定位点。
    expect(hint!.querySelectorAll("." + styles.clickRipple)).toHaveLength(2);
    expect(hint!.querySelector("." + styles.clickArrow)).toBeTruthy();
    // 箭头不接点击：压在控件边沿也不能把它挡掉。
    expect(hint!.getAttribute("aria-hidden")).toBe("true");

    // 小控件（只读面板头部的「继续任务」）：尖落在按钮下沿中点，整个箭头在按钮外面，不盖住字。
    await mount("reader");
    const small = document.querySelector<HTMLElement>("[data-demo-click-hint]");
    expect(small).toBeTruthy();
    // 描边是「继续任务」外扩 3px（1127,93,80,34）：尖 = 横向中点、下沿。
    expect(small!.dataset.demoClickHint).toBe("bottom");
    expect(Number.parseFloat(small!.style.left)).toBe(1167);
    expect(Number.parseFloat(small!.style.top)).toBe(127);

    // 只介绍或只等结果的屏一个箭头都不摆：看板导览每一站、等一位成员回话。
    anchor("board-list", () => rect({ left: 90, top: 132, width: 1000, height: 560 }));
    await mount("tour-board");
    expect(document.querySelector("[data-demo-click-hint]")).toBeNull();
    anchor("conversation", () => rect({ left: 100, top: 60, width: 1000, height: 620 }));
    await mount("reply-waiting");
    expect(holeOf()).not.toBeNull();
    expect(document.querySelector("[data-demo-click-hint]")).toBeNull();
  });

  it("waits for the target instead of drawing an overlay over nothing", async () => {
    for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
    await mount("reader");
    expect(document.querySelector("[data-demo-mask]")).toBeNull();

    // 目标晚一步出现（弹窗、面板挂载得比引导晚）：出现之后仍要画出来。
    anchor("reader-panel", () => panelRect, "aside");
    anchor("reader-continue", () => continueRect, "button");
    await frames(6);

    expect(holeOf()).toEqual({ left: 794, top: 74, right: 1226, bottom: 766 });
  });
});
