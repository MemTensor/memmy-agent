/**
 * 协作项目的首次引导（teach mode）。
 *
 * 沿用记忆管理的产品引导（app/product-tour.tsx）的做法：遮罩挖出目标区域，气泡跟着目标走，
 * 「跳过引导」与最后一步都写入本机记录。与那套引导的差别有两点：
 * 一是这里不换页面，看板就是全部内容；二是新建的协作项目还没有任务，
 * 「通过对话共享」与「继续任务」用两行示例任务来说明，引导结束即消失。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link2, MessageSquarePlus, MessagesSquare, MoreHorizontal, UserPlus } from "lucide-react";
import {
  createDomProductTourAnchorLookup,
  type ProductTourRect,
  type ProductTourViewport
} from "../app/product-tour-layout.js";
import { Memmy, type MemmyPose } from "../components/mascot/memmy.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { memberColor } from "./collab-member-color.js";
import boardStyles from "./collab-page.module.css";
import styles from "./collab-tour.module.css";

/** 引导高亮的锚点，挂在看板对应的元素上。 */
export const COLLAB_TOUR_ANCHORS = {
  /** 整个看板内容：头部、工具条与任务列表。第一步用它把看板整体亮出来，而不是只亮标题那一行。 */
  board: "collab-tour-board",
  /** 看板头部：项目名、成员数、邀请与设置。 */
  header: "collab-tour-board-header",
  /** 头部的「邀请」。 */
  invite: "collab-tour-invite",
  /** 筛选与搜索那一行工具条。 */
  toolbar: "collab-tour-toolbar",
  /** 工具条右侧的「关联任务」。 */
  associate: "collab-tour-associate",
  /** 示例任务：通过对话共享后进入项目的那一条。 */
  sampleShared: "collab-tour-sample-shared",
  /** 示例任务：成员的任务，演示「继续任务」。 */
  sampleContinue: "collab-tour-sample-continue",
  /** 上面那条任务「…」菜单里的「继续任务」。 */
  sampleContinueItem: "collab-tour-sample-continue-item",
  /** 侧栏里当前项目右侧的「＋」。 */
  sidebarNewTask: "collab-tour-sidebar-new-task"
} as const;

/** 本机记录：完成或跳过一次之后不再自动出现。 */
export const COLLAB_TOUR_SEEN_STORAGE_KEY = "memmy.collab.tourSeen";

/**
 * 引导是否已经在本次安装上看过。
 *
 * @param storage 默认读写当前窗口的 localStorage，测试可传入替身。
 * @returns true 表示看过，不再自动出现。
 */
export function readCollabTourSeen(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): boolean {
  return storage?.getItem(COLLAB_TOUR_SEEN_STORAGE_KEY) === "1";
}

/**
 * 记下引导已经看过：完成与跳过都算，之后的项目不再自动弹出。
 *
 * @param storage 默认写当前窗口的 localStorage。
 */
export function writeCollabTourSeen(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  storage?.setItem(COLLAB_TOUR_SEEN_STORAGE_KEY, "1");
}

/** 步骤标识，看板据此决定显示哪几行示例任务。 */
export type CollabTourStepKey = "intro" | "invite" | "associate" | "share" | "continue" | "newTask";

/** 步骤顺序：看板与引导层共用这一份，示例行与高亮不会错位。 */
export const COLLAB_TOUR_STEP_KEYS: CollabTourStepKey[] = ["intro", "invite", "associate", "share", "continue", "newTask"];

/** 契约：协作引导的一步。 */
export interface CollabTourStep {
  key: CollabTourStepKey;
  title: string;
  body: string;
  icon: ReactNode;
  pose: MemmyPose;
  /** 遮罩挖出的主要区域。 */
  highlight: string;
  /** 同时挖出的其他区域，用于给主区域补上下文（如整个头部、整条工具条）。 */
  extras?: string[];
  bubbleSide: "below" | "right";
  bubbleAlign: "start" | "end" | "center";
  /** 带对话或输入框示意的步骤加宽气泡。 */
  wide?: boolean;
  illustration?: "share" | "continue";
  /** 最后一步的主按钮改为「开始使用」。 */
  last?: boolean;
}

