/**
 * 小饭团演示的蒙版与说明卡。
 *
 * 全程只留一块亮区：暗色由亮区自己投出来（一层 9999px 的投影），亮区里唯一可点的控件再带一圈呼吸描边；
 * 点亮区以外（以及亮区内除了那个控件的部分）不触发任何操作，描边与卡片会轻晃一下。
 * 亮区按 `data-demo-guide` 锚点定位，业务组件里不写任何坐标；窗口缩放、滚动、弹窗出现与消失都靠 ResizeObserver 与 rAF 重算。
 *
 * 卡片本身只负责「说明」：顶部一行是徽章与步骤名（没有就不占这一行），右上角探出吉祥物，
 * 底部左边是「退出引导」、右边是「上一步」与主按钮；「跳过这一步」是次要动作，放在正文下面一行。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { Memmy, type MemmyPose } from "../mascot/memmy.js";
import {
  DEMO_GUIDE_COPY_FALLBACK,
  demoGuideBackTarget,
  demoGuideIsBeforeProjectPhase,
  demoGuideIsTourPhase,
  demoGuideStartsExperience,
  demoGuideStepNumberOf,
  demoGuideTourIndex,
  type DemoGuidePhase,
  type DemoGuideState
} from "../../app/collab-demo-guide-store.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import {
  blockerRects,
  cardPlacement,
  DEMO_GUIDE_CARD_WIDTH,
  DEMO_GUIDE_CARD_WIDTH_WIDE,
  DEMO_GUIDE_HOLE_PADDING,
  demoGuideTarget,
  maskRects,
  padRect,
  rectsIntersect,
  rectVisible,
  type CardPlacement,
  type Rect,
  type Viewport
} from "./collab-demo-guide-layout.js";
import styles from "./collab-demo-guide.module.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export interface DemoGuideCard {
  /** 体验段是第几步：进度写「1 / 3」。导览段与建项目之前没有进度，为 null。 */
  step: 1 | 2 | 3 | null;
  /** 头部那一行左边的徽章：「1 / 3」或「介绍」。没有徽章时这一行只剩步骤名，两者都没有时整行不出现。 */
  badge: string | null;
  /** 头部那一行右边的步骤名。 */
  stepName: string | null;
  /** 探在卡片右上角的吉祥物姿势。 */
  pose: MemmyPose;
  /** 带对话或任务示意的卡片加宽一档。 */
  wide: boolean;
  title: string | null;
  body: string;
  status: string | null;
  action: "next" | "start" | "done" | null;
  /** 这一屏有没有「上一步」：事情已经办成的屏没有，卡片上就不出现那个按钮。 */
  canGoBack: boolean;
  /** 主按钮上的字：默认按 `action` 取「下一步 / 开始协作 / 完成」，只有加入这一屏写「继续」。 */
  actionLabel?: string;
  /**
   * 主按钮暂时不让点（「关联会话」还在扫描）：按钮置灰，点击也不前进。
   *
   * 只禁用、不隐藏：人看得到下一步是什么，只是要等扫描跑完。
   */
  actionDisabled?: boolean;
}

/** 体验段一共几步：进度徽章与心跳都按它算。 */
export const DEMO_GUIDE_STEPS = [1, 2, 3] as const;

/**
 * 每一步探出的姿势：动作与卡上说的是同一件事。
 * 用部分映射而不是全集，导览段与以后新增的阶段没登记时就退回中性的那一张。
 */
const POSES: Partial<Record<DemoGuidePhase, MemmyPose>> = {
  intro: "wave",
  name: "peek",
  folder: "peek",
  collab: "chat",
  "join-entry": "hum",
  "create-project": "hum",
  joined: "celebrate",
  "task-row": "point",
  reader: "read",
  compose: "chat",
  "reply-waiting": "think",
  "reply-done": "celebrate",
  "ask-compose": "chat",
  "ask-waiting": "think",
  "ask-done": "celebrate",
  "settings-open": "wrench",
  "settings-assist": "shield",
  "help-waiting": "peek",
  "help-dialog": "shield",
  "help-running": "work",
  "help-done": "celebrate",
  "help-rejected": "sad"
};

/** 导览段的各步各用哪个姿势：按 {@link demoGuideTourIndex} 的顺序。 */
const TOUR_POSES: MemmyPose[] = ["point", "peek", "connect", "read", "chat"];

