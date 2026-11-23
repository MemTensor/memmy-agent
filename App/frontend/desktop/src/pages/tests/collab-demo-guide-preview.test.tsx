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

  it("lights the members on the board when the demo member joins", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["0-joined"]).toBe("joined");
    await render("0-joined");

    // 加入不再是一张居中的提示窗：亮区锚点是看板头部的成员徽章，旧的 [data-demo-join] 没有了。
    expect(document.querySelector("[data-demo-guide='board-members']")).toBeTruthy();
    expect(document.querySelector("[data-demo-join]")).toBeNull();
    expect(document.body.textContent).not.toContain("小饭团加入了项目");
    expect(document.body.textContent).not.toContain("开始体验");
  });

  it("draws all six screens before the project exists, each on its own anchor", async () => {
    for (const [step, anchor] of [
      ["0-intro", "create-dialog"],
      ["0-name", "create-name"],
      ["0-folder", "create-folder"],
      ["0-collab", "create-collab"],
      ["0-join-entry", "create-join"],
      ["0-create-project", "create-project-submit"]
    ] as const) {
      await render(step);
      expect(document.querySelector(`[data-demo-guide='${anchor}']`)).toBeTruthy();
      // 六屏都在新建弹窗上：名称已填、协作开关已开。
      expect(document.body.textContent).toContain("项目协作体验");
    }
  });

  it("covers the tour steps on the board, ending on the sidebar new-task button", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-board"]).toBe("tour-board");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-associate"]).toBe("tour-associate");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-associate-pick"]).toBe("tour-associate-pick");
    expect(DEMO_GUIDE_PREVIEW_STEPS["t-new-task"]).toBe("tour-new-task");

    // 每一步的锚点都在预览页上：任务列表那一片、工具条右侧的关联任务、关联会话弹窗、侧栏的「＋」。
    // 「项目名与成员」那一步已经删掉，也没有 board-header 这个锚点。
    for (const [step, anchor] of [
      ["t-board", "board-list"],
      ["t-associate", "board-associate"],
      ["t-associate-pick", "associate-pick"],
      ["t-new-task", "sidebar-new-task"]
    ] as const) {
      await render(step);
      expect(document.querySelector(`[data-demo-guide='${anchor}']`)).toBeTruthy();
      // 导览段不描边：没有任何「这里可以点」的控件。
      expect(document.querySelector("[data-demo-stroke]")).toBeNull();
    }
    // 四站；「关联会话」那一站另有一张未授权的样子，是同一站的两个预览。
    expect(new Set(Object.values(DEMO_GUIDE_PREVIEW_STEPS).filter((phase) => phase.startsWith("tour-")))).toHaveLength(4);
    // 「关联会话」真的摆出了扫到的会话与计数（卡片上的计数在真实客户端里渲染，预览只验弹窗本身）。
    await render("t-associate-pick");
    expect(document.body.textContent).toContain("共 3 个会话");
    expect(document.body.textContent).not.toContain("这里只做展示");
    // 同一站的未授权样子：弹窗是授权说明，一条会话都不摆，底部也没有任何文字。
    await render("t-associate-lock");
    expect(document.body.textContent).toContain("允许 Memmy 读取本机 Agent 的任务？");
    expect(document.body.textContent).not.toContain("共 3 个会话");
    expect(document.querySelector("[data-demo-guide='associate-pick'] footer")).toBeNull();
    await render("t-board");
    expect(document.querySelector("[data-demo-guide='board-header']")).toBeNull();
  });

  it("shows the task page for the one hands-on step", async () => {
    expect(DEMO_GUIDE_PREVIEW_STEPS["1-compose"]).toBe("compose");
    expect(DEMO_GUIDE_PREVIEW_STEPS["1-done"]).toBe("reply-done");
    await render("1-compose");
    // 站在那条任务里：输入框与其发送按钮都在，亮区锚点是输入框，输入框里已经写好了那句话。
    expect(document.querySelector("[data-demo-guide='composer']")).toBeTruthy();
    expect(document.querySelector("[data-demo-guide='composer-send']")).toBeTruthy();
    expect(document.querySelector("[data-demo-guide='composer']")?.textContent).toContain("写一段分享会的通知");

    await render("1-waiting");
    // 等回复那一屏：同一页，对话区写着还在读成员的任务。
    expect(document.querySelector("[data-demo-guide='conversation']")?.textContent).toContain("正在读取小饭团的任务");

    await render("1-done");
    // 结果写回之后仍是这一页：对话区摆着写好的通知（卡片上的「完成」由蒙版量出位置后才画，预览里不量位置）。
    expect(document.querySelector("[data-demo-guide='conversation']")?.textContent).toContain("分享会通知已写好");
  });

  it("still draws every other step", async () => {
    for (const step of [...Object.keys(DEMO_GUIDE_PREVIEW_STEPS), "complete", "error"] as DemoGuidePreviewStep[]) {
      await render(step);
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