/**
 * 六步引导的顺序：先说清这个区域与项目里的任务是什么，再把已有的工作带进来（关联或对话共享），
 * 然后接着说下去，最后给出第一条任务该从哪里新建。
 *
 * @param text 当前语言的取值函数。
 * @returns 步骤定义。
 */
export function createCollabTourSteps(
  text: (key: MessageKey, values?: MessageValues) => string
): CollabTourStep[] {
  return [
    {
      key: "intro",
      title: text("collab.tour.intro.title"),
      body: text("collab.tour.intro.body"),
      icon: <MessagesSquare size={15} aria-hidden="true" />,
      pose: "read",
      highlight: COLLAB_TOUR_ANCHORS.board,
      bubbleSide: "below",
      bubbleAlign: "start"
    },
    {
      key: "invite",
      title: text("collab.tour.invite.title"),
      body: text("collab.tour.invite.body"),
      icon: <UserPlus size={15} aria-hidden="true" />,
      pose: "wave",
      highlight: COLLAB_TOUR_ANCHORS.invite,
      extras: [COLLAB_TOUR_ANCHORS.header],
      bubbleSide: "below",
      bubbleAlign: "end"
    },
    {
      key: "associate",
      title: text("collab.tour.associate.title"),
      body: text("collab.tour.associate.body"),
      icon: <Link2 size={15} aria-hidden="true" />,
      pose: "connect",
      highlight: COLLAB_TOUR_ANCHORS.associate,
      extras: [COLLAB_TOUR_ANCHORS.toolbar],
      bubbleSide: "below",
      bubbleAlign: "end"
    },
    {
      key: "share",
      title: text("collab.tour.share.title"),
      body: text("collab.tour.share.body"),
      icon: <MessagesSquare size={15} aria-hidden="true" />,
      pose: "chat",
      highlight: COLLAB_TOUR_ANCHORS.sampleShared,
      bubbleSide: "below",
      bubbleAlign: "start",
      wide: true,
      illustration: "share"
    },
    {
      key: "continue",
      title: text("collab.tour.continue.title"),
      body: text("collab.tour.continue.body"),
      icon: <MessageSquarePlus size={15} aria-hidden="true" />,
      pose: "point",
      highlight: COLLAB_TOUR_ANCHORS.sampleContinueItem,
      extras: [COLLAB_TOUR_ANCHORS.sampleContinue],
      bubbleSide: "below",
      bubbleAlign: "end",
      wide: true,
      illustration: "continue"
    },
    {
      key: "newTask",
      title: text("collab.tour.newTask.title"),
      body: text("collab.tour.newTask.body"),
      icon: <MessageSquarePlus size={15} aria-hidden="true" />,
      pose: "wave",
      highlight: COLLAB_TOUR_ANCHORS.sidebarNewTask,
      bubbleSide: "right",
      bubbleAlign: "center",
      last: true
    }
  ];
}

/** 当前步骤对应的示例行，供看板决定要不要多显示一行「共享进来的任务」。 */
export function collabTourShowsSharedSample(step: number): boolean {
  const key = COLLAB_TOUR_STEP_KEYS[Math.min(Math.max(step, 0), COLLAB_TOUR_STEP_KEYS.length - 1)];
  return key === "share" || key === "continue" || key === "newTask";
}

interface TourBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TourLayout {
  holes: TourBox[];
  bubble: {
    left: number;
    top: number;
    /** `none`：气泡落在目标内部（目标比视口还高时），不画箭头。 */
    arrow: "top" | "bottom" | "left" | "none";
    /** 箭头在气泡靠近目标那条边上的位置。 */
    arrowOffset: number;
  };
}

const BUBBLE_PADDING = 16;
const BUBBLE_GAP = 14;