/**
 * 每个子状态卡片上写什么：文案就是产品定稿的那几句，`{name}` 换成本次演示成员的昵称。
 *
 * 句子里带了 `{某样东西}` 就要把值传进去：`formatMessage` 不会替你清掉没传的占位符，
 * 曾经就把「{name}的问题」原样印到了卡片上。这里每句都有测试逐个查（见 copy 测试）。
 */
export function demoGuideCard(state: DemoGuideState, t: Translate): DemoGuideCard {
  const name = state.memberName;
  // 剧本内容（任务叫什么、要接着做什么、请对方做什么）一律用云端下发的那几句：
  // 卡片只说「这件事」是项目协作里的哪一步，不自己另讲一套内容。
  // 取不到时退回缺省剧本：卡片宁可说旧内容，也不该整片崩掉。
  const copy = state.copy ?? DEMO_GUIDE_COPY_FALLBACK;
  const base = (step: 1 | 2 | 3 | null, body: string, extra: Partial<DemoGuideCard> = {}): DemoGuideCard => ({
    step,
    badge: step === null
      ? null
      : t("collab.demo.progress", { step: String(step), total: String(DEMO_GUIDE_STEPS.length) }),
    stepName: step === null ? null : t(("collab.demo.stepName." + String(step)) as MessageKey),
    pose: POSES[state.phase] ?? "hum",
    wide: false,
    title: null,
    body,
    status: null,
    action: null,
    // 每一屏自己判断能不能退：事情已经办成的屏（拿到回复、拿到结果、已经开始执行）不给返回。
    canGoBack: demoGuideBackTarget(state) !== null,
    ...extra
  });
  // 看板导览：纯介绍，头部是「介绍」徽章，最后一步的按钮是「开始协作」。
  if (demoGuideIsTourPhase(state.phase)) {
    const tour = demoGuideTourCard(demoGuideTourIndex(state.phase), t);
    const action: DemoGuideCard["action"] = demoGuideStartsExperience(state.phase) ? "start" : "next";
    // 导览里每一站都能退回上一站（第一站除外，由调用方按阶段算）。
    const canGoBack = demoGuideBackTarget(state) !== null;
    // 「关联会话」：弹窗真的在扫本机历史会话，扫完之前不给「下一步」，卡片上一直写清在做什么。
    if (state.phase !== "tour-associate-pick") return { ...tour, action, canGoBack };
    return {
      ...tour,
      action,
      canGoBack,
      actionDisabled: state.scan.status !== "done",
      status: state.scan.status === "done"
        ? (state.scan.count > 0
          ? t("collab.demo.scan.done", { count: String(state.scan.count) })
          : t("collab.demo.scan.empty"))
        : t("collab.demo.scan.scanning")
    };
  }
  switch (state.phase) {
    // 建项目之前的六屏：一路只讲弹窗上的东西；头一行只有出场那一屏带小饭团的徽章与名字。
    case "intro":
      return base(null, t("collab.demo.intro.body"), {
        badge: t("collab.demo.intro.badge"),
        stepName: t("collab.demo.intro.name"),
        action: "next"
      });
    case "name":
      return base(null, t("collab.demo.name.body"), { action: "next" });
    case "folder":
      return base(null, t("collab.demo.folder.body"), { action: "next" });
    case "collab":
      return base(null, t("collab.demo.collab.body"), { action: "next" });
    case "join-entry":
      return base(null, t("collab.demo.joinEntry.body"), { action: "next" });
    case "create-project":
      // 这一屏没有主按钮：要人点的是弹窗里那个真的「创建项目」，不是卡片上的按钮。
      return base(null, t("collab.demo.submit.body"));
    case "joined":
      // 加入那一屏也走普通卡片：亮区套住成员徽章，主按钮是「继续」。
      return base(null, t("collab.demo.joined.body"), {
        action: "next",
        actionLabel: t("collab.demo.joined.continue")
      });
    case "task-row":
      return base(1, t("collab.demo.taskRow.body", { name, task: copy.taskTitle }));
    case "reader":
      return base(1, t("collab.demo.reader.body", { next: copy.taskNext }));
    case "compose":
      return base(1, t("collab.demo.compose.body", { name }));
    case "reply-waiting":
      return base(1, "", { status: t("collab.demo.reply.waiting", { name }) });
    case "reply-done":
      return base(1, t("collab.demo.reply.body", { name, next: copy.taskNext }), { title: t("collab.demo.reply.title"), action: "next" });
    case "ask-compose":
      return base(2, t("collab.demo.ask.compose", { name, ask: copy.askSentence }));
    case "ask-waiting":
      // 请求在云端出现之前不说「已发出」：Agent 还在准备那次调用时，人看到「已发出」会以为对方在跑。
      return base(2, "", {
        status: state.askDelivered
          ? t("collab.demo.ask.returned", { name })
          : state.askSeen
            ? t("collab.demo.ask.sent", { name })
            : t("collab.demo.ask.sending", { name })
      });
    case "ask-done":
      return base(2, t("collab.demo.ask.body", { name }), { title: t("collab.demo.ask.title"), action: "next" });
    case "settings-open":
      // 这句按定稿写死了演示成员的名字，不带占位符：传了值也不会被替换，测试里也钉住了原句。
      return base(3, t("collab.demo.settings.body"));
    case "settings-assist":
      return base(3, t("collab.demo.assist.body"));
    case "help-waiting":
      return base(3, "", { status: t("collab.demo.help.incoming", { name }) });
    case "help-dialog":
      // 授权弹窗这一步：标题写「谁发来的请求」，正文说他要这台电脑做什么。
      return base(3, t("collab.demo.dialog.body", { help: copy.helpSentence }), { title: t("collab.demo.dialog.title") });
    case "help-running":
      return base(3, "", { status: t("collab.demo.running", { name }) });
    case "help-done":
      return base(3, t("collab.demo.help.body", { name, help: copy.helpSentence }), { title: t("collab.demo.help.title"), action: "done" });
    case "help-rejected":
      // 拒绝之后没有标题：定稿这一屏只有一句「你拒绝了这次请求。」和「完成」。
      return base(3, t("collab.demo.rejected.body"), { action: "done" });
    case "complete":
    default:
      return base(3, "");
  }
}

