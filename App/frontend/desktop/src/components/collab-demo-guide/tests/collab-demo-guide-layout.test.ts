/**
 * 引导蒙版的几何：遮罩的四块、亮区里除控件外要挡住的部分、说明卡贴哪一边，以及窄窗口下不溢出。
 */
import { describe, expect, it } from "vitest";
import {
  blockerRects,
  cardPlacement,
  DEMO_GUIDE_CARD_WIDTH,
  demoGuideTarget,
  maskRects,
  padRect,
  rectVisible
} from "../collab-demo-guide-layout.js";

const viewport = { width: 1200, height: 800 };

describe("demo guide layout", () => {
  it("leaves a hole in the mask and covers the rest", () => {
    const hole = { left: 200, top: 300, width: 400, height: 120 };
    const rects = maskRects(hole, viewport);
    expect(rects).toHaveLength(4);
    const covered = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(covered).toBe(viewport.width * viewport.height - hole.width * hole.height);
    // 上块只到亮区上沿，下块从亮区下沿开始。
    expect(rects[0]).toEqual({ left: 0, top: 0, width: 1200, height: 300 });
    expect(rects[1]).toEqual({ left: 0, top: 420, width: 1200, height: 380 });
  });

  it("blocks everything in the lit area except the control, or all of it when nothing is clickable", () => {
    const hole = { left: 100, top: 100, width: 300, height: 200 };
    const stroke = { left: 130, top: 110, width: 80, height: 30 };
    const blockers = blockerRects(hole, stroke, true);
    expect(blockers).toHaveLength(4);
    // 描边控件那一块不在遮挡里。
    expect(blockers.some((rect) => (
      rect.left <= stroke.left && rect.left + rect.width >= stroke.left + stroke.width
      && rect.top <= stroke.top && rect.top + rect.height >= stroke.top + stroke.height
    ))).toBe(false);
    expect(blockerRects(hole, null, true)).toEqual([hole]);
    expect(blockerRects(hole, stroke, false)).toEqual([]);
  });

  it("puts the card beside the lit area and keeps it inside the window", () => {
    const hole = { left: 200, top: 300, width: 400, height: 120 };
    const placement = cardPlacement(hole, viewport, 180);
    expect(placement.left).toBe(hole.left + hole.width + 14);
    expect(placement.arrow.side).toBe("left");
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + 180).toBeLessThanOrEqual(viewport.height - 8);
  });

  it("flips to the left or below when the right side has no room", () => {
    const rightEdge = { left: 900, top: 300, width: 280, height: 120 };
    // 右侧放不下就贴到左边，箭头反过来指向亮区。
    const beside = cardPlacement(rightEdge, viewport, 180);
    expect(beside.arrow.side).toBe("right");
    expect(beside.left + DEMO_GUIDE_CARD_WIDTH).toBeLessThanOrEqual(rightEdge.left);
    const wide = { left: 100, top: 300, width: 1000, height: 120 };
    const below = cardPlacement(wide, { width: 1200, height: 900 }, 180);
    expect(below.arrow.side).toBe("top");
    expect(below.top).toBe(300 + 120 + 14);
  });

  it("puts the card inside a large lit area that has no control to point at", () => {
    const conversation = { left: 0, top: 0, width: 1200, height: 620 };
    const placement = cardPlacement(conversation, viewport, 180, { hasStroke: false });
    expect(placement.top).toBe(620 - 180 - 20);
    expect(placement.left).toBe(20);
    expect(placement.top + 180).toBeLessThanOrEqual(conversation.top + conversation.height);
  });

  it("keeps the card on screen in a narrow window", () => {
    const narrow = { width: 420, height: 720 };
    const hole = { left: 12, top: 200, width: 396, height: 160 };
    const placement = cardPlacement(hole, narrow, 200);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + DEMO_GUIDE_CARD_WIDTH).toBeLessThanOrEqual(narrow.width - 8);
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + 200).toBeLessThanOrEqual(narrow.height - 8);
  });

  it("names the anchor and the control for each phase", () => {
    // 建项目之前：新建弹窗里的「创建项目」是唯一亮起、也唯一可点的地方。
    expect(demoGuideTarget("create-project")).toEqual({ region: "create-project-submit", stroke: "create-project-submit", blockRest: false });
    expect(demoGuideTarget("task-row")).toEqual({ region: "board-task-row", stroke: "board-task-row", blockRest: false });
    expect(demoGuideTarget("reader").stroke).toBe("reader-continue");
    expect(demoGuideTarget("compose").stroke).toBe("composer-send");
    expect(demoGuideTarget("help-dialog").stroke).toBe("assist-allow");
    expect(demoGuideTarget("settings-assist").stroke).toBe("settings-assist-switch");
  });

  it("pads the hole without running past the window edge", () => {
    expect(padRect({ left: 2, top: 2, width: 10, height: 10 }, 6, viewport)).toEqual({ left: 0, top: 0, width: 18, height: 18 });
    expect(rectVisible({ left: -50, top: 10, width: 40, height: 40 }, viewport)).toBe(false);
    expect(rectVisible({ left: 10, top: 10, width: 40, height: 40 }, viewport)).toBe(true);
  });
});