function sameLayout(left: TourLayout | null, right: TourLayout): boolean {
  if (!left || left.holes.length !== right.holes.length) return false;
  const sameBox = (a: TourBox, b: TourBox) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
  if (!left.holes.every((hole, index) => sameBox(hole, right.holes[index]!))) return false;
  return left.bubble.left === right.bubble.left
    && left.bubble.top === right.bubble.top
    && left.bubble.arrow === right.bubble.arrow
    && left.bubble.arrowOffset === right.bubble.arrowOffset;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function toBox(rect: ProductTourRect, pad: number): TourBox {
  return {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2
  };
}

/**
 * 气泡放哪：优先贴着目标下方，下方放不下时翻到上方；侧栏那一类目标放在右侧。
 * 与产品引导同一套规则，只是气泡尺寸随内容变化，所以要拿实测宽高来算。
 *
 * 一个特例：目标（看板整体）比视口还高时，上下都放不下。这时气泡贴在看板内的底部，
 * 标题与最上面几行任务都还能看见，只是不再画箭头（它不在目标旁边）。
 */
function resolveBubbleBox(
  anchor: TourBox,
  viewport: ProductTourViewport,
  size: { width: number; height: number },
  side: CollabTourStep["bubbleSide"],
  align: CollabTourStep["bubbleAlign"]
): { left: number; top: number; arrow: "top" | "bottom" | "left" | "none"; arrowOffset: number } {
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  const maxLeft = Math.max(BUBBLE_PADDING, viewport.width - size.width - BUBBLE_PADDING);
  const maxTop = Math.max(BUBBLE_PADDING, viewport.height - size.height - BUBBLE_PADDING);

  if (side === "right") {
    const left = clamp(anchor.left + anchor.width + BUBBLE_GAP, BUBBLE_PADDING, maxLeft);
    const top = clamp(centerY - size.height / 2, BUBBLE_PADDING + 20, maxTop);
    return { left, top, arrow: "left", arrowOffset: clamp(centerY - top - 6, 20, Math.max(20, size.height - 32)) };
  }

  const roomBelow = viewport.height - (anchor.top + anchor.height);
  const roomAbove = anchor.top;
  const tallerThanViewport = anchor.height >= viewport.height - BUBBLE_PADDING * 2;
  if (tallerThanViewport) {
    const left = clamp(align === "end" ? anchor.left + anchor.width - size.width : anchor.left, BUBBLE_PADDING, maxLeft);
    return { left, top: maxTop, arrow: "none", arrowOffset: 0 };
  }
  const placeBelow = roomBelow >= size.height + BUBBLE_GAP + BUBBLE_PADDING || roomBelow >= roomAbove;
  const top = clamp(
    placeBelow ? anchor.top + anchor.height + BUBBLE_GAP : anchor.top - BUBBLE_GAP - size.height,
    BUBBLE_PADDING,
    maxTop
  );
  const rawLeft = align === "end"
    ? anchor.left + anchor.width - size.width
    : align === "center"
      ? centerX - size.width / 2
      : anchor.left;
  const left = clamp(rawLeft, BUBBLE_PADDING, maxLeft);
  return {
    left,
    top,
    arrow: placeBelow ? "top" : "bottom",
    arrowOffset: clamp(centerX - left - 6, 20, Math.max(20, size.width - 32))
  };
}

/**
 * 看板上的引导层。由看板渲染并把当前步骤传进来，这样示例行、展开的菜单与高亮始终对得上。
 */
export function CollabTourOverlay(props: {
  step: number;
  projectName: string;
  onNext: () => void;
  /** 回上一页；第一步没有上一步，按钮不出现。 */
  onBack: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  // 步骤定义每次渲染都会重新构造（图标、文案）：按语言与项目名缓存，下面的 layout effect 才不会被新对象反复触发。
  const steps = useMemo(() => createCollabTourSteps(t), [t]);
  const index = Math.min(Math.max(props.step, 0), steps.length - 1);
  const current = steps[index]!;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: current.wide ? 344 : 288, height: 220 });
  const [layout, setLayout] = useState<TourLayout | null>(null);
  const [nudging, setNudging] = useState(false);

  // 气泡高度随文案与示意变化：量一次，尺寸变了再量，避免按固定高度算位置导致溢出。
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return undefined;
    const measure = () => {
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [index]);

  useLayoutEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    const lookup = createDomProductTourAnchorLookup(document);
    // layout 每次都是新对象：没变化就不写回 state，否则这个 effect 会一路重渲染下去。
    const applyLayout = (next: TourLayout) => {
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };
    const compute = () => {
      const rect = lookup.getAnchorRect(current.highlight);
      const viewport = lookup.getViewport();
      const extras = (current.extras ?? [])
        .map((anchorId) => lookup.getAnchorRect(anchorId))
        .filter((entry): entry is ProductTourRect => entry !== null);
      if (!rect) {
        // 目标还没挂上（例如侧栏被收起）：不挖洞，只把气泡放在中间，点「下一步」仍然能继续。
        applyLayout({
          holes: [],
          bubble: {
            left: clamp(viewport.width / 2 - size.width / 2, BUBBLE_PADDING, Math.max(BUBBLE_PADDING, viewport.width - size.width - BUBBLE_PADDING)),
            top: clamp(viewport.height / 2 - size.height / 2, BUBBLE_PADDING, Math.max(BUBBLE_PADDING, viewport.height - size.height - BUBBLE_PADDING)),
            arrow: "top",
            arrowOffset: size.width / 2
          }
        });
        return;
      }
      const main = toBox(rect, 6);
      applyLayout({
        holes: [main, ...extras.map((entry) => toBox(entry, 4))],
        bubble: resolveBubbleBox(main, viewport, size, current.bubbleSide, current.bubbleAlign)
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [current, size.width, size.height]);

  const handleDismiss = useCallback(() => {
    setNudging(true);
  }, []);

  // Esc 等同「跳过引导」，与产品引导一致。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onSkip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  if (!layout) return null;

  const maskId = `collab-tour-mask-${index}`;
  const arrowClass = layout.bubble.arrow === "top"
    ? styles.arrowTop
    : layout.bubble.arrow === "bottom"
      ? styles.arrowBottom
      : layout.bubble.arrow === "left"
        ? styles.arrowLeft
        : null;
  const arrowStyle: CSSProperties = layout.bubble.arrow === "left"
    ? { top: `${layout.bubble.arrowOffset}px` }
    : { left: `${layout.bubble.arrowOffset}px` };

  return (
    <div className={styles.layer}>
      <svg className={styles.mask} width="100%" height="100%" aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {layout.holes.map((hole, holeIndex) => (
              <rect
                key={holeIndex}
                x={hole.left}
                y={hole.top}
                width={Math.max(0, hole.width)}
                height={Math.max(0, hole.height)}
                rx="12"
                ry="12"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.5)" mask={`url(#${maskId})`} />
      </svg>

      <button
        type="button"
        className={styles.block}
        tabIndex={-1}
        aria-label={t("collab.tour.blockHint")}
        onClick={handleDismiss}
      />

      <div
        key={current.key}
        ref={bubbleRef}
        className={`${styles.bubble} ${current.wide ? styles.bubbleWide : ""} ${nudging ? styles.bubbleNudge : ""}`}
        style={{ left: `${layout.bubble.left}px`, top: `${layout.bubble.top}px` }}
        role="dialog"
        aria-modal="true"
        aria-live="polite"
        aria-label={current.title}
        onAnimationEnd={(event) => {
          if (event.animationName.includes("tourNudge")) setNudging(false);
        }}
      >
        <span className={`${styles.pet} ${current.bubbleAlign === "end" ? styles.petLeft : ""}`} aria-hidden="true">
          <Memmy pose={current.pose} size={56} />
        </span>
        <div className={styles.head}>
          <span className={styles.count}>{index + 1}/{steps.length}</span>
          <span className={styles.headIcon}>{current.icon}</span>
          <span className={styles.title}>{current.title}</span>
        </div>
        <p className={styles.body}>{current.body}</p>
        {current.illustration === "share" ? (
          <div className={styles.chat}>
            <div className={styles.chatHead}>
              <MessagesSquare size={13} aria-hidden="true" />
              {t("collab.tour.share.agent")}
            </div>
            <div className={styles.chatAsk}>{t("collab.tour.share.ask", { project: props.projectName })}</div>
            <div className={styles.chatAnswer}>{t("collab.tour.share.answer", { project: props.projectName })}</div>
          </div>
        ) : null}
        {current.illustration === "continue" ? (
          <div className={styles.compose}>
            <div className={styles.composeBody}>
              <span className={styles.composeChip}>
                <MessagesSquare size={12} aria-hidden="true" />
                {t("collab.tour.continue.chip")}
              </span>
              <span>{t("collab.tour.continue.text")}</span>
              <span className={styles.composeCaret} aria-hidden="true" />
            </div>
            <div className={styles.composeFoot}>{props.projectName}</div>
          </div>
        ) : null}
        <div className={styles.footer}>
          <button type="button" className={styles.skip} onClick={props.onSkip}>{t("collab.tour.skip")}</button>
          <span className={styles.footerButtons}>
            {index > 0 ? (
              <button type="button" className={styles.back} onClick={props.onBack}>{t("collab.tour.back")}</button>
            ) : null}
            <button type="button" className={styles.next} onClick={props.onNext}>
              {current.last ? t("collab.tour.start") : t("collab.tour.next")}
            </button>
          </span>
        </div>
        {arrowClass ? <i className={`${styles.arrow} ${arrowClass}`} style={arrowStyle} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/**
 * 引导期间的示例任务行。引导期间整页都是引导自己的示例页：新建的协作项目里没有任务，
 * 从项目设置重看时也不拿真实任务充数（它们就在下方一屏之外，混在一起分不清哪条是演示）。
 * 两行用来演示「通过对话共享」与「继续任务」，不可点击，结束引导后随组件一起消失。
 */
export function CollabTourTaskList(props: {
  step: number;
  projectName: string;
}) {
  const { t } = useTranslation();
  const key = COLLAB_TOUR_STEP_KEYS[Math.min(Math.max(props.step, 0), COLLAB_TOUR_STEP_KEYS.length - 1)];
  const showShared = collabTourShowsSharedSample(props.step);
  const continueOpen = key === "continue";
  const memberName = t("collab.tour.sample.member.name");
  const you = t("collab.session.you");

  const sampleRow = (options: {
    anchor: string;
    name: string;
    title: string;
    summary: string;
    meta: string;
    menuOpen?: boolean;
  }) => (
    <li
      key={options.anchor}
      className={`${boardStyles.row}${options.menuOpen ? ` ${boardStyles.rowMenuOpen}` : ""}`}
      data-tour-anchor={options.anchor}
    >
      <span
        className={`${boardStyles.avatar} ${boardStyles.avatarSoft}`}
        style={{ "--member": memberColor(options.name) } as CSSProperties}
        aria-hidden="true"
      >
        {Array.from(options.name)[0] ?? "?"}
      </span>
      <div className={boardStyles.rowText}>
        <span className={boardStyles.rowTitle}>{options.title}</span>
        <span className={boardStyles.rowSummary}>{options.summary}</span>
      </div>
      <span className={boardStyles.meta}>{options.meta}</span>
      <button type="button" className={boardStyles.moreButton} tabIndex={-1} aria-hidden="true">
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {options.menuOpen ? (
        <div className={boardStyles.menu} role="presentation">
          <span className={boardStyles.menuItem} data-tour-anchor={COLLAB_TOUR_ANCHORS.sampleContinueItem}>
            {t("collab.session.continue")}
          </span>
          <span className={boardStyles.menuItem}>{t("collab.session.copyLink")}</span>
        </div>
      ) : null}
    </li>
  );

  return (
    <ul className={`${boardStyles.list} ${boardStyles.stream} ${boardStyles.flatStream} ${styles.samples}`} aria-label={t("collab.tour.samplesLabel")}>
      {showShared
        ? sampleRow({
          anchor: COLLAB_TOUR_ANCHORS.sampleShared,
          name: you,
          title: t("collab.tour.sample.mine.title"),
          summary: t("collab.tour.sample.mine.summary"),
          meta: t("collab.tour.sample.mine.meta")
        })
        : null}
      {sampleRow({
        anchor: COLLAB_TOUR_ANCHORS.sampleContinue,
        name: memberName,
        title: t("collab.tour.sample.member.title"),
        summary: t("collab.tour.sample.member.summary"),
        meta: t("collab.tour.sample.member.meta", { name: memberName }),
        menuOpen: continueOpen
      })}
    </ul>
  );
}
