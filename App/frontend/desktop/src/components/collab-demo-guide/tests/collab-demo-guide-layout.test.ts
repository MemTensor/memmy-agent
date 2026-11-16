/**
 * 引导蒙版的几何：遮罩的四块、亮区里除控件外要挡住的部分、说明卡贴哪一边，以及窄窗口下不溢出。
 */
import { describe, expect, it } from "vitest";
import type { DemoGuidePhase } from "../../../app/collab-demo-guide-store.js";
import {
  blockerRects,
  cardPlacement,
  DEMO_GUIDE_CARD_WIDTH,
  demoGuideTarget,
  maskRects,
  padRect,
  rectVisible,
  rectsIntersect,
  type DemoGuideTarget,
  type Rect
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

  it("keeps the card off the only clickable control", () => {
    // 授权弹窗：窗口里几乎放不下弹窗（520 宽、够高），「允许」在弹窗底部偏右。
    // 四周都没有空间时卡片只能压在弹窗上，那就必须落在与「允许」不相交的那一角。
    const viewportNarrow = { width: 600, height: 520 };
    const dialog = { left: 40, top: 40, width: 520, height: 440 };
    const allow = { left: 330, top: 440, width: 220, height: 34 };
    const cardHeight = 180;
    const placement = cardPlacement(dialog, viewportNarrow, cardHeight, {
      hasStroke: true,
      avoid: allow
    });
    const cardRect: Rect = { left: placement.left, top: placement.top, width: DEMO_GUIDE_CARD_WIDTH, height: cardHeight };
    expect(rectsIntersect(cardRect, allow)).toBe(false);
    // 同时不能出窗口：被避让挤出去就没有意义。
    expect(cardRect.left).toBeGreaterThanOrEqual(8);
    expect(cardRect.top).toBeGreaterThanOrEqual(8);
    expect(cardRect.left + cardRect.width).toBeLessThanOrEqual(viewportNarrow.width - 8);
    expect(cardRect.top + cardRect.height).toBeLessThanOrEqual(viewportNarrow.height - 8);
  });

  it("goes to the side of the authorize dialog before sitting on top of it", () => {
    // 窗口够宽：授权弹窗两侧有地方，卡片就贴到外侧，不会压在弹窗里的「允许」上。
    const dialog = { left: 380, top: 70, width: 520, height: 570 };
    const allow = { left: 640, top: 590, width: 232, height: 34 };
    const beside = cardPlacement(dialog, viewport, 200, { hasStroke: true, avoid: allow });
    const cardRect: Rect = { left: beside.left, top: beside.top, width: DEMO_GUIDE_CARD_WIDTH, height: 200 };
    // 在弹窗的左边或右边外侧，不贴在弹窗身上。
    expect(["left", "right"]).toContain(beside.arrow.side);
    expect(rectsIntersect(cardRect, dialog)).toBe(false);
    expect(rectsIntersect(cardRect, allow)).toBe(false);
  });

  it("returns to the previous placement when nothing has to be avoided", () => {
    // 不传 avoid 时行为与以前一样：先右、再左、再下。
    const hole = { left: 200, top: 300, width: 400, height: 120 };
    expect(cardPlacement(hole, viewport, 180)).toEqual(cardPlacement(hole, viewport, 180, { avoid: null }));
    expect(rectsIntersect(hole, { left: 10, top: 10, width: 4, height: 4 })).toBe(false);
    expect(rectsIntersect(hole, { left: 300, top: 350, width: 4, height: 4 })).toBe(true);
  });

  it("names the anchor and the control for each phase", () => {
    // 建项目之前：新建弹窗里的「创建项目」是唯一可点的地方。
    expect(demoGuideTarget("create-project")).toMatchObject({ region: "create-project-submit", stroke: "create-project-submit", blockRest: false });
    expect(demoGuideTarget("task-row")).toEqual({ region: "board-task-row", stroke: "board-task-row", blockRest: false });
    expect(demoGuideTarget("reader").stroke).toBe("reader-continue");
    expect(demoGuideTarget("compose").stroke).toBe("composer-send");
    expect(demoGuideTarget("help-dialog").stroke).toBe("assist-allow");
    expect(demoGuideTarget("settings-assist").stroke).toBe("settings-assist-switch");
  });

  it("gives each phase the radius, padding and card side the spec asks for", () => {
    // 第六版第四节那张表，逐行照拄：锚点、圆角、内边距、说明卡优先贴哪边。
    const table: Array<[DemoGuidePhase, { region: string; stroke: string | null; blockRest: boolean; radius: number; padding: number; prefer?: DemoGuideTarget["prefer"]; clean?: boolean }]> = [
      ["intro", { region: "create-dialog", stroke: null, blockRest: false, radius: 18, padding: 8, prefer: "right", clean: true }],
      ["name", { region: "create-name", stroke: "create-name", blockRest: false, radius: 13, padding: 6, prefer: "bottom" }],
      ["folder", { region: "create-folder", stroke: "create-folder", blockRest: false, radius: 14, padding: 6, prefer: "bottom" }],
      ["collab", { region: "create-collab", stroke: "create-collab", blockRest: false, radius: 13, padding: 6, prefer: "top" }],
      ["join-entry", { region: "create-join", stroke: "create-join", blockRest: false, radius: 10, padding: 6, prefer: "top" }],
      ["create-project", { region: "create-project-submit", stroke: "create-project-submit", blockRest: false, radius: 10, padding: 7, prefer: "right" }],
      ["joined", { region: "board-members", stroke: null, blockRest: false, radius: 10, padding: 7, prefer: "right" }],
      ["tour-board", { region: "board-list", stroke: null, blockRest: true, radius: 14, padding: 6, prefer: "right" }],
      ["tour-tabs", { region: "board-tabs", stroke: null, blockRest: true, radius: 14, padding: 6, prefer: "right" }],
      ["tour-associate", { region: "board-associate", stroke: null, blockRest: true, radius: 10, padding: 6, prefer: "bottom" }],
      ["tour-associate-pick", { region: "associate-pick", stroke: null, blockRest: true, radius: 16, padding: 6, prefer: "left" }],
      ["tour-new-task", { region: "sidebar-new-task", stroke: null, blockRest: true, radius: 9, padding: 5, prefer: "bottom" }]
    ];
    for (const [phase, expected] of table) {
      expect(demoGuideTarget(phase), phase).toEqual(expected);
    }
    // 体验三步与改造前一样：不写圆角与内边距，走默认的 12 / 6，也不指定卡片贴哪边。
    for (const phase of ["task-row", "reader", "compose", "reply-done", "ask-compose", "settings-open", "help-dialog", "complete"] as const) {
      const target = demoGuideTarget(phase);
      expect(target.radius).toBeUndefined();
      expect(target.padding).toBeUndefined();
      expect(target.prefer).toBeUndefined();
      expect(target.clean).toBeUndefined();
    }
  });

  it("does not blow up on a phase nobody registered", () => {
    // 只保证不抛错：界面在阶段表有缺口时也只是不画蒙版。
    expect(() => demoGuideTarget("not-a-phase" as DemoGuidePhase)).not.toThrow();
    expect(demoGuideTarget("not-a-phase" as DemoGuidePhase)).toBeUndefined();
  });

  it("pads the hole without running past the window edge", () => {
    expect(padRect({ left: 2, top: 2, width: 10, height: 10 }, 6, viewport)).toEqual({ left: 0, top: 0, width: 18, height: 18 });
    expect(rectVisible({ left: -50, top: 10, width: 40, height: 40 }, viewport)).toBe(false);
    expect(rectVisible({ left: 10, top: 10, width: 40, height: 40 }, viewport)).toBe(true);
  });
});
