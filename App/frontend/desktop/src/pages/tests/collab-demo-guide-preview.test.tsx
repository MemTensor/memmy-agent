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

  it("still draws every other step", async () => {
    for (const step of [...Object.keys(DEMO_GUIDE_PREVIEW_STEPS), "complete", "error"] as DemoGuidePreviewStep[]) {
      await render(step);
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
