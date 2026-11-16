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
  /** 主锚点不在这一页时（比如执行中的协助条在任务页，人却在看板上）改用在的这一个。 */
  fallback?: string;
  /**
   * 说明卡往下要留出来的高度：任务页底部那一行「结果已发给谁」与输入框是这一步要看的东西，
   * 卡片不能盖住它们。
   */
  cardBottomReserve?: number;
  /** 亮区与描边的圆角（px）：按被高亮的控件自身形状给，默认 12。 */
  radius?: number;
  /** 亮区的内边距（px）：默认 DEMO_GUIDE_HOLE_PADDING（6）。 */
  padding?: number;
  /** 只压暗、不画描边：isDev 引导的出场那一步用。 */
  clean?: boolean;
  /** 说明卡优先贴在哪一边；不填按原来的候选顺序（先右、再左、再下、再上）。 */
  prefer?: "left" | "right" | "top" | "bottom";
}

const TARGETS: Record<DemoGuidePhase, DemoGuideTarget> = {
  // 建项目之前的六屏：都在新建弹窗上，一屏一个亮区；按控件自己的形状给圆角。
  // 出场那一步只压暗、不描边，让人先看整张弹窗。
  intro: { region: "create-dialog", stroke: null, blockRest: false, radius: 18, padding: 8, clean: true, prefer: "right" },
  // 项目名称那一行：与输入框自己的圆角对齐，不挡点击（人可以直接改）。
  name: { region: "create-name", stroke: "create-name", blockRest: false, radius: 13, padding: 6, prefer: "bottom" },
  // 文件夹区块。
  folder: { region: "create-folder", stroke: "create-folder", blockRest: false, radius: 14, padding: 6, prefer: "bottom" },
  // 协作开关整行：说明卡贴在上边，不压住下面的按钮。
  collab: { region: "create-collab", stroke: "create-collab", blockRest: false, radius: 13, padding: 6, prefer: "top" },
  // 左下角的「加入项目」：按钮在弹窗左下，卡片贴在上边。
  "join-entry": { region: "create-join", stroke: "create-join", blockRest: false, radius: 10, padding: 6, prefer: "top" },
  // 「创建项目」：唯一可点的控件。
  "create-project": { region: "create-project-submit", stroke: "create-project-submit", blockRest: false, radius: 10, padding: 7, prefer: "right" },
  // 加入那一屏：亮区套住看板上的成员徐章，不描边也不挡点击。
  joined: { region: "board-members", stroke: null, blockRest: false, radius: 10, padding: 7, prefer: "right" },
  // 看板导览：纯介绍，只亮区域、不描边、不接点击（`blockRest` 让亮区里也点不动）。
  // 第一站只框任务列表那一片：看板头部与工具条不属于这一步要讲的东西。
  "tour-board": { region: "board-list", stroke: null, blockRest: true, radius: 14, padding: 6, prefer: "right" },
  // 第二站只讲「协助」：亮区落在 tab 那一行上。
  "tour-tabs": { region: "board-tabs", stroke: null, blockRest: true, radius: 14, padding: 6, prefer: "right" },
  // 「关联任务」这一步只亮给人看：不描边、点了也不打开弹窗、不写任何数据。
  "tour-associate": { region: "board-associate", stroke: null, blockRest: true, radius: 10, padding: 6, prefer: "bottom" },
  // 「关联会话」：整张弹窗作为亮区，亮区里一个控件都不给点（blockRest 且不描边）；
  // 卡片贴到弹窗左边，把扫描出来的列表完整留在右边。
  "tour-associate-pick": { region: "associate-pick", stroke: null, blockRest: true, radius: 16, padding: 6, prefer: "left" },
  // 侧栏当前项目右侧的「＋」：亮给它，同样点不动。
  "tour-new-task": { region: "sidebar-new-task", stroke: null, blockRest: true, radius: 9, padding: 5, prefer: "bottom" },
  // 体验三步：圆角与内边距沿用默认值（12 / 6），与改造前一致。
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
  // 允许之后人站到那条 Memmy 任务里：亮整个任务页，协助条、执行过程与结果都在里面；人若是留在看板上，改亮那条协助。
  // 底部要留出来：任务页最下面是「结果已发给谁」那一行，正是这一步要看的东西。
  "help-running": { region: "assist-task", stroke: null, blockRest: false, fallback: "assist-row", cardBottomReserve: 150 },
  "help-done": { region: "assist-task", stroke: null, blockRest: false, fallback: "assist-row", cardBottomReserve: 150 },
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

/** 常规说明卡宽：单行放得下「1 / 3 · 接续成员的任务」这类短标题，不被压成两行。 */
export const DEMO_GUIDE_CARD_WIDTH = 340;
/** 带对话或任务示意的说明卡宽一档：示意图不挤。 */
export const DEMO_GUIDE_CARD_WIDTH_WIDE = 400;
const CARD_GAP = 14;
const CARD_MIN_HEIGHT = 150;

/** 说明卡与「必须别遮住」的那块之间至少留这么远，描边与阴影不会压上去。 */
const AVOID_MARGIN = 6;

/** 两块矩形是否相交（只算正面积的重叠：贴边不算）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width
    && b.left < a.left + a.width
    && a.top < b.top + b.height
    && b.top < a.top + a.height;
}

/** 两块矩形重叠的面积：判断「哪个候选位置压得最少」用。 */
function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/** 说明卡在某个位置时的矩形。 */
function cardRect(placement: CardPlacement, width: number, height: number): Rect {
  return { left: placement.left, top: placement.top, width, height };
}

/**
 * 说明卡贴在亮区旁边，优先右侧、其次左侧，都放不下就放下面或上面；四个方向都试过仍不合适时压在亮区的角上。
 *
 * `options.avoid` 是绝不允许被遮住的那块（就是 `stroke`，也就是亮区里唯一可点的控件）：
 * 按上面的顺序算出候选位置后，哪个候选不压它就用哪个；全都压上时再按「压得最少」挑一个，然后把它挤出去。
 */
export function cardPlacement(
  hole: Rect,
  viewport: Viewport,
  cardHeight: number = CARD_MIN_HEIGHT,
  options: {
    hasStroke?: boolean;
    reserveBottom?: number;
    cardWidth?: number;
    /** 必须不被遮住的矩形：授权弹窗里「允许」那一块就是它。 */
    avoid?: Rect | null;
  } = {}
): CardPlacement {
  const height = Math.max(CARD_MIN_HEIGHT, cardHeight);
  // 加宽那档自己把宽度交进来：贴边时按它的实际宽度算，卡片才不会出窗口。
  const width = options.cardWidth ?? DEMO_GUIDE_CARD_WIDTH;
  const spaceRight = viewport.width - (hole.left + hole.width) - CARD_GAP - EDGE_MARGIN;
  const spaceLeft = hole.left - CARD_GAP - EDGE_MARGIN;
  const spaceBelow = viewport.height - (hole.top + hole.height) - CARD_GAP - EDGE_MARGIN;
  const spaceAbove = hole.top - CARD_GAP - EDGE_MARGIN;
  const fitsVertically = (top: number) => top + height <= viewport.height - EDGE_MARGIN;

  const centeredTop = (top: number) => Math.max(EDGE_MARGIN, Math.min(top, viewport.height - height - EDGE_MARGIN));
  const centeredLeft = (left: number) => Math.max(EDGE_MARGIN, Math.min(left, viewport.width - width - EDGE_MARGIN));
  /** 贴左右两条边时箭头沿竖直方向挪：指向亮区的中心。 */
  const arrowVertical = (top: number) => Math.max(18, Math.min(hole.top + hole.height / 2 - top - 6, height - 30));
  /** 贴上下两条边时箭头沿水平方向挪。 */
  const arrowHorizontal = (left: number) => Math.max(18, hole.left + hole.width / 2 - left - 6);

  const besideRight = (top: number): CardPlacement => {
    const aligned = centeredTop(top);
    return {
      left: hole.left + hole.width + CARD_GAP,
      top: aligned,
      arrow: { side: "left", offset: arrowVertical(aligned) }
    };
  };
  const besideLeft = (top: number): CardPlacement => {
    const aligned = centeredTop(top);
    return {
      left: hole.left - CARD_GAP - width,
      top: aligned,
      arrow: { side: "right", offset: arrowVertical(aligned) }
    };
  };
  const below = (left: number): CardPlacement => {
    const aligned = centeredLeft(left);
    return {
      left: aligned,
      top: hole.top + hole.height + CARD_GAP,
      arrow: { side: "top", offset: arrowHorizontal(aligned) }
    };
  };
  const above = (left: number): CardPlacement => {
    const aligned = centeredLeft(left);
    return {
      left: aligned,
      top: hole.top - CARD_GAP - height,
      arrow: { side: "bottom", offset: arrowHorizontal(aligned) }
    };
  };
  /** 压在亮区里的一个角上（窗口窄到四周都放不下时）：箭头贴着下沿，指回亮区里的内容。 */
  const inside = (corner: "top" | "bottom", align: "left" | "right", reserveBottom = 0): CardPlacement => {
    const left = align === "left"
      ? Math.max(EDGE_MARGIN, Math.min(hole.left + 20, viewport.width - width - EDGE_MARGIN))
      : Math.max(EDGE_MARGIN, Math.min(hole.left + hole.width - width - 20, viewport.width - width - EDGE_MARGIN));
    const top = corner === "bottom"
      ? Math.max(EDGE_MARGIN, hole.top + hole.height - height - 20 - reserveBottom)
      : Math.max(EDGE_MARGIN, hole.top + 20);
    return { left, top, arrow: { side: "bottom", offset: arrowHorizontal(left) } };
  };

  // 候选择序就是「先常规、后勉强」：右侧 → 左侧 → 压在亮区左下角 → 下面 → 上面 → 亮区里的其它三个角。
  const candidates: CardPlacement[] = [];
  if (spaceRight >= width) {
    const top = hole.top + hole.height / 2 - height / 2;
    candidates.push(besideRight(top), besideRight(0), besideRight(viewport.height - height));
  }
  if (spaceLeft >= width) {
    const top = hole.top + hole.height / 2 - height / 2;
    candidates.push(besideLeft(top), besideLeft(0), besideLeft(viewport.height - height));
  }
  // 亮区本身就是一大片（对话区、看板）：说明卡没有要点着谁，放在这块区域的左下角最稳，
  // 也不会像贴在边上那样被窗口底部切掉。
  if (!options.hasStroke && hole.height >= EDGE_MARGIN * 2 + height + 32 && spaceRight < width && spaceLeft < width) {
    // 底部有要看的行（如任务页的「结果已发给谁」）时再往上让一让。
    candidates.push(inside("bottom", "left", options.reserveBottom ?? 0));
  }
  if (spaceBelow >= height && fitsVertically(hole.top + hole.height + CARD_GAP)) {
    candidates.push(below(hole.left + hole.width / 2 - width / 2));
  }
  if (spaceAbove >= height) {
    candidates.push(above(hole.left + hole.width / 2 - width / 2));
  }
  candidates.push(
    inside("bottom", "left", options.reserveBottom ?? 0),
    inside("bottom", "right", options.reserveBottom ?? 0),
    inside("top", "left"),
    inside("top", "right")
  );

  const avoid = options.avoid ?? null;
  if (!avoid) return candidates[0]!;
  // 必须别遮住的那块外扩一点：贴边不算相交，但也别贴着。
  const keep = padRect(avoid, AVOID_MARGIN);
  let fallback: { placement: CardPlacement; overlap: number } | null = null;
  for (const candidate of candidates) {
    const overlap = overlapArea(cardRect(candidate, width, height), keep);
    if (overlap === 0) return candidate;
    if (!fallback || overlap < fallback.overlap) fallback = { placement: candidate, overlap };
  }
  // 每个候选都压在按钮上（窗口窄到几乎没有空地）：挨个挪一步找一个不与它相交的位置，
  // 挪不出来（比窗口还大）时用压得最少的那个，箭头仍指回亮区。
  return freePlacement(hole, viewport, width, height, keep) ?? fallback!.placement;
}

/**
 * 在窗口里找一个既不与 `avoid` 相交、也留在窗口内的位置：从离亮区最近的几行开始，逐行逐列地试。
 * 只在上面的候选全部压住控件时才会用到，所以不在乎多算几步。
 */
function freePlacement(hole: Rect, viewport: Viewport, width: number, height: number, avoid: Rect | null): CardPlacement | null {
  if (!avoid) return null;
  const step = 16;
  const centerX = hole.left + hole.width / 2 - width / 2;
  const centerY = hole.top + hole.height / 2 - height / 2;
  const rows: number[] = [];
  for (let top = EDGE_MARGIN; top + height <= viewport.height - EDGE_MARGIN; top += step) rows.push(top);
  // 从上往下、从离亮区中心最近的开始试：先试弹窗的其余角落。
  rows.sort((a, b) => Math.abs(a - centerY) - Math.abs(b - centerY));
  for (const top of rows) {
    const lefts: number[] = [];
    for (let left = EDGE_MARGIN; left + width <= viewport.width - EDGE_MARGIN; left += step) lefts.push(left);
    lefts.sort((a, b) => Math.abs(a - centerX) - Math.abs(b - centerX));
    for (const left of lefts) {
      const rect = { left, top, width, height };
      if (rectsIntersect(rect, avoid)) continue;
      return { left, top, arrow: { side: arrowSideFor(hole, rect), offset: 22 } };
    }
  }
  return null;
}

/** 箭头从哪条边指回亮区：卡片在亮区哪一侧，箭头就在对面的那条边上。 */
function arrowSideFor(hole: Rect, rect: Rect): CardPlacement["arrow"]["side"] {
  if (rect.top >= hole.top + hole.height) return "top";
  if (rect.top + rect.height <= hole.top) return "bottom";
  if (rect.left >= hole.left + hole.width) return "left";
  if (rect.left + rect.width <= hole.left) return "right";
  // 压在亮区里：箭头贴着最近的那条边。
  return rect.top + rect.height / 2 < hole.top + hole.height / 2 ? "top" : "bottom";
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