/**
 * 导览段的卡片：纯介绍，头部是「介绍」徽章 + 步骤名，没有「跳过这一步」，最后一步的按钮是「开始协作」。
 * 形状由结构那边决定，这里只决定第几步说什么。
 */
export function demoGuideTourCard(index: number, t: Translate): DemoGuideCard {
  const key = String(index + 1) as "1" | "2" | "3" | "4" | "5";
  return {
    step: null,
    badge: t("collab.demo.tour.label"),
    stepName: t(("collab.demo.tour.stepName." + key) as MessageKey),
    pose: TOUR_POSES[index] ?? "hum",
    wide: false,
    title: null,
    body: t(("collab.demo.tour.body." + key) as MessageKey),
    status: null,
    action: null,
    // 导览第一屏前面只有「已加入」提示窗，没有可退的一屏；由调用方按阶段再算一次。
    canGoBack: false,
    // 导览段没有禁用的时候：只有「关联会话」在扫描期间由调用方改成不可点。
    actionDisabled: false
  };
}

/** 哪几个子状态可以跳过这一步：出结果之后的「下一步」不是跳过的地方。 */
export function demoGuideSkippable(phase: DemoGuidePhase): boolean {
  // 建项目之前没有可跳过的内容：不建项目就没有后面的演示；加入那一屏也不是一步。
  if (demoGuideIsBeforeProjectPhase(phase) || phase === "joined") return false;
  // 看板导览是纯介绍，只留「下一步」与「跳过引导」：没有「跳过这一步」。
  if (demoGuideIsTourPhase(phase)) return false;
  return phase !== "reply-done" && phase !== "ask-done" && phase !== "help-done" && phase !== "help-rejected" && phase !== "complete";
}

/**
 * 给自定义的浮层让开遮罩：弹窗自己的背景不再压暗，避免两层暗色叠在一起。
 * 只对引导要用的几个浮层生效。
 */
export const DEMO_GUIDE_YIELD_BACKDROP = "data-demo-guide-yield-backdrop";

/** 卡片右上角那个吉祥物的大小。 */
const PET_SIZE = 52;

/** 亮区圆角没配置时的那一档（与改造前 CSS 里写死的 12px 一致）。 */
const DEMO_GUIDE_HOLE_RADIUS = 12;

/**
 * 亮区里再点一个控件时，第二圈描边的圆角。
 *
 * `layout` 的 `stroke` 只描述锚点名、不描述圆角，而这两个控件的形状又和它所在的区块不一样：
 * 圆角跟着控件自己的形状走：输入框里的发送按钮是胶囊（`.composer-action-submit` 的 `border-radius: 999px`），
 * 协助开关也是胶囊。所以在这里按阶段直写；其余控件用 {@link INNER_RING_RADIUS_DEFAULT}。
 */
