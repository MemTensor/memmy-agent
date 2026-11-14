/**
 * 小饭团演示的蒙版与说明卡。
 *
 * 全程只留一块亮区：亮区里唯一可点的控件带一圈呼吸描边，点亮区以外（以及亮区内除了那个控件的部分）不触发任何操作，
 * 描边与卡片会轻晃一下。亮区按 `data-demo-guide` 锚点定位，业务组件里不写任何坐标；
 * 窗口缩放、滚动、弹窗出现与消失都靠 ResizeObserver 与 rAF 重算。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import {
  demoGuideStepNumberOf,
  type DemoGuidePhase,
  type DemoGuideState
} from "../../app/collab-demo-guide-store.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import {
  blockerRects,
  cardPlacement,
  DEMO_GUIDE_CARD_WIDTH,
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
  step: 1 | 2 | 3;
  title: string | null;
  body: string;
  status: string | null;
  action: "next" | "done" | null;
}

/** 每个子状态卡片上写什么：文案就是产品定稿的那几句，`{name}` 换成本次演示成员的昵称。 */
export function demoGuideCard(state: DemoGuideState, t: Translate): DemoGuideCard {
  const name = state.memberName;
  const base = (step: 1 | 2 | 3, body: string, extra: Partial<DemoGuideCard> = {}): DemoGuideCard => ({
    step,
    title: null,
    body,
    status: null,
    action: null,
    ...extra
  });
  switch (state.phase) {
    case "task-row":
      return base(1, t("collab.demo.taskRow.body", { name }));
    case "reader":
      return base(1, t("collab.demo.reader.body"));
    case "compose":
      return base(1, t("collab.demo.compose.body"));
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
      return base(3, t("collab.demo.settings.body"));
    case "settings-assist":
      return base(3, t("collab.demo.assist.body"));
    case "help-waiting":
      return base(3, "", { status: t("collab.demo.help.incoming", { name }) });
    case "help-dialog":
      return base(3, t("collab.demo.dialog.body"));
    case "help-running":
      return base(3, "", { status: t("collab.demo.running") });
    case "help-done":
      return base(3, t("collab.demo.help.body", { name }), { title: t("collab.demo.help.title", { name }), action: "done" });
    case "help-rejected":
      return base(3, t("collab.demo.rejected.body", { name }), { title: t("collab.demo.rejected.title"), action: "done" });
    case "complete":
    default:
      return base(3, "");
  }
}

/** 哪几个子状态可以跳过这一步：出结果之后的「下一步」不是跳过的地方。 */
export function demoGuideSkippable(phase: DemoGuidePhase): boolean {
  return phase !== "reply-done" && phase !== "ask-done" && phase !== "help-done" && phase !== "help-rejected" && phase !== "complete";
}

/**
 * 给自定义的浮层让开遮罩：弹窗自己的背景不再压暗，避免两层暗色叠在一起。
 * 只对引导要用的几个浮层生效。
 */
export const DEMO_GUIDE_YIELD_BACKDROP = "data-demo-guide-yield-backdrop";

