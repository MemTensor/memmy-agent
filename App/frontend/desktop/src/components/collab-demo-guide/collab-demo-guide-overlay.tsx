/**
 * 小饭团演示的蒙版与说明卡。
 *
 * 全程只留一块亮区：亮区里唯一可点的控件带一圈呼吸描边，点亮区以外（以及亮区内除了那个控件的部分）不触发任何操作，
 * 描边与卡片会轻晃一下。亮区按 `data-demo-guide` 锚点定位，业务组件里不写任何坐标；
 * 窗口缩放、滚动、弹窗出现与消失都靠 ResizeObserver 与 rAF 重算。
 *
 * 卡片本身只负责「说明」：顶部一行是序号徽章与步骤名，右上角探出吉祥物，底部左边是「退出引导」、右边是跳过与主按钮。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { Memmy, type MemmyPose } from "../mascot/memmy.js";
import {
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
  rectVisible,
  type Rect,
  type Viewport
} from "./collab-demo-guide-layout.js";
import styles from "./collab-demo-guide.module.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export interface DemoGuideCard {
  /** 体验段是第几步：进度写「1 / 3」。导览段与建项目之前没有进度，为 null。 */
  step: 1 | 2 | 3 | null;
  /** 头部那一行左边的徽章：「1 / 3」或「介绍」。没有徽章时这一行只剩步骤名。 */
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
}

/** 体验段一共几步：进度徽章与心跳都按它算。 */
export const DEMO_GUIDE_STEPS = [1, 2, 3] as const;

/**
 * 每一步探出的姿势：动作与卡上说的是同一件事。
 * 用部分映射而不是全集，导览段与以后新增的阶段没登记时就退回中性的那一张。
 */
const POSES: Partial<Record<DemoGuidePhase, MemmyPose>> = {
  "create-project": "wave",
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

/** 导览段的四步各用哪个姿势：按 {@link demoGuideTourIndex} 的顺序。 */
const TOUR_POSES: MemmyPose[] = ["point", "peek", "connect", "chat"];

/**
 * 每个子状态卡片上写什么：文案就是产品定稿的那几句，`{name}` 换成本次演示成员的昵称。
 *
 * 句子里带了 `{某样东西}` 就要把值传进去：`formatMessage` 不会替你清掉没传的占位符，
 * 曾经就把「{name}的问题」原样印到了卡片上。这里每句都有测试逐个查（见 copy 测试）。
 */
export function demoGuideCard(state: DemoGuideState, t: Translate): DemoGuideCard {
  const name = state.memberName;
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
    ...extra
  });
  // 看板导览：纯介绍，头部是「介绍」徽章，最后一步的按钮是「开始体验」。
  if (demoGuideIsTourPhase(state.phase)) {
    return {
      ...demoGuideTourCard(demoGuideTourIndex(state.phase), t),
      action: demoGuideStartsExperience(state.phase) ? "start" : "next"
    };
  }
  switch (state.phase) {
    case "create-project":
      // 演示成员是谁要等云端建好项目才知道：这时先用中性的叫法，不写死任何账号或昵称。
      return base(null, t("collab.demo.createProject.body", { name: name || t("collab.demo.officialName") }));
    case "joined":
      // 加入提示窗自带遮罩与按钮，不用卡片。
      return base(1, "");
    case "task-row":
      return base(1, t("collab.demo.taskRow.body", { name }));
    case "reader":
      return base(1, t("collab.demo.reader.body"));
    case "compose":
      return base(1, t("collab.demo.compose.body", { name }));
    case "reply-waiting":
      return base(1, "", { status: t("collab.demo.reply.waiting", { name }) });
    case "reply-done":
      return base(1, t("collab.demo.reply.body", { name }), { title: t("collab.demo.reply.title", { name }), action: "next" });
    case "ask-compose":
      return base(2, t("collab.demo.ask.compose"));
    case "ask-waiting":
      return base(2, "", {
        status: state.askDelivered
          ? t("collab.demo.ask.returned", { name })
          : t("collab.demo.ask.sent", { name })
      });
    case "ask-done":
      return base(2, t("collab.demo.ask.body", { name }), { title: t("collab.demo.ask.title"), action: "next" });
    case "settings-open":
      // 这句话里没有要替换的占位符：成员的名字不出现，所以不传值。
      return base(3, t("collab.demo.settings.body"));
    case "settings-assist":
      return base(3, t("collab.demo.assist.body"));
    case "help-waiting":
      return base(3, "", { status: t("collab.demo.help.incoming", { name }) });
    case "help-dialog":
      return base(3, t("collab.demo.dialog.body"));
    case "help-running":
      return base(3, "", { status: t("collab.demo.running", { name }) });
    case "help-done":
      return base(3, t("collab.demo.help.body", { name }), { title: t("collab.demo.help.title", { name }), action: "done" });
    case "help-rejected":
      return base(3, t("collab.demo.rejected.body", { name }), { title: t("collab.demo.rejected.title"), action: "done" });
    case "complete":
    default:
      return base(3, "");
  }
}