const INNER_RING_RADIUS: Partial<Record<DemoGuidePhase, number>> = {
  compose: 999,
  "ask-compose": 999,
  "settings-assist": 999
};
const INNER_RING_RADIUS_DEFAULT = 999;

/** `prefer` 算位置时用的间距：与 `collab-demo-guide-layout` 候选位置里的同名常量一致。 */
const PREFER_CARD_GAP = 14;
const PREFER_EDGE_MARGIN = 8;
const PREFER_AVOID_MARGIN = 6;

/**
 * 卡片可以收窄到的最小宽度。
 *
 * 340px 的卡片在 1200px 窗口里放不进弹窗左右两侧（各约 314px），于是退到「压在亮区里」，
 * 把正在讲的控件盖住。收窄二十几像素就能贴到旁边，比换位置稳当。
 */
const CARD_MIN_WIDTH = 268;

/**
 * `prefer` 指定的那一边先试。
 *
 * 规格里的 `prefer` 只影响「先试哪一边」，不改变 `cardPlacement` 的候选顺序与算法：
 * 这一边放得下就用它，放不下（或会盖住唯一可点的控件）就退回默认结果。
 */
function preferredPlacement(
  hole: Rect,
  viewport: Viewport,
  cardWidth: number,
  cardHeight: number,
  prefer: "left" | "right" | "top" | "bottom"
): CardPlacement | null {
  const height = cardHeight;
  const clampTop = (top: number) => Math.max(PREFER_EDGE_MARGIN, Math.min(top, viewport.height - height - PREFER_EDGE_MARGIN));
  const clampLeft = (left: number) => Math.max(PREFER_EDGE_MARGIN, Math.min(left, viewport.width - cardWidth - PREFER_EDGE_MARGIN));
  const arrowVertical = (top: number) => Math.max(18, Math.min(hole.top + hole.height / 2 - top - 6, height - 30));
  const arrowHorizontal = (left: number) => Math.max(18, hole.left + hole.width / 2 - left - 6);
  const spaceRight = viewport.width - (hole.left + hole.width) - PREFER_CARD_GAP - PREFER_EDGE_MARGIN;
  const spaceLeft = hole.left - PREFER_CARD_GAP - PREFER_EDGE_MARGIN;
  const spaceBelow = viewport.height - (hole.top + hole.height) - PREFER_CARD_GAP - PREFER_EDGE_MARGIN;
  const spaceAbove = hole.top - PREFER_CARD_GAP - PREFER_EDGE_MARGIN;
  if (prefer === "right") {
    if (spaceRight < cardWidth) return null;
    const top = clampTop(hole.top + hole.height / 2 - height / 2);
    return { left: hole.left + hole.width + PREFER_CARD_GAP, top, arrow: { side: "left", offset: arrowVertical(top) } };
  }
  if (prefer === "left") {
    if (spaceLeft < cardWidth) return null;
    const top = clampTop(hole.top + hole.height / 2 - height / 2);
    return { left: hole.left - PREFER_CARD_GAP - cardWidth, top, arrow: { side: "right", offset: arrowVertical(top) } };
  }
  if (prefer === "bottom") {
    if (spaceBelow < height) return null;
    const left = clampLeft(hole.left + hole.width / 2 - cardWidth / 2);
    return { left, top: hole.top + hole.height + PREFER_CARD_GAP, arrow: { side: "top", offset: arrowHorizontal(left) } };
  }
  if (spaceAbove < height) return null;
  const left = clampLeft(hole.left + hole.width / 2 - cardWidth / 2);
  return { left, top: hole.top - PREFER_CARD_GAP - height, arrow: { side: "bottom", offset: arrowHorizontal(left) } };
}

