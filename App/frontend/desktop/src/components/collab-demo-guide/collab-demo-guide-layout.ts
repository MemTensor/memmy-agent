/**
 * 引导蒙版的几何：亮区落在哪个锚点上、遮罩怎么分块、说明卡贴在哪一边。
 *
 * 只做纯计算，DOM 读取与渲染在组件里。这样窄窗口、卡片与亮区相撞这些情况都能用普通单元测试覆盖。
 */
import type { DemoGuidePhase } from "../../app/collab-demo-guide-store.js";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** 一个子状态的亮区：`region` 框住全部要看的区域，`stroke` 是唯一可点的控件。 */
export interface DemoGuideTarget {
  region: string;
  stroke: string | null;
  /** true：亮区里除描边控件外的位置都不接点击（读面板、弹窗这些自带多个按钮的地方）。 */
  blockRest: boolean;
}

const TARGETS: Record<DemoGuidePhase, DemoGuideTarget> = {
  // 建项目之前：只亮新建弹窗里的「创建项目」，名称与开关已经替人填好。
  "create-project": { region: "create-project-submit", stroke: "create-project-submit", blockRest: false },
  "task-row": { region: "board-task-row", stroke: "board-task-row", blockRest: false },
  // 只读面板可以滚动阅读，但只有头部那个「继续任务」能点。
  reader: { region: "reader-panel", stroke: "reader-continue", blockRest: true },
  compose: { region: "composer", stroke: "composer-send", blockRest: true },
  "reply-waiting": { region: "conversation", stroke: null, blockRest: true },
  "reply-done": { region: "conversation", stroke: null, blockRest: true },
  "ask-compose": { region: "composer", stroke: "composer-send", blockRest: true },
  "ask-waiting": { region: "conversation", stroke: null, blockRest: true },
  "ask-done": { region: "conversation", stroke: null, blockRest: true },
  "settings-open": { region: "board-settings", stroke: "board-settings", blockRest: false },
  "settings-assist": { region: "settings-assist", stroke: "settings-assist-switch", blockRest: true },
  "help-waiting": { region: "board-main", stroke: null, blockRest: true },
  "help-dialog": { region: "assist-dialog", stroke: "assist-allow", blockRest: true },
  "help-running": { region: "assist-row", stroke: null, blockRest: true },
  "help-done": { region: "assist-row", stroke: null, blockRest: true },
  "help-rejected": { region: "assist-row", stroke: null, blockRest: true },
  complete: { region: "board-main", stroke: null, blockRest: false }
};

export function demoGuideTarget(phase: DemoGuidePhase): DemoGuideTarget {
  return TARGETS[phase];
}

/** 亮区外扩一点，元素自己的圆角与阴影不会被切掉。 */
export const DEMO_GUIDE_HOLE_PADDING = 6;

/** 亮区不能压在窗口边缘上：至少留出这点距离，说明卡才放得下。 */
const EDGE_MARGIN = 8;