/**
 * 导览段的卡片：纯介绍，头部是「介绍」徽章 + 步骤名，没有「跳过这一步」，最后一步的按钮是「开始体验」。
 * 形状由结构那边决定，这里只决定第几步说什么。
 */
export function demoGuideTourCard(index: number, t: Translate): DemoGuideCard {
  const key = String(index + 1) as "1" | "2" | "3" | "4";
  return {
    step: null,
    badge: t("collab.demo.tour.label"),
    stepName: t(("collab.demo.tour.stepName." + key) as MessageKey),
    pose: TOUR_POSES[index] ?? "hum",
    wide: false,
    title: null,
    body: t(("collab.demo.tour.body." + key) as MessageKey),
    status: null,
    action: null
  };
}

/** 哪几个子状态可以跳过这一步：出结果之后的「下一步」不是跳过的地方。 */
export function demoGuideSkippable(phase: DemoGuidePhase): boolean {
  // 建项目之前没有可跳过的内容：不建项目就没有后面的演示；加入提示窗也不是一步。
  if (phase === "create-project" || phase === "joined") return false;
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

export function CollabDemoGuideOverlay(props: {
  state: DemoGuideState;
  onNext: () => void;
  onSkip: () => void;
  onExit: () => void;
  onRetry: () => void;
  onCloseComplete: () => void;
  onInvite: () => void;
  /** 「{name}加入了项目」那个提示窗点了「开始体验」。 */
  onJoined: () => void;
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
  /** 要画亮区与说明卡的阶段：加入提示窗自带遮罩，不是它。 */
  const masking = visible && state.phase !== "joined";

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
    const hole = padRect(regionRect, DEMO_GUIDE_HOLE_PADDING, viewport);
    const strokeElement = target.stroke ? document.querySelector<HTMLElement>(`[data-demo-guide="${target.stroke}"]`) : null;
    const strokeRect = strokeElement ? padRect(strokeElement.getBoundingClientRect(), 3, viewport) : null;
    // 侧滑、缩放这些入场动画期间每帧都在动：位置按 0.5px 取整后比较，浮动误差不算变化。
    const rectKey = (rect: Rect | null) => (rect
      ? [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 2) / 2).join(",")
      : "-");
    const key = `${rectKey(hole)}|${rectKey(strokeRect)}|${viewport.width}x${viewport.height}`;
    return { layout: { hole, stroke: strokeRect, viewport }, key };
  }, [target.region, target.stroke, target.fallback]);

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

  const bump = useCallback(() => setShake((value) => value + 1), []);

  const card = useMemo(() => demoGuideCard(state, t), [state, t]);

  if (state.status === "complete") {
    return (
      <div className={styles.completeLayer} role="dialog" aria-modal="true" aria-label={t("collab.demo.complete.title")}>
        <div className={styles.complete}>
          <h2 className={styles.completeTitle}>{t("collab.demo.complete.title")}</h2>
          <ul className={styles.doneList}>
            {state.done.task ? (
              <li className={styles.doneItem}>
                <Check size={15} className={styles.doneMark} aria-hidden="true" />
                <span>{t("collab.demo.complete.task", { name: state.memberName })}</span>
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
          <p className={styles.principle}>{t("collab.demo.complete.principle")}</p>
          <p className={styles.left}>{t("collab.demo.complete.left", { name: state.memberName })}</p>
          <div className={styles.completeFoot}>
            <button type="button" className={styles.actionGhost} onClick={props.onCloseComplete}>
              {t("collab.demo.complete.finish")}
            </button>
            <button type="button" className={styles.action} onClick={props.onInvite}>
              {t("collab.demo.complete.invite")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!visible) return null;

  // 演示开始：先一张居中的「{name}加入了项目」，点「开始体验」才出现第一步的蒙版。
  if (state.phase === "joined") {
    return (
      <div
        className={styles.joinLayer}
        role="dialog"
        aria-modal="true"
        aria-label={t("collab.demo.joined.title", { name: state.memberName })}
      >
        <div className={styles.joinCard} data-demo-join="">
          <span className={styles.joinPet}>
            <Memmy pose="celebrate" size={84} />
          </span>
          <p className={styles.joinTitle}>{t("collab.demo.joined.title", { name: state.memberName })}</p>
          <p className={styles.joinText}>{t("collab.demo.joined.body")}</p>
          <button type="button" className={styles.joinAction} onClick={props.onJoined}>
            {t("collab.demo.joined.start")}
          </button>
        </div>
      </div>
    );
  }

  if (!layout) {
    // 锚点还没到位或还没量出位置：先只摆一个空的容器，量尺寸用的就是它。
    return <div ref={rootRef} className={styles.root} />;
  }

  const { hole, stroke, viewport } = layout;
  // 窄窗口下卡片收窄到窗口以内，绝不横向溢出。
  const cardWidth = Math.min(card.wide ? DEMO_GUIDE_CARD_WIDTH_WIDE : DEMO_GUIDE_CARD_WIDTH, viewport.width - 24);
  const placement = cardPlacement(hole, viewport, cardHeight, {
    hasStroke: stroke !== null,
    reserveBottom: target.cardBottomReserve ?? 0,
    cardWidth
  });
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
  const primaryLabel = card.action === "next"
    ? t("collab.demo.next")
    : card.action === "start"
      ? t("collab.demo.tour.start")
      : t("collab.demo.done");

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
      {stroke ? (
        <div
          key={`stroke-${state.phase}-${shake}`}
          data-demo-stroke=""
          className={`${styles.stroke}${shake ? ` ${styles.shake}` : ""}`}
          style={{ left: stroke.left, top: stroke.top, width: stroke.width, height: stroke.height }}
          aria-hidden="true"
        />
      ) : null}
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
        <div className={styles.head}>
          {card.badge ? (
            <span className={`${styles.badge}${card.step === null ? ` ${styles.badgeIntro}` : ""}`}>
              {card.badge}
            </span>
          ) : null}
          {card.stepName ? <span className={styles.stepName}>{card.stepName}</span> : null}
        </div>
        {state.error ? (
          <>
            <p className={styles.title}>{t("collab.demo.failed.title")}</p>
            <p className={styles.body}>{state.error}</p>
            <div className={styles.foot}>
              <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>
                {t("collab.demo.exit")}
              </button>
              <span className={styles.footRight}>
                <button type="button" className={styles.quiet} onClick={props.onSkip}>
                  {t("collab.demo.skip")}
                </button>
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
                <p className={styles.confirmText}>
                  {state.phase === "create-project"
                    ? t("collab.demo.exit.bodyBeforeProject")
                    : t("collab.demo.exit.body", { name: state.memberName })}
                </p>
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
              <div className={styles.foot}>
                <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>
                  {t("collab.demo.exit")}
                </button>
                <span className={styles.footRight}>
                  {demoGuideSkippable(state.phase) ? (
                    <button type="button" className={styles.quiet} onClick={props.onSkip}>
                      {t("collab.demo.skip")}
                    </button>
                  ) : null}
                  {card.action ? (
                    <button type="button" className={styles.action} onClick={props.onNext}>
                      {primaryLabel}
                    </button>
                  ) : null}
                </span>
              </div>
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