export function CollabDemoGuideOverlay(props: {
  state: DemoGuideState;
  onNext: () => void;
  /** 退回上一屏：与「下一步」一一对应，退的是刚才那一屏。 */
  onBack: () => void;
  onSkip: () => void;
  onExit: () => void;
  onRetry: () => void;
  onCloseComplete: () => void;
  onInvite: () => void;
  /** `join-entry` 要指的「加入项目」根本不在屏上（API Key 模式下没有这个按钮）：跳过那一屏。 */
  onSkipJoinEntry?: () => void;
}) {
  const { t } = useTranslation();
  const { state } = props;
  const [layout, setLayout] = useState<{ hole: Rect; stroke: Rect | null; viewport: Viewport } | null>(null);
  const [shake, setShake] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [cardHeight, setCardHeight] = useState(150);
  /** 窗口缩放、滚动、动画结束都会让它加一：测量随之一并重跑。 */
  const [measureTick, setMeasureTick] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** 蒙版自己铺满整个窗口：视口尺寸量它，而不是问 window——两处在截图与内嵌环境里可能不一致。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const target = demoGuideTarget(state.phase);
  const visible = state.status === "active" && state.phase !== "complete";
  /** 要画亮区与说明卡的阶段：加入项目那一屏也走蒙版，收尾弹窗自己带底。 */
  const masking = visible && state.phase !== "complete";

  /** 量一次亮区与描边，`key` 用来判断位置有没有变。 */
  const measure = useCallback((): { layout: { hole: Rect; stroke: Rect | null; viewport: Viewport } | null; key: string } => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return { layout: null, key: "none" };
    }
    const rootRect = rootRef.current?.getBoundingClientRect() ?? null;
    const viewport = rootRect && rootRect.width > 0 && rootRect.height > 0
      ? { width: rootRect.width, height: rootRect.height }
      : { width: window.innerWidth, height: window.innerHeight };
    const region = document.querySelector<HTMLElement>(`[data-demo-guide="${target.region}"]`)
      // 主锚点不在这一页（比如人在看板上，而执行中的协助条在任务页）时改用在的那一个。
      ?? (target.fallback ? document.querySelector<HTMLElement>(`[data-demo-guide="${target.fallback}"]`) : null);
    if (!region) return { layout: null, key: "none" };
    const regionRect = region.getBoundingClientRect();
    if (!rectVisible(regionRect, viewport)) return { layout: null, key: "none" };
    // 亮区默认外扩 6px；某些阶段（弹窗整体、创建按钮）按规格另外给了 pad。
    const hole = padRect(regionRect, target.padding ?? DEMO_GUIDE_HOLE_PADDING, viewport);
    const strokeElement = target.stroke ? document.querySelector<HTMLElement>(`[data-demo-guide="${target.stroke}"]`) : null;
    const strokeRect = strokeElement ? padRect(strokeElement.getBoundingClientRect(), 3, viewport) : null;
    // 侧滑、缩放这些入场动画期间每帧都在动：位置按 0.5px 取整后比较，浮动误差不算变化。
    const rectKey = (rect: Rect | null) => (rect
      ? [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 2) / 2).join(",")
      : "-");
    const key = `${rectKey(hole)}|${rectKey(strokeRect)}|${viewport.width}x${viewport.height}`;
    return { layout: { hole, stroke: strokeRect, viewport }, key };
  }, [target.region, target.stroke, target.fallback, target.padding]);

  /**
   * 跟着目标走：侧滑、缩放、居中补高这些入场过程里每帧位置都不一样，只量一次必然画偏。
   * 所以只要引导在屏上就每帧量一次，位置变了才重画；窗口缩放、滚动、内容重排、动画结束都因此自动跟上，
   * 元素晚一步出现也一样，下一帧就画出来。
   */
  useEffect(() => {
    if (!masking) {
      setLayout(null);
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    let frame = 0;
    let appliedKey: string | null = null;
    const step = () => {
      const next = measure();
      if (next.key !== appliedKey) {
        appliedKey = next.key;
        setLayout(next.layout);
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [masking, measure, state.phase, measureTick]);

  // 滚动与窗口缩放本身也被每帧的测量覆盖；留着这几个监听是让「该重新量了」这件事有个明确出处，
  // 将来若把测量改成按需触发，它们就是触发点。
  useEffect(() => {
    if (!masking) return undefined;
    const bump = () => setMeasureTick((tick) => tick + 1);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(bump);
    observer?.observe(document.documentElement);
    document.addEventListener("animationend", bump, true);
    document.addEventListener("transitionend", bump, true);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("animationend", bump, true);
      document.removeEventListener("transitionend", bump, true);
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [masking]);

  // 换步骤时卡片高度会变：量一次，避免它压到亮区或出窗口。
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0 && Math.abs(height - cardHeight) > 1) setCardHeight(height);
  }, [cardHeight, state.phase, state.error, state.askDelivered, confirming]);

  // 换步骤时把确认块收起来，别让「退出引导？」跟着进入下一步。
  useEffect(() => {
    setConfirming(false);
  }, [state.phase]);

  /** `join-entry` 已经报过一次跳过：同一个阶段只报一次，不跟着重画再发一遍事件。 */
  const joinEntryReportedRef = useRef<DemoGuidePhase | null>(null);
  useEffect(() => {
    if (state.status !== "active" || state.phase !== "join-entry") {
      joinEntryReportedRef.current = null;
      return;
    }
    if (joinEntryReportedRef.current === "join-entry") return;
    if (typeof document === "undefined") return;
    joinEntryReportedRef.current = "join-entry";
    // 锚点在创建弹窗里，而那一屏已经开着好几步了：这时还找不到，就是根本没渲染（比如 API Key 模式下没有「加入项目」）。
    // 不能把气泡指向一个不存在的元素卡住，直接跳过这一屏。
    if (!document.querySelector('[data-demo-guide="create-join"]')) props.onSkipJoinEntry?.();
  }, [state.status, state.phase, props.onSkipJoinEntry]);

  const bump = useCallback(() => setShake((value) => value + 1), []);

  const card = useMemo(() => demoGuideCard(state, t), [state, t]);
  // 完成弹窗也讲剧本里做过的那件事：与卡片用同一份文案，取不到时同样退回缺省。
  const copy = state.copy ?? DEMO_GUIDE_COPY_FALLBACK;

  if (state.status === "complete") {
    return (
      <div className={styles.completeLayer} role="dialog" aria-modal="true" aria-label={t("collab.demo.complete.title")}>
        <div className={styles.complete}>
          <h2 className={styles.completeTitle}>{t("collab.demo.complete.title")}</h2>
          <ul className={styles.doneList}>
            {state.done.task ? (
              <li className={styles.doneItem}>
                <Check size={15} className={styles.doneMark} aria-hidden="true" />
                <span>{t("collab.demo.complete.task", { name: state.memberName, next: copy.taskNext })}</span>
              </li>
            ) : null}
            {state.done.ask ? (
              <li className={styles.doneItem}>
                <Check size={15} className={styles.doneMark} aria-hidden="true" />
                <span>{t("collab.demo.complete.ask", { name: state.memberName })}</span>
              </li>
            ) : null}
            {state.done.help ? (
              <li className={styles.doneItem}>
                <Check size={15} className={styles.doneMark} aria-hidden="true" />
                <span>{t("collab.demo.complete.help", { name: state.memberName })}</span>
              </li>
            ) : null}
          </ul>
          <p className={styles.left}>{t("collab.demo.complete.left")}</p>
          <div className={styles.completeFoot}>
            <button type="button" className={styles.actionGhost} onClick={props.onInvite}>
              {t("collab.demo.complete.invite")}
            </button>
            <button type="button" className={styles.action} onClick={props.onCloseComplete}>
              {t("collab.demo.complete.finish")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!visible) return null;

  if (!layout) {
    // 锚点还没到位或还没量出位置：先只摆一个空的容器，量尺寸用的就是它。
    return <div ref={rootRef} className={styles.root} />;
  }

  const { hole, stroke, viewport } = layout;
  // 窄窗口下卡片收窄到窗口以内，绝不横向溢出。
  const fullCardWidth = Math.min(card.wide ? DEMO_GUIDE_CARD_WIDTH_WIDE : DEMO_GUIDE_CARD_WIDTH, viewport.width - 24);
  // 亮区左右两侧各剩多少：放得下整张卡片时按原宽度，放不下但收窄后能放下就用收窄的宽度。
  // 只在「两侧都放不下整张卡片」时才收窄：本来就能贴上边的阶段保持原宽度，画面不抖。
  const spaceBeside = Math.max(
    viewport.width - (hole.left + hole.width) - PREFER_CARD_GAP - PREFER_EDGE_MARGIN,
    hole.left - PREFER_CARD_GAP - PREFER_EDGE_MARGIN
  );
  const cardWidth = fullCardWidth > spaceBeside && spaceBeside >= CARD_MIN_WIDTH
    ? Math.floor(spaceBeside)
    : fullCardWidth;
  // 第二圈描边只在「控件比亮区小、它在亮区里」时才画：亮区与控件是同一个锚点的阶段（体验第一步、建项目前的六屏）
  // 外面已经有一圈，再套一圈就成了两条并排的圆角线。
  const innerRing = stroke && target.stroke !== target.region ? stroke : null;
  // 规格里每个阶段的 `prefer` 只调整「先试哪一边」：那一边放得下、又不压住唯一可点的控件才用。
  const preferred = target.prefer
    ? preferredPlacement(hole, viewport, cardWidth, cardHeight, target.prefer)
    : null;
  const preferredFits = preferred !== null
    && (!stroke || !rectsIntersect(
      { left: preferred.left, top: preferred.top, width: cardWidth, height: cardHeight },
      padRect(stroke, PREFER_AVOID_MARGIN)
    ));
  const placement = preferredFits && preferred
    ? preferred
    : cardPlacement(hole, viewport, cardHeight, {
      hasStroke: stroke !== null,
      reserveBottom: target.cardBottomReserve ?? 0,
      cardWidth,
      // 唯一可点的那个控件绝不能被说明卡盖住（授权弹窗里就是「允许」）。
      avoid: stroke
    });
  // 亮区的圆角按阶段配，没配时用默认那一档。
  const holeRadius = target.radius ?? DEMO_GUIDE_HOLE_RADIUS;
  const innerRadius = INNER_RING_RADIUS[state.phase] ?? INNER_RING_RADIUS_DEFAULT;
  // 描边那一圈的意思是「这里可以点」：出场那屏（`clean`）与没有可点控件的阶段（看板导览、加入、等结果）只压暗。
  const quietRing = target.clean === true || target.stroke === null;
  // 亮区几乎占满窗口时（对话区就是这种情况）卡片只能压在它上面：这里再夹一次，保证不出窗口。
  const cardTop = Math.max(8, Math.min(placement.top, viewport.height - cardHeight - 8));
  const cardLeft = Math.max(8, Math.min(placement.left, viewport.width - cardWidth - 8));
  const blockers = blockerRects(hole, stroke, target.blockRest);
  // 箭头贴住朝向亮区的那条边：左右两条边用 top 定位，上下两条边用 left 定位。
  const vertical = placement.arrow.side === "left" || placement.arrow.side === "right";
  const arrowStyle: CSSProperties = vertical
    ? {
      top: `${placement.arrow.offset}px`,
      [placement.arrow.side]: "-6px"
    }
    : {
      left: `${placement.arrow.offset}px`,
      [placement.arrow.side]: "-6px"
    };
  // 吉祥物探在卡片右上角；卡片在亮区左边（箭头在右侧）时翻到左上，不压住正在指的那个控件。
  const petLeft = placement.arrow.side === "right" ? cardLeft + 2 : cardLeft + cardWidth - PET_SIZE + 4;
  // 探出卡片上沿约一半（与记忆管理那套引导同一个比例），压住的部分落在卡片自己的白底上。
  const petTop = Math.max(0, cardTop - 30);
  const primaryLabel = card.actionLabel ?? (card.action === "next"
    ? t("collab.demo.next")
    : card.action === "start"
      ? t("collab.demo.tour.start")
      : t("collab.demo.done"));

  return (
    <div ref={rootRef} className={styles.root}>
      {maskRects(hole, viewport).map((rect, index) => (
        <div
          key={`mask-${index}`}
          className={styles.mask}
          data-demo-mask=""
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          onClick={bump}
          aria-hidden="true"
        />
      ))}
      {blockers.map((rect, index) => (
        <div
          key={`blocker-${index}`}
          className={styles.blocker}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          onClick={bump}
          aria-hidden="true"
        />
      ))}
      {innerRing ? (
        <div
          key={`stroke2-${state.phase}-${shake}`}
          data-demo-stroke2=""
          className={`${styles.stroke2}${shake ? ` ${styles.shake}` : ""}`}
          style={{
            left: innerRing.left,
            top: innerRing.top,
            width: innerRing.width,
            height: innerRing.height,
            borderRadius: `${innerRadius}px`
          }}
          aria-hidden="true"
        />
      ) : null}
      <div
        key={`stroke-${state.phase}-${shake}`}
        data-demo-stroke=""
        className={`${styles.stroke}${quietRing ? ` ${styles.quiet}` : ""}${shake ? ` ${styles.shake}` : ""}`}
        style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height, borderRadius: `${holeRadius}px` }}
        aria-hidden="true"
      />
      <div
        ref={cardRef}
        key={`card-${state.phase}`}
        className={styles.card}
        data-shake={shake ? "true" : "false"}
        style={{
          left: cardLeft,
          top: cardTop,
          width: cardWidth,
          maxHeight: Math.max(120, viewport.height - 16),
          overflowY: "auto"
        }}
        role="dialog"
        aria-modal="false"
        aria-label={t("collab.demo.cardLabel")}
      >
        <span
          className={styles.arrow}
          style={{ ...arrowStyle, transform: "rotate(45deg)" }}
          aria-hidden="true"
        />
        {card.badge || card.stepName ? (
          <div className={styles.head}>
            {card.badge ? (
              <span className={`${styles.badge}${card.step === null ? ` ${styles.badgeIntro}` : ""}`}>
                {card.badge}
              </span>
            ) : null}
            {card.stepName ? <span className={styles.stepName}>{card.stepName}</span> : null}
          </div>
        ) : null}
        {state.error ? (
          <>
            <p className={styles.title}>{t("collab.demo.failed.title")}</p>
            <p className={styles.body}>{state.error}</p>
            {demoGuideSkippable(state.phase) ? (
              <p className={styles.aside}>
                <button type="button" className={styles.quiet} onClick={props.onSkip}>
                  {t("collab.demo.skip")}
                </button>
              </p>
            ) : null}
            <div className={styles.foot}>
              <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>
                {t("collab.demo.exit")}
              </button>
              <span className={styles.footRight}>
                {/* 出错时也给一条退路：退回上一屏改一下，比只在原地重试更顶用。 */}
                {card.canGoBack ? (
                  <button type="button" className={styles.actionGhost} onClick={props.onBack}>
                    {t("collab.demo.back")}
                  </button>
                ) : null}
                <button type="button" className={styles.action} onClick={props.onRetry}>
                  {t("collab.demo.retry")}
                </button>
              </span>
            </div>
          </>
        ) : (
          <>
            {card.title ? <p className={styles.title}>{card.title}</p> : null}
            {card.body ? <p className={styles.body}>{card.body}</p> : null}
            {card.status ? <p className={styles.status}>{card.status}</p> : null}
            {confirming ? (
              <div className={styles.confirm}>
                {demoGuideIsBeforeProjectPhase(state.phase) ? (
                  // 建项目之前没有成员，也没有人离开：退出时项目根本不会创建，这一屏只一句问话。
                  <p className={styles.confirmText}>{t("collab.demo.exit.bodyBeforeProject")}</p>
                ) : (
                  <>
                    <p className={styles.confirmTitle}>{t("collab.demo.exit.title")}</p>
                    <p className={styles.confirmText}>{t("collab.demo.exit.body")}</p>
                  </>
                )}
                <div className={styles.foot}>
                  <span className={styles.grow} />
                  <button type="button" className={styles.actionGhost} onClick={() => setConfirming(false)}>
                    {t("collab.demo.exit.continue")}
                  </button>
                  <button type="button" className={styles.action} onClick={props.onExit}>
                    {t("collab.demo.exit.confirm")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* 「跳过这一步」是次要动作：放在正文下面一行小字，底部那一行只留「退出 / 上一步 / 下一步」。
                    三个按钮在 268px 的最窄卡片上放不下，跳过又本来不是主操作，就不占底部的位置。 */}
                {demoGuideSkippable(state.phase) ? (
                  <p className={styles.aside}>
                    <button type="button" className={styles.quiet} onClick={props.onSkip}>
                      {t("collab.demo.skip")}
                    </button>
                  </p>
                ) : null}
                <div className={styles.foot}>
                  <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>
                    {t("collab.demo.exit")}
                  </button>
                  <span className={styles.footRight}>
                    {card.canGoBack ? (
                      <button type="button" className={styles.actionGhost} onClick={props.onBack}>
                        {t("collab.demo.back")}
                      </button>
                    ) : null}
                    {card.action ? (
                      <button
                        type="button"
                        className={styles.action}
                        onClick={props.onNext}
                        disabled={card.actionDisabled === true}
                      >
                        {primaryLabel}
                      </button>
                    ) : null}
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </div>
      <span className={styles.pet} style={{ left: petLeft, top: petTop }} aria-hidden="true">
        <Memmy pose={card.pose} size={PET_SIZE} />
      </span>
    </div>
  );
}

/** 说明卡上要显示的第几步：预览页与埋点都按它取。 */
export { demoGuideStepNumberOf };