export function padRect(rect: Rect, padding: number, viewport?: Viewport): Rect {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  const right = viewport ? Math.min(viewport.width, rect.left + rect.width + padding) : rect.left + rect.width + padding;
  const bottom = viewport ? Math.min(viewport.height, rect.top + rect.height + padding) : rect.top + rect.height + padding;
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 遮罩分成上下左右四块，中间的亮区留空，也不接点击。 */
export function maskRects(hole: Rect, viewport: Viewport): Rect[] {
  const { width, height } = viewport;
  const right = hole.left + hole.width;
  const bottom = hole.top + hole.height;
  return [
    { left: 0, top: 0, width, height: Math.max(0, Math.min(hole.top, height)) },
    { left: 0, top: Math.max(0, bottom), width, height: Math.max(0, height - bottom) },
    { left: 0, top: Math.max(0, hole.top), width: Math.max(0, Math.min(hole.left, width)), height: Math.max(0, Math.min(bottom, height) - hole.top) },
    { left: Math.max(0, right), top: Math.max(0, hole.top), width: Math.max(0, width - right), height: Math.max(0, Math.min(bottom, height) - hole.top) }
  ].filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * 亮区里除描边控件之外要挡住的部分：`stroke` 为空时整块都挡，否则把亮区减掉描边那一块。
 * 重叠部分裁掉，四块互不覆盖。
 */
export function blockerRects(hole: Rect, stroke: Rect | null, blockRest: boolean): Rect[] {
  if (!blockRest) return [];
  if (!stroke) return [hole];
  const sx1 = Math.max(stroke.left, hole.left);
  const sy1 = Math.max(stroke.top, hole.top);
  const sx2 = Math.min(stroke.left + stroke.width, hole.left + hole.width);
  const sy2 = Math.min(stroke.top + stroke.height, hole.top + hole.height);
  const hx2 = hole.left + hole.width;
  const hy2 = hole.top + hole.height;
  return [
    { left: hole.left, top: hole.top, width: hole.width, height: Math.max(0, sy1 - hole.top) },
    { left: hole.left, top: Math.max(sy2, hole.top), width: hole.width, height: Math.max(0, hy2 - Math.max(sy2, hole.top)) },
    { left: hole.left, top: sy1, width: Math.max(0, sx1 - hole.left), height: Math.max(0, sy2 - sy1) },
    { left: sx2, top: sy1, width: Math.max(0, hx2 - sx2), height: Math.max(0, sy2 - sy1) }
  ].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
}

export interface CardPlacement {
  left: number;
  top: number;
  /**
   * 箭头贴在哪条边上，指向亮区。`offset` 是沿那条边的位置：左右两条边按卡片顶部的距离算，
   * 上下两条边按卡片左侧的距离算。
   */
  arrow: { side: "left" | "right" | "top" | "bottom"; offset: number };
}

export const DEMO_GUIDE_CARD_WIDTH = 296;
const CARD_GAP = 14;
const CARD_MIN_HEIGHT = 150;

/**
 * 说明卡贴在亮区旁边，优先右侧、其次左侧，都放不下就放下面或上面；四个方向都试过仍不合适时取空间最大的一边。
 */
export function cardPlacement(
  hole: Rect,
  viewport: Viewport,
  cardHeight: number = CARD_MIN_HEIGHT,
  options: { hasStroke?: boolean } = {}
): CardPlacement {
  const height = Math.max(CARD_MIN_HEIGHT, cardHeight);
  const spaceRight = viewport.width - (hole.left + hole.width) - CARD_GAP - EDGE_MARGIN;
  const spaceLeft = hole.left - CARD_GAP - EDGE_MARGIN;
  const spaceBelow = viewport.height - (hole.top + hole.height) - CARD_GAP - EDGE_MARGIN;
  const spaceAbove = hole.top - CARD_GAP - EDGE_MARGIN;
  const fitsVertically = (top: number) => top + height <= viewport.height - EDGE_MARGIN;

  const centeredTop = (top: number) => Math.max(EDGE_MARGIN, Math.min(top, viewport.height - height - EDGE_MARGIN));

  if (spaceRight >= DEMO_GUIDE_CARD_WIDTH) {
    const top = centeredTop(hole.top + hole.height / 2 - height / 2);
    return {
      left: hole.left + hole.width + CARD_GAP,
      top,
      arrow: { side: "left", offset: Math.max(18, Math.min(hole.top + hole.height / 2 - top - 6, height - 30)) }
    };
  }
  if (spaceLeft >= DEMO_GUIDE_CARD_WIDTH) {
    const top = centeredTop(hole.top + hole.height / 2 - height / 2);
    return {
      left: hole.left - CARD_GAP - DEMO_GUIDE_CARD_WIDTH,
      top,
      arrow: { side: "right", offset: Math.max(18, Math.min(hole.top + hole.height / 2 - top - 6, height - 30)) }
    };
  }
  const left = Math.max(EDGE_MARGIN, Math.min(hole.left + hole.width / 2 - DEMO_GUIDE_CARD_WIDTH / 2, viewport.width - DEMO_GUIDE_CARD_WIDTH - EDGE_MARGIN));
  // 亮区本身就是一大片（对话区、看板）：说明卡没有要点着谁，放在这块区域的左下角最稳，
  // 也不会像贴在边上那样被窗口底部切掉。
  if (!options.hasStroke && hole.height >= EDGE_MARGIN * 2 + height + 32) {
    return {
      left: Math.max(EDGE_MARGIN, Math.min(hole.left + 20, viewport.width - DEMO_GUIDE_CARD_WIDTH - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, hole.top + hole.height - height - 20),
      arrow: { side: "bottom", offset: 22 }
    };
  }
  if (spaceBelow >= height && fitsVertically(hole.top + hole.height + CARD_GAP)) {
    return {
      left,
      top: hole.top + hole.height + CARD_GAP,
      arrow: { side: "top", offset: Math.max(18, hole.left + hole.width / 2 - left - 6) }
    };
  }
  if (spaceAbove >= height) {
    return {
      left,
      top: hole.top - CARD_GAP - height,
      arrow: { side: "bottom", offset: Math.max(18, hole.left + hole.width / 2 - left - 6) }
    };
  }
  // 都放不下（窗口很窄、亮区几乎占满）：压在上面，箭头仍指回亮区。
  return {
    left,
    top: Math.max(EDGE_MARGIN, Math.min(hole.top + hole.height + CARD_GAP, viewport.height - height - EDGE_MARGIN)),
    arrow: { side: "top", offset: Math.max(18, hole.left + hole.width / 2 - left - 6) }
  };
}

/** 锚点矩形与视口是否相交：切换页面时锚点可能已经不在屏上，这时先不画蒙版。 */
export function rectVisible(rect: Rect, viewport: Viewport): boolean {
  return rect.left + rect.width > 0
    && rect.top + rect.height > 0
    && rect.left < viewport.width
    && rect.top < viewport.height
    && rect.width > 0
    && rect.height > 0;
}