export function CollabDemoGuideOverlay(props: {
  state: DemoGuideState;
  onNext: () => void;
  onSkip: () => void;
  onExit: () => void;
  onRetry: () => void;
  onCloseComplete: () => void;
  onInvite: () => void;
}) {
  const { t } = useTranslation();
  const { state } = props;
  const [layout, setLayout] = useState<{ hole: Rect; stroke: Rect | null; viewport: Viewport } | null>(null);
  const [shake, setShake] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [cardHeight, setCardHeight] = useState(150);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const target = demoGuideTarget(state.phase);
  const visible = state.status === "active" && state.phase !== "complete";

  const measure = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setLayout(null);
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const region = document.querySelector<HTMLElement>(`[data-demo-guide="${target.region}"]`);
    if (!region) {
      setLayout(null);
      return;
    }
    const regionRect = region.getBoundingClientRect();
    if (!rectVisible(regionRect, viewport)) {
      setLayout(null);
      return;
    }
    const hole = padRect(regionRect, DEMO_GUIDE_HOLE_PADDING, viewport);
    const strokeElement = target.stroke ? document.querySelector<HTMLElement>(`[data-demo-guide="${target.stroke}"]`) : null;
    const strokeRect = strokeElement ? padRect(strokeElement.getBoundingClientRect(), 3, viewport) : null;
    setLayout({ hole, stroke: strokeRect, viewport });
  }, [target.region, target.stroke]);

  // 亮区跟随窗口缩放、滚动、内容重排：都按帧合并成一次测量。
  useEffect(() => {
    if (!visible) {
      setLayout(null);
      return undefined;
    }
    let frame = 0;
    const schedule = () => {
      if (typeof window === "undefined") return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    observer?.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style", "data-demo-guide"] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(document.body);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      observer?.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.cancelAnimationFrame(frame);
    };
  }, [visible, measure, state.phase]);

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

  if (!visible || !layout) return null;

  const { hole, stroke, viewport } = layout;
  const placement = cardPlacement(hole, viewport, cardHeight);
  // 亮区几乎占满窗口时（对话区就是这种情况）卡片只能压在它上面：这里再夹一次，保证不出窗口。
  const cardTop = Math.max(8, Math.min(placement.top, viewport.height - cardHeight - 8));
  const cardLeft = Math.max(8, Math.min(placement.left, viewport.width - DEMO_GUIDE_CARD_WIDTH - 8));
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

  return (
    <div className={styles.root}>
      {maskRects(hole, viewport).map((rect, index) => (
        <div
          key={`mask-${index}`}
          className={styles.mask}
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
          className={`${styles.stroke}${shake ? ` ${styles.shake}` : ""}`}
          style={{ left: stroke.left, top: stroke.top, width: stroke.width, height: stroke.height }}
          aria-hidden="true"
        />
      ) : null}
      <div
        ref={cardRef}
        key={`card-${state.phase}`}
        className={`${styles.card}${shake ? " " : ""}`}
        data-shake={shake ? "true" : "false"}
        style={{ left: cardLeft, top: cardTop, width: DEMO_GUIDE_CARD_WIDTH }}
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
          <span className={styles.progress} aria-hidden="true">
            {[1, 2, 3].map((step) => (
              <span key={step} className={`${styles.progressBar}${step <= card.step ? ` ${styles.progressBarOn}` : ""}`} />
            ))}
          </span>
          <span className={styles.stepLabel}>
            {t("collab.demo.progress", { step: String(card.step), name: t(("collab.demo.stepName." + String(card.step)) as MessageKey) })}
          </span>
          <span className={styles.grow} />
          <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>
            {t("collab.demo.exit")}
          </button>
        </div>
        {state.error ? (
          <>
            <p className={styles.title}>{t("collab.demo.failed.title")}</p>
            <p className={styles.body}>{state.error}</p>
            <div className={styles.foot}>
              <button type="button" className={styles.quiet} onClick={props.onSkip}>
                {t("collab.demo.skip")}
              </button>
              <button type="button" className={styles.action} onClick={props.onRetry}>
                {t("collab.demo.retry")}
              </button>
            </div>
          </>
        ) : (
          <>
            {card.title ? <p className={styles.title}>{card.title}</p> : null}
            {card.body ? <p className={styles.body}>{card.body}</p> : null}
            {card.status ? <p className={styles.status}>{card.status}</p> : null}
            {confirming ? (
              <div className={styles.confirm}>
                <p className={styles.confirmText}>{t("collab.demo.exit.body", { name: state.memberName })}</p>
                <div className={styles.foot}>
                  <button type="button" className={styles.actionGhost} onClick={() => setConfirming(false)}>
                    {t("collab.demo.exit.continue")}
                  </button>
                  <button type="button" className={styles.action} onClick={props.onExit}>
                    {t("collab.demo.exit.confirm")}
                  </button>
                </div>
              </div>
            ) : card.action ? (
              <div className={styles.foot}>
                <span />
                <button
                  type="button"
                  className={styles.action}
                  onClick={props.onNext}
                >
                  {card.action === "next" ? t("collab.demo.next") : t("collab.demo.done")}
                </button>
              </div>
            ) : demoGuideSkippable(state.phase) ? (
              <div className={styles.foot}>
                <span />
                <button type="button" className={styles.quiet} onClick={props.onSkip}>
                  {t("collab.demo.skip")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** 说明卡上要显示的第几步：预览页与埋点都按它取。 */
export { demoGuideStepNumberOf };
