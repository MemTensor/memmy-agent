// @vitest-environment happy-dom

/**
 * 预览页每张截图都对应引导的一个阶段：`?view=demo-guide&step=…` 的键要与状态机的阶段一一对上。
 * 这里只保证两件事：新增的「建项目之前」能画出来，且它的亮区锚点在预览页上也存在。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DemoGuidePreview,
  DEMO_GUIDE_PREVIEW_STEPS,
  type DemoGuidePreviewStep
} from "./fixtures/collab-demo-guide-preview.js";


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the demo guide preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(step: DemoGuidePreviewStep): Promise<void> {
    await act(async () => {
      root.render(<DemoGuidePreview step={step} />);
    });
    // 蒙版每帧量一次位置：等几帧再断言。
    for (let index = 0; index < 3; index += 1) {
      await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(null))));
    }
  }

  it("covers the step before the project exists", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["0-create-project"]).toBe("create-project");
    await render("0-create-project");

    // 亮区锚点就是这个按钮：蒙版只亮它，其余都不接点击。
    expect(document.querySelector("[data-demo-guide='create-project-submit']")).toBeTruthy();
    // 弹窗自己的暗底让给蒙版，否则会叠两层灰。
    expect(document.querySelector("[data-demo-guide-yield-backdrop]")).toBeTruthy();
    // 名字与协作开关都已替人填好。
    expect(document.body.textContent).toContain("项目协作体验");
  });

  it("opens with the join notice before the first step", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["0-joined"]).toBe("joined");
    await render("0-joined");

    // 居中的提示窗带 Memmy 的吉祥物（不是应用图标），只有「开始体验」，没有跳过，也没有蒙版。
    expect(document.querySelector("[data-demo-join]")).toBeTruthy();
    expect(document.querySelector("[data-demo-join] img")?.getAttribute("src")).toContain("mascot/memmy-celebrate");
    expect(document.body.textContent).toContain("小饭团加入了项目");
    expect(document.body.textContent).toContain("一起开展一次协作");
    expect(document.body.textContent).toContain("开始体验");
    expect(document.body.textContent).not.toContain("跳过这一步");
    expect(document.querySelector("[data-demo-mask]")).toBeNull();
  });

  it("covers the five tour steps on the board, ending on the sidebar new-task button", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-board"]).toBe("tour-board");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-header"]).toBe("tour-header");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-tabs"]).toBe("tour-tabs");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-associate"]).toBe("tour-associate");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-new-task"]).toBe("tour-new-task");

    // 每一步的锚点都在预览页上：整块看板、头部（项目名与成员）、tab 那一行、工具条右侧的关联任务、侧栏的「＋」。
    for (const [step, anchor] of [
      ["t-board", "board-main"],
      ["t-header", "board-header"],
      ["t-tabs", "board-tabs"],
      ["t-associate", "board-associate"],
      ["t-new-task", "sidebar-new-task"]
    ] as const) {
      await render(step);
      expect(document.querySelector(`[data-demo-guide='${anchor}']`)).toBeTruthy();
      // 导览段不描边：没有任何「这里可以点」的控件。
      expect(document.querySelector("[data-demo-stroke]")).toBeNull();
    }
  });

  it("shows the task page itself once the assist is allowed", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["3-running"]).toBe("help-running");
    expect(DEMO_GUIDE_PREVIEW_STEPS["3-done"]).toBe("help-done");
    await render("3-running");
    // 站在那条任务里：协助条写明是谁的请求、仅这一次、执行中。
    expect(document.querySelector("[data-collab-assist-bar]")?.textContent).toContain("小饭团的 Memmy 请求 · 仅这一次");
    expect(document.body.textContent).toContain("执行中");
    // 亮区锚点在这个任务页上（看板的「协助」行不是目标）。
    expect(document.querySelector("[data-demo-guide='assist-task']")).toBeTruthy();
    expect(document.querySelector("[data-demo-guide='assist-row']")).toBeNull();

    await render("3-done");
    // 跑完之后：协助条到已完成，底部一行写明结果发给了谁，卡片给出「完成」。
    expect(document.querySelector("[data-collab-assist-bar]")?.textContent).toContain("已完成");
    expect(document.querySelector("[data-collab-assist-dock]")?.textContent).toContain("结果已发给小饭团");
    expect(document.body.textContent).toContain("完成");
  });

  it("still draws every other step", async () => {
    for (const step of [...Object.keys(DEMO_GUIDE_PREVIEW_STEPS), "complete", "error"] as DemoGuidePreviewStep[]) {
      await render(step);
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
